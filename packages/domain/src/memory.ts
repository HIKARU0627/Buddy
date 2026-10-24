// 記憶の保存・忘却・期限の規則（設計 03 忘却と再取り込み・保存期限・バックアップ、08 §6、11 §7、ADR 0008）。
// 時刻は UTC の RFC 3339 文字列で受ける。台帳・記憶の行は Core が DB から読んで渡す。

const DAY_MS = 86_400_000;
export const MEMORY_REVIEW_DAYS = 90;
export const MEMORY_DELETE_AFTER_REVIEW_DAYS = 30;
export const MEMORY_EXTRACTION_MIN_EXCHANGES = 4;

export interface MemorySource {
  readonly source_kind: 'turn' | 'source_item' | 'memory';
  readonly source_id: string;
}

// 忘却台帳の由来の参照（contracts の LedgerSourceRef と同じ形。ADR 0040）。
// 発言・別の記憶は Buddy 内の ID、元情報（source_item）は元サービスの ID の生の値ではなく HMAC だけを持つ。
export type LedgerSource =
  | {
      readonly source_kind: 'turn' | 'memory';
      readonly source_id: string;
    }
  | {
      readonly source_kind: 'source_item';
      readonly source_id_hmac: string;
    };

// 由来 1 件の台帳用 HMAC（64 桁の小文字 16 進）を返す関数。鍵は domain が持たず、Core が注入する（ADR 0040）。
// 入力は種類と ID で、用途の名前を含む HMAC の入力の組み立ては Core 側。
export type SourceHmac = (source: MemorySource) => string;

// 忘却台帳の 1 件の判定に使う部分（contracts の ForgetLedgerEntry。blocked_source_hmacs は B06-03 で
// 旧い blocked_source_ids から改名した。生の元情報の ID は持たない）。
export interface ForgetEntry {
  readonly forgetting_generation: string;
  readonly forgotten: readonly LedgerSource[];
  readonly blocked_source_hmacs: readonly string[];
  readonly blocked_content_keys: readonly string[];
}

export interface MemoryCandidateInput {
  readonly origin: 'auto_extraction' | 'explicit_request';
  readonly kind: string;
  readonly target_key: string;
  readonly sources: readonly MemorySource[];
  readonly dedupe_key: string;
  readonly forgetting_generation: string;
  readonly permission_revision: string;
}

export interface StoredMemory {
  readonly memory_id: string;
  readonly kind: string;
  readonly target_key: string;
  readonly dedupe_key: string;
  readonly status: 'active' | 'review_pending' | 'deleted';
}

export interface MemoryAdmissionContext {
  readonly privateConversation: boolean;
  readonly allowedKinds: readonly string[];
  readonly currentForgettingGeneration: string;
  readonly currentPermissionRevision: string;
  // 処理開始時の世代以降を含む、Core が保持する台帳の全件。
  readonly ledger: readonly ForgetEntry[];
  // 台帳の HMAC と比べるために、由来を同じ HMAC へ通す関数（Core が鍵を持つ。ADR 0040）。
  readonly sourceHmac: SourceHmac;
  readonly expiredSourceIds: readonly string[];
  readonly existing: readonly StoredMemory[];
}

export interface MemoryAdmission {
  readonly action: 'save' | 'review' | 'duplicate' | 'reject';
  readonly reasons: string[];
  readonly conflictingMemoryIds: string[];
}

// 由来が台帳の忘却と関係するかの判定に使う入力。memoryAdmission と、一般の遅着の検査（late-result.ts）で共有する。
export interface LedgerRelationInput {
  readonly sources: readonly MemorySource[];
  // 処理開始時の忘却世代と、今の世代。
  readonly startedGeneration: string;
  readonly currentGeneration: string;
  readonly ledger: readonly ForgetEntry[];
  readonly sourceHmac: SourceHmac;
  // 自動抽出の候補の内容の HMAC。null なら内容の禁止は見ない（明示の保存・表示・送信）。
  readonly contentKey: string | null;
}

const HMAC_HEX = /^[0-9a-f]{64}$/u;

// 台帳用 HMAC（64 桁の小文字 16 進）の形か。
export const isHmacHex = (value: unknown): value is string =>
  typeof value === 'string' && HMAC_HEX.test(value);

// 台帳が由来の元の種類と ID（または HMAC）に一致するか。
function ledgerForgets(
  entry: ForgetEntry,
  source: MemorySource,
  hmac: string,
): boolean {
  return entry.forgotten.some((item) =>
    item.source_kind === 'source_item'
      ? source.source_kind === 'source_item' && item.source_id_hmac === hmac
      : item.source_kind === source.source_kind &&
        item.source_id === source.source_id,
  );
}

