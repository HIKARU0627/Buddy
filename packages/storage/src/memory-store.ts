// 記憶と忘却の DB worker の命令（設計 03 忘却と再取り込み・保存期限、08 §6、11 §7、ADR 0008・0040・0044・0054、
// マイグレーション 0012）。
//
// - forget.*: 忘却の系譜の読み出し・忘却の適用（forget-store.ts）・台帳の書き出し（台帳の別ファイルを作る材料）。
// - memory.save: 記憶の保存。保存の直前に、transaction の中で台帳の全件と照合する（遅れて届いた結果の最後の保証。
//   domain の ledgerRelationReasons と同じ規則）。由来の HMAC は Core が鍵で求めて渡す。
// - memory.continue: 見直し待ちの記憶の明示継続（継続した時点から次の 90 日。ADR 0008 U14）。
// - memory.start_review: 見直し日を過ぎた記憶を見直し待ちへ（見直しから 30 日で削除）。
// - memory.delete_due: 見直し待ちのまま 30 日を過ぎた記憶の物理削除（期限切れ。台帳には書かない）。
// - directive.revoke: 本人の指示（「今後は」など）の取り消し。行と暗号文を消す。
// - memory.settings_get・memory.settings_set: 保存してよい記憶の種類の設定（マイグレーション 0024、ADR 0191）。行がなければ
//   6 種類とも保存しない・版 0。版は本人の変更ごとに 1 進み、違う版からの変更は settings_revision_conflict。
// - memory.admission_facts: 保存の前の検査（domain の memoryAdmission）に使う、設定・台帳・今ある記憶の HMAC を同じ時点で読む。
// memory.save（と、発言と同じ transaction の保存 saveMemoryInTransaction）は、同じ transaction で設定を読み、種類が許可に
// なければ kind_not_allowed、処理を始めた時点の版と今の版が違えば permission_changed で保存しない（最後の保証）。
// 書込みは 1 命令を 1 つの短い BEGIN IMMEDIATE の transaction で行う。時刻は呼び出し側の now を信じる（DB は時計を
// 持たない。期限の命令は B06-06d1 の sweepPlan の時計の判定を通してから呼ぶ）。結果には ID・件数だけを入れる。

import Database from 'better-sqlite3';
import {
  MEMORY_DELETE_AFTER_REVIEW_DAYS,
  MEMORY_REVIEW_DAYS,
  RETENTION_RULES,
  ledgerRelationReasons,
} from '@buddy/domain';
import type {
  ForgetEntry,
  ForgetGraph,
  ForgetPlan,
  MemorySource,
} from '@buddy/domain';
import { writeConnectionReasons } from './connection.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import { isSealedBlob } from './operation-commands.js';
import type { SealedBlobInput } from './operation-commands.js';
import { runImmediate } from './operation-store.js';
import {
  ForgetRejection,
  applyForget,
  currentForgettingGeneration,
  exportForgetLedger,
  forgetTargetExists,
  isHex64,
  isUuid,
  lineageHasLiveDownstream,
  lineageSources,
  pruneDeadLineage,
  readForgetSubgraph,
  readLedgerChain,
  readLedgerEntries,
  readLedgerId,
} from './forget-store.js';
import { buildLedgerFile, parseLedgerFile } from './forget-ledger-file.js';
import { readBackupFacts } from './backup-facts.js';
import type { BackupFacts } from './backup-facts.js';
import type {
  ForgetApplyValue,
  ForgetLedgerExport,
  SourceHmacValue,
} from './forget-store.js';

const DAY_MS = 86_400_000;
// 元情報の本文の保存期限（取得から 24 時間。domain の RETENTION_RULES の source_body）。
const SOURCE_BODY_MS = RETENTION_RULES['source_body']?.ms ?? 0;
const MEMORY_KINDS = [
  'preference',
  'goal',
  'person',
  'routine',
  'lexicon',
  'progress',
] as const;
// 記憶の種類（契約の MemoryKind。保存してよい種類の設定の列の順）。
export const MEMORY_KIND_NAMES: readonly MemoryKindName[] = MEMORY_KINDS;
export type MemoryKindName = (typeof MEMORY_KINDS)[number];
// 保存してよい記憶の種類の設定（ADR 0191）。allowed_kinds は MEMORY_KIND_NAMES の順。行がなければ空・版 '0'。
export interface MemorySettingsValue {
  readonly allowed_kinds: readonly MemoryKindName[];
  readonly settings_revision: string;
}
// 保存の前の検査の材料（同じ読み取りの transaction で読む）。existing の target_key は対象キーの HMAC（target_key_hash）。
export interface MemoryAdmissionFacts {
  readonly settings: MemorySettingsValue;
  readonly forgetting_generation: string;
  readonly ledger: readonly ForgetEntry[];
  readonly existing: readonly {
    readonly memory_id: string;
    readonly kind: MemoryKindName;
    readonly target_key: string;
    readonly dedupe_key: string;
    readonly status: 'active' | 'review_pending';
  }[];
}
const SOURCE_KINDS = ['turn', 'source_item', 'memory'] as const;
// 元情報の ID の形の最低限（契約の OriginalSourceId）。
const ORIGINAL_SOURCE_ID = /^[A-Za-z0-9._:=+~-]{1,256}$/u;

