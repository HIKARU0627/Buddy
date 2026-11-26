// 家計簿の記録の Core の手順（ADR 0158）。
//
// - recordHouseholdEntry: 記録を 1 件作る。出所の鍵（domain の householdSourceKeyMaterial の SHA-256）で同じメール・同じ書き出しの
//   行から二つ目を作らない。分類が「未分類」で店名があれば、店名から覚えた分類の規則を当てる（向きが合うときだけ）。
//   内容は記録を所有者にして暗号化し、DB worker の household.record へ渡す。
// - readHouseholdMonths: 月の範囲の記録を読み、復号して返す。月ごとの集計（domain の summarizeHouseholdMonth）も付ける。
//   復号できない記録は数だけ返し、集計に入れない（壊れた記録を黙って 0 円として扱わない）。
// - changeHouseholdCategory: 本人が分類を変える。内容版を照合して差し替え、店名があれば本人の規則として覚える。
// - changeHouseholdContent: 本人が中身（金額・日付・時刻・店名・メモ・支払い手段・分類）を直す（ADR 0169）。向きは変えられない。
// - deleteHouseholdEntry: 本人が記録を消す。行は残り、同じ出所から作り直さない（保存層）。
// 店名の HMAC の鍵はデータ鍵から作る（自宅の登録値と同じ作り方。店名の平文を DB に置かない）。
// 承認・実行経路・effect_kind は関わらない（家計の記録は Buddy 自身の記録で、外部を変えない）。

import { createHmac } from 'node:crypto';
import {
  householdCategory,
  householdContentErrors,
  householdMonthOf,
  householdMonthSpan,
  householdRuleApplies,
  householdRuleLearnable,
  householdSourceKeyMaterial,
  normalizeHouseholdMerchant,
  summarizeHouseholdMonth,
} from '@buddy/domain';
import type {
  HouseholdEntryContent,
  HouseholdMonthSummary,
  HouseholdSourceKind,
  HouseholdSourceParts,
} from '@buddy/domain';
import { openHouseholdContent, sealHouseholdContent } from '@buddy/storage';
import type {
  DataKeyMaterial,
  DbWorkerClient,
  HouseholdEntryRecord,
} from '@buddy/storage';

const MERCHANT_KEY_CONTEXT = 'buddy.household.merchant.v1';
const KEY_ID = /^[\x21-\x7e]{1,128}$/u;

/** 店名の HMAC の鍵。データ鍵と key_id から作り、文字列にしない。 */
export class HouseholdMerchantKey {
  readonly #key: Buffer;

  private constructor(key: Buffer) {
    this.#key = key;
  }

  // HMAC-SHA256(データ鍵, 文脈 + NUL + key_id)。
  static fromDataKey(dataKey: DataKeyMaterial): HouseholdMerchantKey {
    const { keyId, key } = dataKey;
    if (typeof keyId !== 'string' || !KEY_ID.test(keyId))
      throw new TypeError('household_key_id_invalid');
    if (!(key instanceof Uint8Array) || key.length !== 32)
      throw new TypeError('household_data_key_invalid');
    return new HouseholdMerchantKey(
      createHmac('sha256', key)
        .update(`${MERCHANT_KEY_CONTEXT}\0${keyId}`, 'utf8')
        .digest(),
    );
  }