// 台帳との関係で結果を通せない理由（ADR 0040 の「忘却の関連の判定」の表）。
// 世代の新旧ではなく、由来が忘却と関係するかで決める。世代が同じでも、忘れた由来から作った結果は通さない。
// 無関係な忘却で世代が進んだだけでは破棄しない。開始の後の世代が台帳に揃っていなければ判定できないので破棄する。
export function ledgerRelationReasons(input: LedgerRelationInput): string[] {
  const reasons: string[] = [];
  const base = BigInt(input.startedGeneration);
  const current = BigInt(input.currentGeneration);
  if (base > current) reasons.push('generation_ahead');
  // 開始後の世代が台帳に揃っていなければ、忘却済みかを判定できない（03 復元）。
  const known = new Set(
    input.ledger.map((entry) => BigInt(entry.forgetting_generation)),
  );
  for (let generation = base + 1n; generation <= current; generation += 1n)
    if (!known.has(generation)) {
      reasons.push('forget_ledger_gap');
      break;
    }
  // 注入された関数の戻り値が HMAC の形（64 桁の小文字 16 進）でなければ、台帳と照合できない。
  // 「一致しない」と読んで通すと忘れた由来を見逃すので、結果を通さない（閉じた側）。
  const hmacs = input.sources.map((source) => input.sourceHmac(source));
  if (hmacs.some((value) => !isHmacHex(value)))
    reasons.push('source_hmac_malformed');
  else if (
    input.ledger.some((entry) =>
      input.sources.some(
        (source, index) =>
          ledgerForgets(entry, source, hmacs[index] as string) ||
          entry.blocked_source_hmacs.includes(hmacs[index] as string),
      ),
    )
  )
    reasons.push('source_forgotten');
  // 同じ内容の自動記憶化を黙って再開しない。本人の新しい明示依頼は別に扱う（ADR 0008）。
  const contentKey = input.contentKey;
  if (
    contentKey !== null &&
    input.ledger.some((entry) =>
      entry.blocked_content_keys.includes(contentKey),
    )
  )
    reasons.push('content_forgotten');
  return reasons;
}

// 保存直前の検査（08 §6）。遅れて返った結果も、忘却・許可・期限を現在値で見直す。
// 忘却した由来・派生からの再保存は、台帳の世代の新旧によらず拒否する。
export function memoryAdmission(
  candidate: MemoryCandidateInput,
  context: MemoryAdmissionContext,
): MemoryAdmission {
  const reasons: string[] = [];
  if (context.privateConversation) reasons.push('private_conversation');
  if (!context.allowedKinds.includes(candidate.kind))
    reasons.push('kind_not_allowed');
  if (candidate.permission_revision !== context.currentPermissionRevision)
    reasons.push('permission_changed');
  reasons.push(
    ...ledgerRelationReasons({
      sources: candidate.sources,
      startedGeneration: candidate.forgetting_generation,
      currentGeneration: context.currentForgettingGeneration,
      ledger: context.ledger,
      sourceHmac: context.sourceHmac,
      contentKey:
        candidate.origin === 'auto_extraction' ? candidate.dedupe_key : null,
    }),
  );
  if (
    candidate.sources.some((source) =>
      context.expiredSourceIds.includes(source.source_id),
    )
  )
    reasons.push('source_expired');
  if (reasons.length > 0)
    return { action: 'reject', reasons, conflictingMemoryIds: [] };
  const live = context.existing.filter((memory) => memory.status !== 'deleted');
  if (live.some((memory) => memory.dedupe_key === candidate.dedupe_key))
    return { action: 'duplicate', reasons: [], conflictingMemoryIds: [] };
  // 同じ種類・同じ対象キーで内容が違えば、両方を見直し待ちにする（J15、11 §7）。
  const conflicting = live
    .filter(
      (memory) =>
        memory.kind === candidate.kind &&
        memory.target_key === candidate.target_key,
    )
    .map((memory) => memory.memory_id);
  return conflicting.length > 0
    ? { action: 'review', reasons: [], conflictingMemoryIds: conflicting }
    : { action: 'save', reasons: [], conflictingMemoryIds: [] };
}

const plusDays = (time: string, days: number): string =>
  new Date(Date.parse(time) + days * DAY_MS)
    .toISOString()
    .replace('.000Z', 'Z');

// 新しい記憶の見直し日。別の記憶から作った記憶は、由来の見直し日より後にしない（再要約で延ばさない）。
export function initialReviewAt(
  createdAt: string,
  sourceMemoryReviewAts: readonly string[],
): string {
  const candidates = [
    plusDays(createdAt, MEMORY_REVIEW_DAYS),
    ...sourceMemoryReviewAts,
  ];
  return candidates.reduce((earliest, time) =>
    Date.parse(time) < Date.parse(earliest) ? time : earliest,
  );
}