export type MemoryOp =
  // 忘却の対象の系譜（domain の ForgetGraph）と、今の台帳の世代・対象があるか。
  | {
      readonly kind: 'forget.graph';
      readonly target: MemorySource;
      // 「〇〇を忘れて」の発言（計画に渡すものと同じ値。閉包の起点に入るので、省くと計画が古いと判定される）。
      readonly instruction_turn_id?: string | null;
    }
  // 忘却の適用（台帳・削除・送出禁止の印を 1 つの transaction で）。
  | {
      readonly kind: 'forget.apply';
      readonly target: MemorySource;
      readonly instruction_turn_id: string | null;
      readonly plan: ForgetPlan;
      readonly source_hmacs: readonly SourceHmacValue[];
      readonly entry_id: string;
      readonly previous_generation: string;
      readonly new_ledger_id: string;
      readonly now: number;
    }
  // 台帳の全件（連鎖の hash つき）。台帳の別ファイルを書く・遅着の検査に使う。
  | { readonly kind: 'forget.ledger_export' }
  // 0012 より前の台帳の行があり、系譜（ledger_id）がない DB に系譜を付ける（U119）。台帳のファイルがないことを Core が
  // 確かめてから呼ぶ。旧い行が台帳のファイルの形で書き出せなければ付けない。
  | { readonly kind: 'forget.adopt_ledger_id'; readonly ledger_id: string }
  // バックアップの封筒に書く DB の事実（台帳の系譜・head・鍵の ID・暗号文の鍵の ID。ADR 0055）。
  | { readonly kind: 'backup.facts' }
  // バックアップの設定の記録（ADR 0055）。台帳の系譜がまだなく台帳が空なら系譜を付け、台帳の HMAC の鍵の ID を記録する
  // （同じ系譜の中では鍵の ID を変えない）。
  | {
      readonly kind: 'backup.record_setup';
      readonly ledger_id: string;
      readonly ledger_hmac_key_id: string;
    }
  | {
      readonly kind: 'memory.save';
      readonly memory_id: string;
      readonly origin: 'auto_extraction' | 'explicit_request';
      readonly memory_kind: (typeof MEMORY_KINDS)[number];
      readonly text: SealedBlobInput;
      readonly target_key: SealedBlobInput;
      readonly target_key_hash: string;
      // 内容の HMAC（memories.dedupe_key。台帳の blocked_content_keys と比べる）。
      readonly dedupe_key: string;
      readonly sources: readonly MemorySource[];
      // すべての由来の台帳用 HMAC（台帳の blocked_source_hmacs・元情報の forgotten と比べる。欠ければ照合できないので拒否）。
      readonly source_hmacs: readonly SourceHmacValue[];
      // 保存の判定を始めたときの台帳の世代。
      readonly forgetting_generation: string;
      // 保存の判定を始めたときの、保存してよい記憶の種類の設定の版（ADR 0191）。今の版と違えば保存しない。
      readonly settings_revision: string;
      readonly now: number;
    }
  | {
      readonly kind: 'memory.continue';
      readonly memory_id: string;
      readonly now: number;
    }
  | {
      readonly kind: 'memory.start_review';
      readonly memory_id: string;
      readonly now: number;
    }
  | {
      readonly kind: 'memory.delete_due';
      readonly memory_id: string;
      readonly now: number;
    }
  | { readonly kind: 'directive.revoke'; readonly directive_id: string }
  // 記憶の一覧（UI-10 の忘却の画面、ADR 0183）。保存中・見直し待ちの記憶を保存の新しい順に最大 limit 件。削除済みと、削除の
  // 期限（now 以上）を過ぎた記憶は出さない。本文は封筒のまま返し、Core がデータ鍵で開く。由来は種類ごとの件数だけ。
  | {
      readonly kind: 'memory.list';
      readonly limit: number;
      readonly now: number;
    }
  // 保存してよい記憶の種類の設定（ADR 0191）。
  | { readonly kind: 'memory.settings_get' }
  // 本人の画面操作の設定の変更。expected_revision が今の版と違えば settings_revision_conflict。同じ値でも版は進む。
  | {
      readonly kind: 'memory.settings_set';
      readonly expected_revision: string;
      readonly allowed_kinds: readonly MemoryKindName[];
      readonly now: number;
    }
  // 保存の前の検査の材料（設定・台帳の世代と全件・今ある記憶の種類と HMAC）。
  | { readonly kind: 'memory.admission_facts' };

export type MemoryOpKind = MemoryOp['kind'];

export interface ForgetGraphValue {
  readonly graph: ForgetGraph;
  readonly forgetting_generation: string;
  readonly target_exists: boolean;
  readonly ledger_id: string | null;
  // 系譜にある本人の指示の本文の封筒（U433、ADR 0185）。系譜と同じ transaction で読む（計画に出す「消える指示」の本文を、
  // 計画と同じ時点の値にする）。ID の順。Core は計画で消える指示の封筒だけをデータ鍵で開く。
  readonly directives: readonly ForgetDirectiveRow[];
}

// 系譜にある本人の指示の 1 行。text は封筒（owner = user_directives・directive_id・版 0・用途 directive_text）。
// 封筒が見つからなければ null（Core は「読めない指示」として計画に出す）。
export interface ForgetDirectiveRow {
  readonly directive_id: string;
  readonly scope: 'this_time' | 'from_now_on';
  readonly text: MemoryBlobOutput | null;
}

export interface MemoryScheduleValue {
  readonly memory_id: string;
  readonly status: 'active' | 'review_pending';
  readonly review_at: number;
  readonly delete_at: number | null;
}

// 本文の封筒（sealed_blobs の 1 行）。記憶の本文は Core が owner = memories・memory_id・版 0・用途 memory_text で、本人の指示の
// 本文は owner = user_directives・directive_id・版 0・用途 directive_text で開く。
export interface MemoryBlobOutput {
  readonly blob_id: string;
  readonly format_version: number;
  readonly key_id: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly tag: Uint8Array;
}

// 記憶の一覧の 1 行。時刻は UTC の Unix ミリ秒。本文の封筒が見つからなければ text は null（Core は一覧全体を 503 にする）。
export interface MemoryListRow {
  readonly memory_id: string;
  readonly origin: 'auto_extraction' | 'explicit_request';
  readonly kind: (typeof MEMORY_KINDS)[number];
  readonly status: 'active' | 'review_pending';
  readonly created_at: number;
  readonly review_at: number;
  readonly delete_at: number | null;
  readonly text: MemoryBlobOutput | null;
  readonly source_counts: {
    readonly turn: number;
    readonly source_item: number;
    readonly memory: number;
  };
}

export interface MemoryOpValues {
  'forget.graph': ForgetGraphValue;
  'forget.apply': ForgetApplyValue;
  'forget.ledger_export': ForgetLedgerExport;
  'forget.adopt_ledger_id': {
    readonly ledger_id: string;
    readonly forgetting_generation: string;
  };
  'backup.facts': BackupFacts;
  'backup.record_setup': {
    readonly ledger_id: string;
    readonly ledger_hmac_key_id: string;
    readonly forgetting_generation: string;
  };
  'memory.save': MemoryScheduleValue;
  'memory.continue': MemoryScheduleValue;
  'memory.start_review': MemoryScheduleValue;
  'memory.delete_due': {
    readonly memory_id: string;
    readonly deleted: boolean;
  };
  'directive.revoke': {
    readonly directive_id: string;
    readonly revoked: boolean;
  };
  'memory.list': {
    readonly rows: readonly MemoryListRow[];
    // 上限で切った（ほかにも出せる記憶がある）か。
    readonly truncated: boolean;
  };
  'memory.settings_get': MemorySettingsValue;
  'memory.settings_set': MemorySettingsValue;
  'memory.admission_facts': MemoryAdmissionFacts;
}