  /** 正規化した店名の HMAC の小文字の 16 進。正規化して空なら null。 */
  merchant(merchant: string): string | null {
    const normalized = normalizeHouseholdMerchant(merchant);
    if (normalized === null) return null;
    return createHmac('sha256', this.#key)
      .update(`merchant\0${normalized}`, 'utf8')
      .digest('hex');
  }

  toJSON(): string {
    return '[redacted]';
  }
}

export interface HouseholdPorts {
  readonly client: Pick<DbWorkerClient, 'household'>;
  // データ鍵（Core が鍵の保管庫から取ったもの）。記録をこの鍵で暗号化・復号する。
  readonly dataKey: DataKeyMaterial;
  // SHA-256 の 16 進（node:crypto）。
  readonly sha256Hex: (material: string) => string;
  // 新しい ID（記録・封筒。UUID）。
  readonly newId: () => string;
  // いまの UTC 時刻。
  readonly now: () => string;
}

type Failure = {
  readonly outcome: 'rejected' | 'unknown';
  readonly reasons: readonly string[];
};

// --- 記録 ---

export type RecordedHouseholdEntry =
  | {
      readonly outcome: 'created';
      readonly entry_id: string;
      // 店名の規則で分類を決めたか。
      readonly rule_applied: boolean;
    }
  | {
      readonly outcome: 'duplicate';
      readonly entry_id: string;
      readonly state: 'active' | 'deleted';
    }
  | Failure;

const sourceKindOf = (parts: HouseholdSourceParts): HouseholdSourceKind =>
  parts.kind;

export async function recordHouseholdEntry(
  ports: HouseholdPorts,
  source: HouseholdSourceParts,
  content: HouseholdEntryContent,
): Promise<RecordedHouseholdEntry> {
  const material = householdSourceKeyMaterial(source);
  if (material === null)
    return { outcome: 'rejected', reasons: ['source_invalid'] };
  const errors = householdContentErrors(content);
  if (errors.length > 0) return { outcome: 'rejected', reasons: errors };
  const month = householdMonthOf(content.occurred_on);
  if (month === null)
    return { outcome: 'rejected', reasons: ['occurred_on_invalid'] };
  let final = content;
  let ruleApplied = false;
  if (content.category === 'uncategorized' && content.merchant !== null) {
    const merchantKey = HouseholdMerchantKey.fromDataKey(
      ports.dataKey,
    ).merchant(content.merchant);
    if (merchantKey !== null) {
      const rule = await ports.client.household({
        kind: 'household.rule_get',
        merchant_key: merchantKey,
      });
      if (!rule.ok) return { outcome: rule.outcome, reasons: rule.reasons };
      if (
        rule.value !== null &&
        householdRuleApplies(content.direction, rule.value.category)
      ) {
        final = { ...content, category: rule.value.category };
        ruleApplied = true;
      }
    }
  }
  const entryId = ports.newId();
  const sealed = sealHouseholdContent(
    ports.dataKey,
    entryId,
    1,
    final,
    ports.newId(),
  );
  if (!sealed.ok) return { outcome: 'rejected', reasons: [sealed.reason] };
  const result = await ports.client.household({
    kind: 'household.record',
    entry_id: entryId,
    source_kind: sourceKindOf(source),
    source_key: ports.sha256Hex(material),
    month,
    content: sealed.content,
    now: ports.now(),
  });
  if (!result.ok) return { outcome: result.outcome, reasons: result.reasons };
  if (result.value.outcome === 'duplicate')
    return {
      outcome: 'duplicate',
      entry_id: result.value.entry_id,
      state: result.value.state,
    };
  return {
    outcome: 'created',
    entry_id: result.value.entry_id,
    rule_applied: ruleApplied,
  };
}

// --- 読み取りと集計 ---

export interface HouseholdEntryView {
  readonly entry_id: string;
  readonly source_kind: HouseholdSourceKind;
  readonly content_revision: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly content: HouseholdEntryContent;
}

export interface HouseholdMonthView {
  readonly month: string;
  // 新しい日付・新しい時刻の順（同じなら作成の新しい順）。
  readonly entries: readonly HouseholdEntryView[];
  readonly summary: HouseholdMonthSummary;
  // 復号できなかった記録の数（集計に入れていない）。
  readonly unreadable: number;
}

export type HouseholdMonthsRead =
  | {
      readonly outcome: 'ok';
      // 新しい月から。記録のない月も 0 の集計で入れる。
      readonly months: readonly HouseholdMonthView[];
      // 上限で古い記録を切ったか。
      readonly truncated: boolean;
    }
  | Failure;

function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const end = Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7));
  while (year * 12 + month <= end) {
    months.push(`${String(year)}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months.reverse();
}

// 内容版（10 進の文字列、16 桁まで）を数にする。安全な整数に収まらなければ null（精度が落ちて誤った版で暗号化・復号しない）。
export function householdRevisionNumber(revision: string): number | null {
  const value = Number(revision);
  return Number.isSafeInteger(value) ? value : null;
}

// 次の内容版。今の版も次の版も安全な整数に収まるときだけ返す。
export function nextHouseholdRevision(revision: string): number | null {
  const value = householdRevisionNumber(revision);
  if (value === null) return null;
  const next = value + 1;
  return Number.isSafeInteger(next) ? next : null;
}

function openRecord(
  dataKey: DataKeyMaterial,
  record: HouseholdEntryRecord,
): HouseholdEntryContent | null {
  if (record.content === null) return null;
  const revision = householdRevisionNumber(record.content_revision);
  if (revision === null) return null;
  const opened = openHouseholdContent(dataKey, record.entry_id, revision, {
    formatVersion: record.content.format_version,
    keyId: record.content.key_id,
    nonce: record.content.nonce,
    ciphertext: record.content.ciphertext,
    tag: record.content.tag,
  });
  if (!opened.ok) return null;
  // 月の列と中身の日付が食い違う記録は読めないものとして扱う（集計の月をずらさない）。
  if (householdMonthOf(opened.content.occurred_on) !== record.month)
    return null;
  return opened.content;
}

const sortKey = (view: HouseholdEntryView): string =>
  `${view.content.occurred_on}T${view.content.occurred_time ?? '99:99'}|${view.created_at}`;

export async function readHouseholdMonths(
  ports: Pick<HouseholdPorts, 'client' | 'dataKey'>,
  monthFrom: string,
  monthTo: string,
): Promise<HouseholdMonthsRead> {
  if (householdMonthSpan(monthFrom, monthTo) === null)
    return { outcome: 'rejected', reasons: ['month_range_invalid'] };
  const listed = await ports.client.household({
    kind: 'household.list',
    month_from: monthFrom,
    month_to: monthTo,
  });
  if (!listed.ok) return { outcome: listed.outcome, reasons: listed.reasons };
  const byMonth = new Map<
    string,
    { entries: HouseholdEntryView[]; unreadable: number }
  >(
    monthsBetween(monthFrom, monthTo).map((month) => [
      month,
      { entries: [], unreadable: 0 },
    ]),
  );
  // 保存済みの内容版が安全な整数に収まらない記録があれば、誤った版で復号しないよう読み取り全体を失敗にする。
  if (
    listed.value.entries.some(
      (record) =>
        record.content !== null &&
        householdRevisionNumber(record.content_revision) === null,
    )
  )
    return { outcome: 'rejected', reasons: ['content_revision_unsafe'] };
  for (const record of listed.value.entries) {
    const bucket =
      record.month === null ? undefined : byMonth.get(record.month);
    if (bucket === undefined) continue;
    const content = openRecord(ports.dataKey, record);
    if (content === null) {
      bucket.unreadable += 1;
      continue;
    }
    bucket.entries.push({
      entry_id: record.entry_id,
      source_kind: record.source_kind,
      content_revision: record.content_revision,
      created_at: record.created_at,
      updated_at: record.updated_at,
      content,
    });
  }
  const months = [...byMonth.entries()].map(([month, bucket]) => {
    const entries = [...bucket.entries].sort((a, b) =>
      sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : 0,
    );
    return {
      month,
      entries,
      summary: summarizeHouseholdMonth(entries.map((entry) => entry.content)),
      unreadable: bucket.unreadable,
    };
  });
  return { outcome: 'ok', months, truncated: listed.value.truncated };
}

// --- 本人の変更 ---

export type HouseholdChange =
  | {
      readonly outcome: 'changed';
      readonly entry_id: string;
      readonly content_revision: string;
      // 店名の規則を覚えたか（店名がない記録は覚えない）。
      readonly rule_learned: boolean;
    }
  | Failure;

async function readActive(
  ports: Pick<HouseholdPorts, 'client' | 'dataKey'>,
  entryId: string,
  expectedRevision: string,
): Promise<
  | { readonly ok: true; readonly content: HouseholdEntryContent }
  | ({ readonly ok: false } & Failure)
> {
  const got = await ports.client.household({
    kind: 'household.get',
    entry_id: entryId,
  });
  if (!got.ok) return { ok: false, outcome: got.outcome, reasons: got.reasons };
  if (got.value === null)
    return { ok: false, outcome: 'rejected', reasons: ['entry_missing'] };
  if (got.value.state !== 'active')
    return { ok: false, outcome: 'rejected', reasons: ['entry_deleted'] };
  if (got.value.content_revision !== expectedRevision)
    return { ok: false, outcome: 'rejected', reasons: ['revision_mismatch'] };
  const content = openRecord(ports.dataKey, got.value);
  if (content === null)
    return { ok: false, outcome: 'rejected', reasons: ['content_unreadable'] };
  return { ok: true, content };
}

export async function changeHouseholdCategory(
  ports: HouseholdPorts,
  entryId: string,
  expectedRevision: string,
  category: string,
): Promise<HouseholdChange> {
  const target = householdCategory(category);
  if (target === null)
    return { outcome: 'rejected', reasons: ['category_invalid'] };
  const next = nextHouseholdRevision(expectedRevision);
  if (next === null)
    return { outcome: 'rejected', reasons: ['expected_revision_invalid'] };
  const current = await readActive(ports, entryId, expectedRevision);
  if (!current.ok)
    return { outcome: current.outcome, reasons: current.reasons };
  if (target.direction !== current.content.direction)
    return { outcome: 'rejected', reasons: ['category_direction_mismatch'] };
  const content = { ...current.content, category };
  const sealed = sealHouseholdContent(
    ports.dataKey,
    entryId,
    next,
    content,
    ports.newId(),
  );
  if (!sealed.ok) return { outcome: 'rejected', reasons: [sealed.reason] };
  const month = householdMonthOf(content.occurred_on);
  if (month === null)
    return { outcome: 'rejected', reasons: ['occurred_on_invalid'] };
  const now = ports.now();
  const updated = await ports.client.household({
    kind: 'household.update',
    entry_id: entryId,
    expected_revision: expectedRevision,
    month,
    content: sealed.content,
    now,
  });
  if (!updated.ok)
    return { outcome: updated.outcome, reasons: updated.reasons };
  // 支出の記録に店名があれば本人の規則として覚える（次から同じ店の利用に当てる。収入・振替は覚えない。ADR 0175）。
  // 支出を未分類へ直したときも書く（覚えた分類を未分類で上書きし、次から自動では分類しない。ADR 0158 からの動き）。
  // 覚えられなくても分類の変更は済んでいる。
  let learned = false;
  if (
    content.merchant !== null &&
    (householdRuleLearnable(content.direction, category) ||
      (content.direction === 'expense' && category === 'uncategorized'))
  ) {
    const merchantKey = HouseholdMerchantKey.fromDataKey(
      ports.dataKey,
    ).merchant(content.merchant);
    if (merchantKey !== null) {
      const rule = await ports.client.household({
        kind: 'household.rule_set',
        merchant_key: merchantKey,
        category,
        origin: 'user',
        now,
      });
      learned = rule.ok && rule.value.written;
    }
  }
  return {
    outcome: 'changed',
    entry_id: entryId,
    content_revision: updated.value.content_revision,
    rule_learned: learned,
  };
}

// 本人が記録の中身（金額・日付・時刻・店名・メモ・支払い手段・分類）を直す（ADR 0169）。今の中身を開いて向きが同じことを
// 確かめ、新しい内容版で暗号化して差し替える。向きは変えられない（向きが違えば 422 にする。向きを変えたいときは削除して
// 足し直す）。支出の記録で店名があり分類が未分類でなければ、本人の規則として覚える（分類の変更と同じ。収入・振替は覚えない。ADR 0175）。
export async function changeHouseholdContent(
  ports: HouseholdPorts,
  entryId: string,
  expectedRevision: string,
  next: HouseholdEntryContent,
): Promise<HouseholdChange> {
  const errors = householdContentErrors(next);
  if (errors.length > 0) return { outcome: 'rejected', reasons: errors };
  const nextRevision = nextHouseholdRevision(expectedRevision);
  if (nextRevision === null)
    return { outcome: 'rejected', reasons: ['expected_revision_invalid'] };
  const current = await readActive(ports, entryId, expectedRevision);
  if (!current.ok)
    return { outcome: current.outcome, reasons: current.reasons };
  if (next.direction !== current.content.direction)
    return { outcome: 'rejected', reasons: ['direction_mismatch'] };
  const month = householdMonthOf(next.occurred_on);
  if (month === null)
    return { outcome: 'rejected', reasons: ['occurred_on_invalid'] };
  const sealed = sealHouseholdContent(
    ports.dataKey,
    entryId,
    nextRevision,
    next,
    ports.newId(),
  );
  if (!sealed.ok) return { outcome: 'rejected', reasons: [sealed.reason] };
  const now = ports.now();
  const updated = await ports.client.household({
    kind: 'household.update',
    entry_id: entryId,
    expected_revision: expectedRevision,
    month,
    content: sealed.content,
    now,
  });
  if (!updated.ok)
    return { outcome: updated.outcome, reasons: updated.reasons };
  // 覚えられなくても中身の変更は済んでいる。
  let learned = false;
  if (
    next.merchant !== null &&
    householdRuleLearnable(next.direction, next.category)
  ) {
    const merchantKey = HouseholdMerchantKey.fromDataKey(
      ports.dataKey,
    ).merchant(next.merchant);
    if (merchantKey !== null) {
      const rule = await ports.client.household({
        kind: 'household.rule_set',
        merchant_key: merchantKey,
        category: next.category,
        origin: 'user',
        now,
      });
      learned = rule.ok && rule.value.written;
    }
  }
  return {
    outcome: 'changed',
    entry_id: entryId,
    content_revision: updated.value.content_revision,
    rule_learned: learned,
  };
}

export type HouseholdDeletion =
  { readonly outcome: 'deleted'; readonly entry_id: string } | Failure;

export async function deleteHouseholdEntry(
  ports: Pick<HouseholdPorts, 'client' | 'now'>,
  entryId: string,
  expectedRevision: string,
): Promise<HouseholdDeletion> {
  const deleted = await ports.client.household({
    kind: 'household.delete',
    entry_id: entryId,
    expected_revision: expectedRevision,
    now: ports.now(),
  });
  if (!deleted.ok)
    return { outcome: deleted.outcome, reasons: deleted.reasons };
  return { outcome: 'deleted', entry_id: entryId };
}