export interface MemorySchedule {
  readonly status: 'active' | 'review_pending' | 'deleted';
  readonly review_at: string;
  readonly delete_at: string | null;
}

export type MemoryEvent =
  | 'used'
  | 'resummarized'
  | 'duplicate_extracted'
  | 'review_due'
  | 'explicit_continue'
  | 'delete_due';

// 期限の更新。利用・再要約・重複の再抽出では期限を変えない。
// 明示継続は見直し待ちの記憶だけで、継続した時点から次の 90 日（ADR 0008）。
export function applyMemoryEvent(
  memory: MemorySchedule,
  event: MemoryEvent,
  now: string,
): { readonly memory: MemorySchedule; readonly rejected: string | null } {
  const reject = (reason: string) => ({ memory, rejected: reason });
  if (
    event === 'used' ||
    event === 'resummarized' ||
    event === 'duplicate_extracted'
  )
    return { memory, rejected: null };
  if (event === 'review_due') {
    if (memory.status !== 'active') return reject('not_active');
    if (Date.parse(now) < Date.parse(memory.review_at))
      return reject('not_due');
    return {
      memory: {
        status: 'review_pending',
        review_at: memory.review_at,
        delete_at: plusDays(memory.review_at, MEMORY_DELETE_AFTER_REVIEW_DAYS),
      },
      rejected: null,
    };
  }
  if (event === 'explicit_continue') {
    if (memory.status !== 'review_pending') return reject('not_review_pending');
    return {
      memory: {
        status: 'active',
        review_at: plusDays(now, MEMORY_REVIEW_DAYS),
        delete_at: null,
      },
      rejected: null,
    };
  }
  if (memory.status !== 'review_pending' || memory.delete_at === null)
    return reject('not_review_pending');
  if (Date.parse(now) < Date.parse(memory.delete_at)) return reject('not_due');
  return {
    memory: { ...memory, status: 'deleted' },
    rejected: null,
  };
}

// 期限のある行（発言・記憶）を自動で使えるか。時計が巻き戻ったら、期限内でも整合するまで使わない（03 保存期限）。
export function expiryUsableReasons(
  expiresAt: string | null,
  now: string,
  lastCheckedAt: string,
): string[] {
  const reasons: string[] = [];
  if (expiresAt !== null && Date.parse(now) >= Date.parse(expiresAt))
    reasons.push('expired');
  if (Date.parse(now) < Date.parse(lastCheckedAt))
    reasons.push('clock_regression');
  return reasons;
}

// 自動提案の根拠にできる記憶か。見直し待ち・削除済み・見直し日を過ぎた記憶は使わない。
export function memoryUsableReasons(
  memory: MemorySchedule,
  now: string,
  lastCheckedAt: string,
): string[] {
  const reasons: string[] = [];
  if (memory.status !== 'active') reasons.push(memory.status);
  for (const reason of expiryUsableReasons(
    memory.review_at,
    now,
    lastCheckedAt,
  ))
    reasons.push(reason === 'expired' ? 'review_due' : reason);
  return reasons;
}

export interface ExtractionTrigger {
  readonly trigger: 'conversation_end' | 'idle_30min' | 'none';
  readonly privateConversation: boolean;
  readonly userExchanges: number;
  // memory_save で処理した往復。終了時の抽出から除く（X44）。
  readonly explicitSaveExchanges: number;
}

// 会話の終了時・30 分の無発言時の記憶抽出を行うか（11 §7）。
export function shouldExtractMemories(input: ExtractionTrigger): boolean {
  return (
    input.trigger !== 'none' &&
    !input.privateConversation &&
    input.userExchanges - input.explicitSaveExchanges >=
      MEMORY_EXTRACTION_MIN_EXCHANGES
  );
}

export interface LedgerCopy {
  readonly holder: string;
  readonly forgetting_generation: string;
  readonly complete: boolean;
}

// 復元で記憶・会話を戻せるか（03 バックアップ・復元）。最新の台帳を確認できなければ、非機密の設定だけを戻す。
export function restoreReasons(input: {
  readonly backupForgettingGeneration: string;
  readonly latestKnownGeneration: string | null;
  readonly copies: readonly LedgerCopy[];
}): { readonly restoreMemories: boolean; readonly reasons: string[] } {
  const reasons: string[] = [];
  if (input.latestKnownGeneration === null)
    reasons.push('latest_ledger_unconfirmed');
  else {
    const latest = BigInt(input.latestKnownGeneration);
    const usable = input.copies.filter(
      (copy) => copy.complete && BigInt(copy.forgetting_generation) >= latest,
    );
    if (usable.length === 0) reasons.push('latest_ledger_missing');
    if (BigInt(input.backupForgettingGeneration) > latest)
      reasons.push('backup_newer_than_ledger');
  }
  return { restoreMemories: reasons.length === 0, reasons };
}