export type MemoryOpValue = MemoryOpValues[MemoryOpKind];

export type MemoryOpResult =
  | { readonly ok: true; readonly value: MemoryOpValue }
  | {
      readonly ok: false;
      // rejected: 書いていないことが確か。unknown: COMMIT の失敗で成否不明。
      readonly outcome: 'rejected' | 'unknown';
      readonly reasons: readonly string[];
    };

export interface MemoryStoreResult {
  readonly result: MemoryOpResult;
  readonly halt: boolean;
}

export const MEMORY_WRITE_OPS: ReadonlySet<MemoryOpKind> = new Set([
  'forget.apply',
  'forget.adopt_ledger_id',
  'backup.record_setup',
  'memory.save',
  'memory.continue',
  'memory.start_review',
  'memory.delete_due',
  'directive.revoke',
  'memory.settings_set',
]);

const KINDS: ReadonlySet<string> = new Set<MemoryOpKind>([
  'forget.graph',
  'forget.apply',
  'forget.ledger_export',
  'forget.adopt_ledger_id',
  'backup.facts',
  'backup.record_setup',
  'memory.save',
  'memory.continue',
  'memory.start_review',
  'memory.delete_due',
  'directive.revoke',
  'memory.list',
  'memory.settings_get',
  'memory.settings_set',
  'memory.admission_facts',
]);

// 記憶の一覧の上限（契約の MemoryListResponse.items の maxItems）。
export const MEMORY_LIST_MAX = 1000;

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSource(value: unknown): value is MemorySource {
  if (value === null || typeof value !== 'object') return false;
  const source = value as Partial<MemorySource>;
  if (!SOURCE_KINDS.includes(source.source_kind as never)) return false;
  return source.source_kind === 'source_item'
    ? typeof source.source_id === 'string' &&
        ORIGINAL_SOURCE_ID.test(source.source_id)
    : isUuid(source.source_id);
}

function isHmacList(value: unknown): value is readonly SourceHmacValue[] {
  return (
    Array.isArray(value) &&
    value.length <= 10_000 &&
    value.every(
      (item: Partial<SourceHmacValue> | null) =>
        item !== null &&
        typeof item === 'object' &&
        isSource({
          source_kind: item.source_kind,
          source_id: item.source_id,
        }) &&
        typeof item.hmac === 'string' &&
        item.hmac.length <= 128,
    )
  );
}

const GENERATION = /^(0|[1-9][0-9]{0,15})$/u;
// 契約の BackupKeyWrap.key_id と同じ文字種（schema_meta の CHECK も同じ）。
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

// 命令の形の検査。理由が空なら形は正しい。
export function memoryOpShapeReasons(op: MemoryOp): string[] {
  if (op === null || typeof op !== 'object' || !KINDS.has(op.kind))
    return ['kind_invalid'];
  const reasons: string[] = [];
  switch (op.kind) {
    case 'forget.graph':
      if (!isSource(op.target)) reasons.push('target_invalid');
      if (
        op.instruction_turn_id !== undefined &&
        op.instruction_turn_id !== null &&
        !isUuid(op.instruction_turn_id)
      )
        reasons.push('instruction_turn_id_invalid');
      break;
    case 'forget.apply':
      if (!isSource(op.target)) reasons.push('target_invalid');
      if (op.instruction_turn_id !== null && !isUuid(op.instruction_turn_id))
        reasons.push('instruction_turn_id_invalid');
      if (op.plan === null || typeof op.plan !== 'object')
        reasons.push('plan_invalid');
      if (!isHmacList(op.source_hmacs)) reasons.push('source_hmacs_invalid');
      if (!isUuid(op.entry_id)) reasons.push('entry_id_invalid');
      if (
        typeof op.previous_generation !== 'string' ||
        !GENERATION.test(op.previous_generation)
      )
        reasons.push('generation_invalid');
      if (!isUuid(op.new_ledger_id)) reasons.push('ledger_id_invalid');
      if (!isTime(op.now)) reasons.push('now_invalid');
      break;
    case 'forget.ledger_export':
      break;
    case 'forget.adopt_ledger_id':
      if (!isUuid(op.ledger_id)) reasons.push('ledger_id_invalid');
      break;
    case 'backup.facts':
      break;
    case 'backup.record_setup':
      if (!isUuid(op.ledger_id)) reasons.push('ledger_id_invalid');
      if (
        typeof op.ledger_hmac_key_id !== 'string' ||
        !KEY_ID.test(op.ledger_hmac_key_id)
      )
        reasons.push('ledger_key_id_invalid');
      break;
    case 'memory.save':
      if (!isUuid(op.memory_id)) reasons.push('memory_id_invalid');
      if (op.origin !== 'auto_extraction' && op.origin !== 'explicit_request')
        reasons.push('origin_invalid');
      if (!MEMORY_KINDS.includes(op.memory_kind))
        reasons.push('memory_kind_invalid');
      if (!isSealedBlob(op.text) || !isSealedBlob(op.target_key))
        reasons.push('content_invalid');
      if (!isHex64(op.target_key_hash) || !isHex64(op.dedupe_key))
        reasons.push('hash_invalid');
      if (
        !Array.isArray(op.sources) ||
        op.sources.length > 256 ||
        !op.sources.every(isSource)
      )
        reasons.push('sources_invalid');
      if (!isHmacList(op.source_hmacs)) reasons.push('source_hmacs_invalid');
      if (
        typeof op.forgetting_generation !== 'string' ||
        !GENERATION.test(op.forgetting_generation)
      )
        reasons.push('generation_invalid');
      if (
        typeof op.settings_revision !== 'string' ||
        !GENERATION.test(op.settings_revision)
      )
        reasons.push('settings_revision_invalid');
      if (!isTime(op.now)) reasons.push('now_invalid');
      break;
    case 'memory.continue':
    case 'memory.start_review':
    case 'memory.delete_due':
      if (!isUuid(op.memory_id)) reasons.push('memory_id_invalid');
      if (!isTime(op.now)) reasons.push('now_invalid');
      break;
    case 'directive.revoke':
      if (!isUuid(op.directive_id)) reasons.push('directive_id_invalid');
      break;
    case 'memory.list':
      if (
        !Number.isSafeInteger(op.limit) ||
        op.limit < 1 ||
        op.limit > MEMORY_LIST_MAX
      )
        reasons.push('limit_invalid');
      if (!isTime(op.now)) reasons.push('now_invalid');
      break;
    case 'memory.settings_get':
    case 'memory.admission_facts':
      break;
    case 'memory.settings_set':
      if (
        typeof op.expected_revision !== 'string' ||
        !GENERATION.test(op.expected_revision)
      )
        reasons.push('settings_revision_invalid');
      if (!isKindList(op.allowed_kinds)) reasons.push('allowed_kinds_invalid');
      if (!isTime(op.now)) reasons.push('now_invalid');
      break;
  }
  return reasons;
}

// 保存してよい種類の一覧の形（重なりなし・知っている種類だけ・6 件まで）。
function isKindList(value: unknown): value is readonly MemoryKindName[] {
  return (
    Array.isArray(value) &&
    value.length <= MEMORY_KINDS.length &&
    new Set(value).size === value.length &&
    value.every((item) => MEMORY_KINDS.includes(item as MemoryKindName))
  );
}

// --- 保存してよい記憶の種類の設定（0024、ADR 0191） ---

interface MemorySettingsRow {
  preference: 'on' | 'off';
  goal: 'on' | 'off';
  person: 'on' | 'off';
  routine: 'on' | 'off';
  lexicon: 'on' | 'off';
  progress: 'on' | 'off';
  settings_revision: number;
}

// 今の設定。行がなければ 6 種類とも保存しない・版 0（既定は空。#180 の Q10）。
export function readMemorySettings(db: SqliteDatabase): MemorySettingsValue {
  const row = db
    .prepare(
      'SELECT preference, goal, person, routine, lexicon, progress, settings_revision FROM memory_settings WHERE setting_id = 1',
    )
    .get() as MemorySettingsRow | undefined;
  if (row === undefined) return { allowed_kinds: [], settings_revision: '0' };
  return {
    allowed_kinds: MEMORY_KINDS.filter((kind) => row[kind] === 'on'),
    settings_revision: String(row.settings_revision),
  };
}

function setMemorySettings(
  db: SqliteDatabase,
  op: Extract<MemoryOp, { kind: 'memory.settings_set' }>,
): MemorySettingsValue {
  const current = readMemorySettings(db);
  if (current.settings_revision !== op.expected_revision)
    throw new ForgetRejection(['settings_revision_conflict']);
  const value = (kind: MemoryKindName): 'on' | 'off' =>
    op.allowed_kinds.includes(kind) ? 'on' : 'off';
  const values = MEMORY_KINDS.map(value);
  if (current.settings_revision === '0')
    db.prepare(
      'INSERT INTO memory_settings (setting_id, preference, goal, person, routine, lexicon, progress, settings_revision, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, 1, ?)',
    ).run(...values, op.now);
  else
    db.prepare(
      'UPDATE memory_settings SET preference = ?, goal = ?, person = ?, routine = ?, lexicon = ?, progress = ?, settings_revision = settings_revision + 1, updated_at = ? WHERE setting_id = 1',
    ).run(...values, op.now);
  return readMemorySettings(db);
}

// 保存の前の検査の材料（ADR 0191）。同じ読み取りの transaction で読む。
function admissionFacts(db: SqliteDatabase): MemoryAdmissionFacts {
  const existing = db
    .prepare(
      "SELECT memory_id, kind, target_key_hash, dedupe_key, status FROM memories WHERE status <> 'deleted' ORDER BY memory_id",
    )
    .all() as {
    memory_id: string;
    kind: MemoryKindName;
    target_key_hash: string;
    dedupe_key: string;
    status: 'active' | 'review_pending';
  }[];
  return {
    settings: readMemorySettings(db),
    forgetting_generation: String(currentForgettingGeneration(db)),
    ledger: readLedgerEntries(db),
    existing: existing.map((row) => ({
      memory_id: row.memory_id,
      kind: row.kind,
      target_key: row.target_key_hash,
      dedupe_key: row.dedupe_key,
      status: row.status,
    })),
  };
}

// --- 記憶 ---

interface MemoryRow {
  memory_id: string;
  status: 'active' | 'review_pending' | 'deleted';
  created_at: number;
  review_at: number;
  delete_at: number | null;
  text_blob_id: string;
  target_key_blob_id: string;
}

function memoryRow(db: SqliteDatabase, id: string): MemoryRow | undefined {
  return db
    .prepare(
      'SELECT memory_id, status, created_at, review_at, delete_at, text_blob_id, target_key_blob_id FROM memories WHERE memory_id = ?',
    )
    .get(id) as MemoryRow | undefined;
}

function schedule(row: MemoryRow): MemoryScheduleValue {
  return {
    memory_id: row.memory_id,
    status: row.status === 'review_pending' ? 'review_pending' : 'active',
    review_at: row.review_at,
    delete_at: row.delete_at,
  };
}

function insertMemoryBlob(
  db: SqliteDatabase,
  purpose: 'memory_text' | 'memory_target_key',
  memoryId: string,
  blob: SealedBlobInput,
  now: number,
): void {
  db.prepare(
    "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, ?, 'memories', ?, 0, ?, ?, ?, ?, ?, ?, NULL)",
  ).run(
    blob.blob_id,
    purpose,
    memoryId,
    blob.format_version,
    blob.key_id,
    Buffer.from(blob.nonce),
    Buffer.from(blob.ciphertext),
    Buffer.from(blob.tag),
    now,
  );
}

// 記憶の保存。保存の直前の最後の保証として、保存してよい種類の設定（ADR 0191）と、台帳の全件と由来を照合する（ADR 0040 の
// 「忘却の関連の判定」）。発言と同じ transaction で保存する経路（conversation-store の turn.record、ADR 0191）も、この関数を
// transaction の中から呼ぶ（拒否は ForgetRejection を投げ、呼び出し側の transaction ごと戻る）。
export function saveMemoryInTransaction(
  db: SqliteDatabase,
  op: Extract<MemoryOp, { kind: 'memory.save' }>,
): MemoryScheduleValue {
  const reasons: string[] = [];
  // 保存してよい種類（本人の設定）。既定は空なので、本人が許可するまで何も保存しない。処理を始めた後に設定が変わったら、
  // 変わる前の判断で保存しない。
  const settings = readMemorySettings(db);
  if (!settings.allowed_kinds.includes(op.memory_kind))
    reasons.push('kind_not_allowed');
  if (settings.settings_revision !== op.settings_revision)
    reasons.push('permission_changed');
  // 記憶は由来関係を必ず記録する（03）。由来がなければ忘却と関係するか判定できない。
  if (op.sources.length === 0) reasons.push('provenance_unknown');
  const hmacs = new Map(
    op.source_hmacs.map((item) => [
      `${item.source_kind}\u0000${item.source_id}`,
      item.hmac,
    ]),
  );
  const current = currentForgettingGeneration(db);
  // 由来の HMAC が渡されていなければ、照合できないので形の不正（source_hmac_malformed）として拒否する（閉じた側）。
  reasons.push(
    ...ledgerRelationReasons({
      sources: op.sources,
      startedGeneration: op.forgetting_generation,
      currentGeneration: String(current),
      ledger: readLedgerEntries(db),
      sourceHmac: (source) =>
        hmacs.get(`${source.source_kind}\u0000${source.source_id}`) ?? '',
      contentKey: op.origin === 'auto_extraction' ? op.dedupe_key : null,
    }),
  );
  // 由来がもうない・期限を過ぎた（掃除がまだでも）なら、期限切れの由来として保存しない（ADR 0040・0054 U118。閉じた側）。
  // 期限はこの transaction の中の今の値で判定し、ちょうどは期限切れ（掃除の sweepPlan の due と同じ now >= 期限）。
  const sourceMemoryReviewAts: number[] = [];
  for (const source of op.sources) {
    if (source.source_kind === 'turn') {
      const expiresAt = db
        .prepare('SELECT expires_at FROM turns WHERE turn_id = ?')
        .pluck()
        .get(source.source_id) as number | undefined;
      if (expiresAt === undefined || op.now >= expiresAt)
        reasons.push('source_expired');
    } else if (source.source_kind === 'source_item') {
      // 元情報は元サービスの ID（remote_id）で引く（忘却と同じ。U110）。本文が保存期限の中にある行が 1 つもなければ拒否。
      const rows = db
        .prepare(
          'SELECT fetched_at, body_blob_id FROM source_items WHERE remote_id = ?',
        )
        .all(source.source_id) as {
        fetched_at: number;
        body_blob_id: string | null;
      }[];
      if (
        !rows.some(
          (row) =>
            row.body_blob_id !== null &&
            op.now < row.fetched_at + SOURCE_BODY_MS,
        )
      )
        reasons.push('source_expired');
    } else {
      const row = memoryRow(db, source.source_id);
      if (
        row === undefined ||
        row.status === 'deleted' ||
        (row.delete_at !== null && op.now >= row.delete_at)
      )
        reasons.push('source_expired');
      else sourceMemoryReviewAts.push(row.review_at);
    }
  }
  if (reasons.length > 0) throw new ForgetRejection([...new Set(reasons)]);
  if (memoryRow(db, op.memory_id) !== undefined)
    throw new ForgetRejection(['memory_exists']);
  const live = db
    .prepare(
      "SELECT dedupe_key, kind, target_key_hash FROM memories WHERE status <> 'deleted'",
    )
    .all() as { dedupe_key: string; kind: string; target_key_hash: string }[];
  if (live.some((row) => row.dedupe_key === op.dedupe_key))
    throw new ForgetRejection(['memory_duplicate']);
  // 同じ種類・同じ対象キーで内容が違えば、両方を見直し待ちにする（J15）。見直し待ちの期限の起点は原本に決めなしで、
  // 今の CHECK（見直し日は作成より後）では表せないので、この命令は保存せずに知らせる（U111）。
  if (
    live.some(
      (row) =>
        row.kind === op.memory_kind &&
        row.target_key_hash === op.target_key_hash,
    )
  )
    throw new ForgetRejection(['memory_conflict_review_required']);
  // 見直し日: 保存から 90 日。別の記憶から作った記憶は、由来の見直し日より後にしない（再要約で延ばさない）。
  const reviewAt = Math.min(
    op.now + MEMORY_REVIEW_DAYS * DAY_MS,
    ...sourceMemoryReviewAts,
  );
  if (reviewAt <= op.now) throw new ForgetRejection(['source_review_due']);
  insertMemoryBlob(db, 'memory_text', op.memory_id, op.text, op.now);
  insertMemoryBlob(
    db,
    'memory_target_key',
    op.memory_id,
    op.target_key,
    op.now,
  );
  db.prepare(
    "INSERT INTO memories (memory_id, origin, kind, text_blob_id, target_key_blob_id, target_key_hash, dedupe_key, status, created_at, review_at, delete_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)",
  ).run(
    op.memory_id,
    op.origin,
    op.memory_kind,
    op.text.blob_id,
    op.target_key.blob_id,
    op.target_key_hash,
    op.dedupe_key,
    op.now,
    reviewAt,
  );
  const source = db.prepare(
    'INSERT INTO memory_sources (memory_id, source_kind, source_id) VALUES (?, ?, ?)',
  );
  const written = new Set<string>();
  for (const item of op.sources) {
    const key = `${item.source_kind}\u0000${item.source_id}`;
    if (written.has(key)) continue;
    written.add(key);
    source.run(op.memory_id, item.source_kind, item.source_id);
  }
  return {
    memory_id: op.memory_id,
    status: 'active',
    review_at: reviewAt,
    delete_at: null,
  };
}

function continueMemory(
  db: SqliteDatabase,
  op: Extract<MemoryOp, { kind: 'memory.continue' }>,
): MemoryScheduleValue {
  const row = memoryRow(db, op.memory_id);
  if (row === undefined) throw new ForgetRejection(['memory_not_found']);
  if (row.status !== 'review_pending')
    throw new ForgetRejection(['not_review_pending']);
  // 見直し待ちのまま期限を過ぎた記憶は、継続で生き返らせない（削除の掃除を待つ）。期限は削除と同じ補正を通す。
  if (op.now >= cappedDeleteAt(row)) throw new ForgetRejection(['delete_due']);
  const reviewAt = op.now + MEMORY_REVIEW_DAYS * DAY_MS;
  db.prepare(
    "UPDATE memories SET status = 'active', review_at = ?, delete_at = NULL WHERE memory_id = ? AND status = 'review_pending'",
  ).run(reviewAt, op.memory_id);
  return {
    memory_id: op.memory_id,
    status: 'active',
    review_at: reviewAt,
    delete_at: null,
  };
}

function startReview(
  db: SqliteDatabase,
  op: Extract<MemoryOp, { kind: 'memory.start_review' }>,
): MemoryScheduleValue {
  const row = memoryRow(db, op.memory_id);
  if (row === undefined) throw new ForgetRejection(['memory_not_found']);
  if (row.status !== 'active') throw new ForgetRejection(['not_active']);
  if (op.now < row.review_at) throw new ForgetRejection(['not_due']);
  const deleteAt = row.review_at + MEMORY_DELETE_AFTER_REVIEW_DAYS * DAY_MS;
  db.prepare(
    "UPDATE memories SET status = 'review_pending', delete_at = ? WHERE memory_id = ? AND status = 'active'",
  ).run(deleteAt, op.memory_id);
  return schedule({ ...row, status: 'review_pending', delete_at: deleteAt });
}

// 見直し待ちの削除日。保存した値と見直し日＋30 日の小さい方（保存した値が 30 日を超えて延ばされていても戻す。domain の
// sweepPlan と同じ補正で、計画と命令の結果を食い違わせない）。NULL は見直し日＋30 日。
function cappedDeleteAt(row: MemoryRow): number {
  const cap = row.review_at + MEMORY_DELETE_AFTER_REVIEW_DAYS * DAY_MS;
  return row.delete_at === null ? cap : Math.min(row.delete_at, cap);
}

// 期限切れの記憶の物理削除（台帳には書かない。再登録を禁じない。ADR 0008・0040）。記憶の行・由来の行・暗号文を消す。
// この記憶を由来にする辺は残す（存在しない由来は期限切れとして扱う）。派生物が残っていれば、この記憶の由来の辺
// （ID だけ）を derivations に残す。本文を消しても、生きた派生物から元の発言・元情報へ辿れるようにし、後で元情報を
// 忘れたときに派生物が閉包から漏れないようにする（ADR 0054 U110。辺は削除の前と同じなので、閉包は削除の前と変わらない）。
function deleteDueMemory(
  db: SqliteDatabase,
  op: Extract<MemoryOp, { kind: 'memory.delete_due' }>,
): { readonly memory_id: string; readonly deleted: boolean } {
  const row = memoryRow(db, op.memory_id);
  if (row === undefined) return { memory_id: op.memory_id, deleted: false };
  // 状態が deleted の行（掃除の計画の status_deleted）は期限を待たずに消す。ほかは見直し待ちで、期限を過ぎたものだけ。
  // 期限は domain の sweepPlan（ADR 0043）と同じ補正を通す: 保存した削除日と見直し日＋30 日の小さい方（0001 の CHECK で
  // 見直し待ちの削除日が NULL の行は作れないが、NULL なら見直し日＋30 日）。
  if (row.status !== 'deleted') {
    if (row.status !== 'review_pending')
      throw new ForgetRejection(['not_review_pending']);
    if (op.now < cappedDeleteAt(row)) throw new ForgetRejection(['not_due']);
  }
  const sources = db
    .prepare(
      'SELECT source_kind, source_id FROM memory_sources WHERE memory_id = ? ORDER BY source_kind, source_id',
    )
    .all(op.memory_id) as { source_kind: string; source_id: string }[];
  const node = { kind: 'memory', id: op.memory_id };
  const parents = lineageSources(db, node);
  if (lineageHasLiveDownstream(db, node)) {
    const exists = db.prepare(
      "SELECT 1 FROM derivations WHERE artifact_kind = 'memory' AND artifact_id = ? AND source_kind = ? AND source_id = ?",
    );
    const insert = db.prepare(
      "INSERT INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at) VALUES ('memory', ?, ?, ?, ?)",
    );
    for (const source of sources)
      if (
        exists.get(op.memory_id, source.source_kind, source.source_id) ===
        undefined
      )
        insert.run(op.memory_id, source.source_kind, source.source_id, op.now);
  }
  db.prepare('DELETE FROM memory_sources WHERE memory_id = ?').run(
    op.memory_id,
  );
  db.prepare('DELETE FROM memories WHERE memory_id = ?').run(op.memory_id);
  db.prepare('DELETE FROM sealed_blobs WHERE blob_id IN (?, ?)').run(
    row.text_blob_id,
    row.target_key_blob_id,
  );
  // 生きた下流がなければ、この記憶の辺を消し、実体を消した由来（記憶・ほかの派生物）の辺も要らなくなれば消す。
  pruneDeadLineage(db, [node, ...parents]);
  return { memory_id: op.memory_id, deleted: true };
}

// 0012 より前の台帳の行（hash・項目の数が NULL）に系譜を付ける（U119）。0012 より前の製品に台帳を書く経路はなかったので、
// ふつうは起きない。台帳のファイル・端末の複製がないこと（系譜を確かめられないのに新しい ID を出さないこと）は Core が
// 確かめる。旧い行が台帳のファイルの形（次の起動で読み戻す形）で書き出せなければ付けずに拒否する（手で直す）。
function adoptLedgerId(
  db: SqliteDatabase,
  op: Extract<MemoryOp, { kind: 'forget.adopt_ledger_id' }>,
): { readonly ledger_id: string; readonly forgetting_generation: string } {
  if (readLedgerId(db) !== null)
    throw new ForgetRejection(['ledger_id_present']);
  const entries = readLedgerChain(db);
  const last = entries.at(-1);
  if (last === undefined) throw new ForgetRejection(['ledger_empty']);
  const file = buildLedgerFile(
    {
      ledger_id: op.ledger_id,
      entries,
      head: {
        forgetting_generation: last.entry.forgetting_generation,
        entry_hash: last.entry_hash,
      },
    },
    new Date(0),
  );
  if (parseLedgerFile(JSON.stringify(file)) === null)
    throw new ForgetRejection(['legacy_ledger_invalid']);
  db.prepare(
    "INSERT INTO schema_meta (key, value) VALUES ('ledger_id', ?)",
  ).run(op.ledger_id);
  return {
    ledger_id: op.ledger_id,
    forgetting_generation: last.entry.forgetting_generation,
  };
}

// バックアップの設定の記録（ADR 0055）。台帳の系譜は、まだ付いておらず台帳が空のときだけここで付ける（忘却を 1 件でもした
// DB に系譜がなければ、起動の確認（U119）を通らない状態なので付けない）。台帳の HMAC の鍵の ID は、同じ系譜の中では変えない
// （変えると、台帳と記憶の HMAC を照合できず、忘れた元情報の再取り込みを止められなくなる）。
function recordBackupSetup(
  db: SqliteDatabase,
  op: Extract<MemoryOp, { kind: 'backup.record_setup' }>,
): {
  readonly ledger_id: string;
  readonly ledger_hmac_key_id: string;
  readonly forgetting_generation: string;
} {
  const generation = currentForgettingGeneration(db);
  let ledgerId = readLedgerId(db);
  if (ledgerId === null) {
    if (generation > 0) throw new ForgetRejection(['ledger_lineage_missing']);
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('ledger_id', ?)",
    ).run(op.ledger_id);
    ledgerId = op.ledger_id;
  }
  const recorded = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'ledger_hmac_key_id'")
    .pluck()
    .get() as string | undefined;
  if (recorded === undefined)
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('ledger_hmac_key_id', ?)",
    ).run(op.ledger_hmac_key_id);
  else if (recorded !== op.ledger_hmac_key_id)
    throw new ForgetRejection(['ledger_key_id_conflict']);
  return {
    ledger_id: ledgerId,
    ledger_hmac_key_id: op.ledger_hmac_key_id,
    forgetting_generation: String(generation),
  };
}

// 本人の指示の取り消し。取り消した指示は使わないので、行と暗号文を消す（03 は設定画面で確認・取り消しできるとだけ
// 定める。取り消した指示を残す理由がないので、残さない側にした。U112）。
function revokeDirective(
  db: SqliteDatabase,
  op: Extract<MemoryOp, { kind: 'directive.revoke' }>,
): { readonly directive_id: string; readonly revoked: boolean } {
  const blob = db
    .prepare('SELECT text_blob_id FROM user_directives WHERE directive_id = ?')
    .pluck()
    .get(op.directive_id) as string | undefined;
  if (blob === undefined)
    return { directive_id: op.directive_id, revoked: false };
  db.prepare('DELETE FROM user_directives WHERE directive_id = ?').run(
    op.directive_id,
  );
  db.prepare('DELETE FROM sealed_blobs WHERE blob_id = ?').run(blob);
  return { directive_id: op.directive_id, revoked: true };
}

function applyWrite(db: SqliteDatabase, op: MemoryOp): MemoryOpValue {
  switch (op.kind) {
    case 'forget.apply':
      return applyForget(db, op);
    case 'forget.adopt_ledger_id':
      return adoptLedgerId(db, op);
    case 'backup.record_setup':
      return recordBackupSetup(db, op);
    case 'memory.save':
      return saveMemoryInTransaction(db, op);
    case 'memory.settings_set':
      return setMemorySettings(db, op);
    case 'memory.continue':
      return continueMemory(db, op);
    case 'memory.start_review':
      return startReview(db, op);
    case 'memory.delete_due':
      return deleteDueMemory(db, op);
    case 'directive.revoke':
      return revokeDirective(db, op);
    default:
      throw new ForgetRejection(['kind_invalid']);
  }
}

// 記憶の一覧（UI-10、ADR 0183）。削除の期限は掃除（memory.delete_due）と同じ補正（保存した削除日と見直し日＋30 日の小さい方）
// で判定し、期限ちょうど（now >= 期限）は出さない。保存中の記憶は削除日を持たない（0001 の CHECK）ので、見直し日を過ぎていても
// 見直し待ちへ移るまでは保存中として出す。
function listMemories(
  db: SqliteDatabase,
  op: Extract<MemoryOp, { kind: 'memory.list' }>,
): MemoryOpValues['memory.list'] {
  const rows = db
    .prepare(
      "SELECT memory_id, origin, kind, status, created_at, review_at, delete_at, text_blob_id, target_key_blob_id FROM memories WHERE status <> 'deleted' ORDER BY created_at DESC, memory_id",
    )
    .all() as (MemoryRow & {
    origin: MemoryListRow['origin'];
    kind: MemoryListRow['kind'];
  })[];
  const blob = db.prepare(
    "SELECT blob_id, format_version, key_id, nonce, ciphertext, tag FROM sealed_blobs WHERE blob_id = ? AND purpose = 'memory_text' AND owner_table = 'memories' AND owner_id = ?",
  );
  const sources = db.prepare(
    'SELECT source_kind, count(*) AS n FROM memory_sources WHERE memory_id = ? GROUP BY source_kind',
  );
  const shown = rows.filter(
    (row) => row.status === 'active' || op.now < cappedDeleteAt(row),
  );
  const listed: MemoryListRow[] = [];
  for (const row of shown.slice(0, op.limit)) {
    const found = blob.get(row.text_blob_id, row.memory_id) as
      | {
          blob_id: string;
          format_version: number;
          key_id: string;
          nonce: Buffer;
          ciphertext: Buffer;
          tag: Buffer;
        }
      | undefined;
    const counts = { turn: 0, source_item: 0, memory: 0 };
    for (const item of sources.all(row.memory_id) as {
      source_kind: keyof typeof counts;
      n: number;
    }[])
      if (Object.hasOwn(counts, item.source_kind))
        counts[item.source_kind] = item.n;
    listed.push({
      memory_id: row.memory_id,
      origin: row.origin,
      kind: row.kind,
      status: row.status === 'review_pending' ? 'review_pending' : 'active',
      created_at: row.created_at,
      review_at: row.review_at,
      delete_at: row.delete_at,
      text:
        found === undefined
          ? null
          : {
              blob_id: found.blob_id,
              format_version: found.format_version,
              key_id: found.key_id,
              nonce: new Uint8Array(found.nonce),
              ciphertext: new Uint8Array(found.ciphertext),
              tag: new Uint8Array(found.tag),
            },
      source_counts: counts,
    });
  }
  return { rows: listed, truncated: shown.length > op.limit };
}

// 系譜の辺にある本人の指示（user_directive の節点）の本文の封筒を読む（U433、ADR 0185）。行がなければ出さない（同じ
// transaction で読んだ系譜にある指示は行を持つ）。封筒は所有者（表・ID・用途）が合う行だけを返し、なければ null。
function readGraphDirectives(
  db: SqliteDatabase,
  graph: ForgetGraph,
): ForgetDirectiveRow[] {
  const ids = new Set<string>();
  for (const edge of graph.edges)
    if (edge.artifact.kind === 'user_directive') ids.add(edge.artifact.id);
  const read = db.prepare(
    "SELECT d.directive_id, d.scope, b.blob_id, b.format_version, b.key_id, b.nonce, b.ciphertext, b.tag FROM user_directives d LEFT JOIN sealed_blobs b ON b.blob_id = d.text_blob_id AND b.purpose = 'directive_text' AND b.owner_table = 'user_directives' AND b.owner_id = d.directive_id WHERE d.directive_id = ?",
  );
  const rows: ForgetDirectiveRow[] = [];
  for (const id of [...ids].sort()) {
    const found = read.get(id) as
      | {
          directive_id: string;
          scope: ForgetDirectiveRow['scope'];
          blob_id: string | null;
          format_version: number | null;
          key_id: string | null;
          nonce: Buffer | null;
          ciphertext: Buffer | null;
          tag: Buffer | null;
        }
      | undefined;
    if (found === undefined) continue;
    rows.push({
      directive_id: found.directive_id,
      scope: found.scope,
      text:
        found.blob_id === null ||
        found.format_version === null ||
        found.key_id === null ||
        found.nonce === null ||
        found.ciphertext === null ||
        found.tag === null
          ? null
          : {
              blob_id: found.blob_id,
              format_version: found.format_version,
              key_id: found.key_id,
              nonce: new Uint8Array(found.nonce),
              ciphertext: new Uint8Array(found.ciphertext),
              tag: new Uint8Array(found.tag),
            },
    });
  }
  return rows;
}

function readOnly(db: SqliteDatabase, op: MemoryOp): MemoryOpValue {
  switch (op.kind) {
    case 'forget.graph':
      return db.transaction(() => {
        const graph = readForgetSubgraph(db, {
          target: op.target,
          instruction_turn_id: op.instruction_turn_id ?? null,
        });
        return {
          graph,
          forgetting_generation: String(currentForgettingGeneration(db)),
          target_exists: forgetTargetExists(db, op.target),
          ledger_id: readLedgerId(db),
          directives: readGraphDirectives(db, graph),
        };
      })();
    case 'forget.ledger_export':
      return db.transaction(() => exportForgetLedger(db))();
    case 'backup.facts':
      return readBackupFacts(db);
    case 'memory.list':
      return db.transaction(() => listMemories(db, op))();
    case 'memory.settings_get':
      return readMemorySettings(db);
    case 'memory.admission_facts':
      return db.transaction(() => admissionFacts(db))();
    default:
      throw new ForgetRejection(['kind_invalid']);
  }
}

const rejected = (reasons: readonly string[]): MemoryOpResult => ({
  ok: false,
  outcome: 'rejected',
  reasons,
});

function failure(error: unknown): MemoryStoreResult {
  if (error instanceof ForgetRejection)
    return { result: rejected(error.reasons), halt: false };
  if (error instanceof Error && error.name === 'CommitUncertain')
    return {
      result: { ok: false, outcome: 'unknown', reasons: ['commit_failed'] },
      halt: true,
    };
  const code = error instanceof Database.SqliteError ? error.code : null;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
    return { result: rejected(['database_busy']), halt: false };
  if (code?.startsWith('SQLITE_CONSTRAINT')) {
    const message = error instanceof Error ? error.message : '';
    return {
      result: rejected([
        /^[a-z_]{1,64}$/u.test(message) ? message : 'constraint_violation',
      ]),
      halt: false,
    };
  }
  return {
    result: rejected([
      code === 'SQLITE_FULL' ? 'database_full' : 'transaction_failed',
    ]),
    halt: true,
  };
}

export interface MemoryContext {
  readonly platform: StoragePlatform;
  readonly halted: boolean;
  // 故障注入の試験用。transaction の本体の後・COMMIT の前に呼ぶ。
  readonly beforeCommit?: (op: MemoryOp) => void;
}

// 記憶と忘却の命令と照会を 1 件処理する。DB worker の中から呼ぶ。
export function executeMemoryOp(
  db: SqliteDatabase,
  op: MemoryOp,
  context: MemoryContext,
): MemoryStoreResult {
  const shape = memoryOpShapeReasons(op);
  if (shape.length > 0) return { result: rejected(shape), halt: false };
  if (!MEMORY_WRITE_OPS.has(op.kind)) {
    try {
      return { result: { ok: true, value: readOnly(db, op) }, halt: false };
    } catch (error) {
      if (error instanceof ForgetRejection)
        return { result: rejected(error.reasons), halt: false };
      throw error;
    }
  }
  // 書込みを止めた worker は書かない（ADR 0018）。照会は続ける。
  if (context.halted)
    return { result: rejected(['worker_halted']), halt: false };
  const durability = writeConnectionReasons(db, context.platform);
  if (durability.length > 0)
    return {
      result: rejected(['durability_mismatch', ...durability]),
      halt: true,
    };
  const beforeCommit =
    context.beforeCommit === undefined
      ? undefined
      : () => context.beforeCommit?.(op);
  try {
    const run = runImmediate(db, () => applyWrite(db, op), beforeCommit);
    return { result: { ok: true, value: run.value }, halt: false };
  } catch (error) {
    return failure(error);
  }
}
