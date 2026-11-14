// 影モードの比較記録の保存（設計 03 の intent_shadow、設計 10 §5、ADR 0008・0092・0110、B06-06e）。
//
// - intent_shadow.count: campaign ごとの記録の件数（Core が campaign の停止条件に使う）。
// - intent_shadow.save: 1 つの入力に対する比較の記録を 1 行で保存する。INSERT と同じ BEGIN IMMEDIATE の transaction の中で
//   次の順に判定する（読んでから書くまでの間に別の writer が入らない）。
//     1. 同じ組（campaign_id, input_id, request_revision）の行があれば、書かずに duplicate（再送・復元の後の再保存で増やさない）。
//     2. campaign ごとの件数が limit 以上なら、書かずに limit_reached（300 件の上限。Core の事前の確認とは別の最後のガード）。
//     3. それ以外は INSERT して saved。
// - limit は 1〜300 だけを受ける（設定が 300 を超えていても、保存側で 300 を超えて書かない）。
// - 発話の本文は持たない。判定（本線と比較モデルの outcome・意図・引数・遅延）だけを judgments の列に JCS の JSON で置き、
//   記録は input_id（と request_revision）で発言を指す。used_for_execution は常に false。
// - 時刻は呼び出し側の値を信じる（DB は時計を持たない）。expires_at は Core が発言の期限から決める。
// 結果には ID と件数だけを入れ、本文・SQL・パスを入れない。

import Database from 'better-sqlite3';
import { writeConnectionReasons } from './connection.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import { canonicalIntentJson } from './content-hash.js';
import { isUuid } from './forget-store.js';
import { runImmediate } from './operation-store.js';

// 比較の件数の上限（Core の SHADOW_MAX_INPUTS と同じ値。storage は @buddy/contracts に依存しないので写しを持つ）。
export const SHADOW_RECORD_LIMIT = 300;

// 契約の Id（ランダム UUID v4）の形の検査。campaign_id・input_id・record_id と配備の ID に使う。
const REQUEST_REVISION = /^(0|[1-9][0-9]{0,15})$/u;
const UTC_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9](\.[0-9]+)?Z$/u;
const OUTCOMES: ReadonlySet<string> = new Set([
  'ok',
  'needs_clarification',
  'refused',
  'truncated',
  'invalid_output',
  'timeout',
  'unavailable',
  'skipped',
]);

export class IntentShadowRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'IntentShadowRejection';
    this.reasons = reasons;
  }
}

// 契約の ShadowJudgment（storage は @buddy/contracts に依存しないので同じ形を写す）。
export interface IntentShadowJudgmentInput {
  readonly deployment_id: string;
  readonly outcome: string;
  readonly intent: string | null;
  readonly args: Readonly<Record<string, unknown>> | null;
  readonly probability: string | null;
  readonly latency_ms: number | null;
}

// 契約の IntentShadowRecord。
export interface IntentShadowRecordInput {
  readonly schema: 'buddy.intent-shadow.v1';
  readonly record_id: string;
  readonly campaign_id: string;
  readonly input_id: string;
  readonly request_revision: string;
  readonly primary: IntentShadowJudgmentInput;
  readonly shadows: readonly IntentShadowJudgmentInput[];
  readonly recorded_at: string;
  readonly expires_at: string;
  readonly used_for_execution: boolean;
}

export type IntentShadowOp =
  | { readonly kind: 'intent_shadow.count'; readonly campaign_id: string }
  | {
      readonly kind: 'intent_shadow.save';
      readonly record: IntentShadowRecordInput;
      // この campaign の記録の上限（1〜300）。
      readonly limit: number;
    };

export type IntentShadowOpKind = IntentShadowOp['kind'];

// 保存の結果。saved は書いた、duplicate は同じ組があった、limit_reached は上限で書かなかった（どれも書込みの失敗ではない）。
export type IntentShadowSaveResult = 'saved' | 'duplicate' | 'limit_reached';

export interface IntentShadowOpValues {
  'intent_shadow.count': {
    readonly campaign_id: string;
    readonly count: number;
  };
  'intent_shadow.save': {
    readonly record_id: string;
    readonly result: IntentShadowSaveResult;
  };
}

export type IntentShadowOpValue = IntentShadowOpValues[IntentShadowOpKind];

export type IntentShadowOpResult =
  | { readonly ok: true; readonly value: IntentShadowOpValue }
  | {
      readonly ok: false;
      // rejected: 書いていないことが確か。unknown: COMMIT の失敗で成否不明。
      readonly outcome: 'rejected' | 'unknown';
      readonly reasons: readonly string[];
    };

export interface IntentShadowStoreResult {
  readonly result: IntentShadowOpResult;
  readonly halt: boolean;
}

export const INTENT_SHADOW_WRITE_OPS: ReadonlySet<IntentShadowOpKind> = new Set(
  ['intent_shadow.save'],
);

const KINDS: ReadonlySet<string> = new Set<IntentShadowOpKind>([
  'intent_shadow.count',
  'intent_shadow.save',
]);

function isUtcTime(value: unknown): value is string {
  return typeof value === 'string' && UTC_TIME.test(value);
}

function isJudgment(value: unknown): value is IntentShadowJudgmentInput {
  if (value === null || typeof value !== 'object') return false;
  const item = value as Partial<IntentShadowJudgmentInput>;
  if (typeof item.deployment_id !== 'string' || !isUuid(item.deployment_id))
    return false;
  if (typeof item.outcome !== 'string' || !OUTCOMES.has(item.outcome))
    return false;
  if (item.intent !== null && typeof item.intent !== 'string') return false;
  if (
    item.args !== null &&
    (typeof item.args !== 'object' || Array.isArray(item.args))
  )
    return false;
  if (item.probability !== null && typeof item.probability !== 'string')
    return false;
  return (
    item.latency_ms === null ||
    (typeof item.latency_ms === 'number' &&
      Number.isSafeInteger(item.latency_ms) &&
      item.latency_ms >= 0)
  );
}

function recordReasons(record: unknown): string[] {
  if (record === null || typeof record !== 'object') return ['record_invalid'];
  const item = record as Partial<IntentShadowRecordInput>;
  const reasons: string[] = [];
  if (item.schema !== 'buddy.intent-shadow.v1') reasons.push('schema_invalid');
  for (const key of ['record_id', 'campaign_id', 'input_id'] as const) {
    const value = item[key];
    if (typeof value !== 'string' || !isUuid(value))
      reasons.push(`${key}_invalid`);
  }
  if (
    typeof item.request_revision !== 'string' ||
    !REQUEST_REVISION.test(item.request_revision) ||
    item.request_revision === '0'
  )
    reasons.push('request_revision_invalid');
  if (!isJudgment(item.primary)) reasons.push('primary_invalid');
  if (
    !Array.isArray(item.shadows) ||
    item.shadows.length === 0 ||
    item.shadows.length > 64 ||
    !item.shadows.every(isJudgment)
  )
    reasons.push('shadows_invalid');
  if (!isUtcTime(item.recorded_at)) reasons.push('recorded_at_invalid');
  if (!isUtcTime(item.expires_at)) reasons.push('expires_at_invalid');
  else if (
    isUtcTime(item.recorded_at) &&
    !(Date.parse(item.expires_at) > Date.parse(item.recorded_at))
  )
    reasons.push('expires_at_not_after_recorded_at');
  // 影の判定は実行に使わない（契約の const false）。
  if (item.used_for_execution !== false)
    reasons.push('used_for_execution_not_false');
  return reasons;
}

// 命令の形の検査。理由が空なら形は正しい。
export function intentShadowOpShapeReasons(op: IntentShadowOp): string[] {
  if (op === null || typeof op !== 'object' || !KINDS.has(op.kind))
    return ['kind_invalid'];
  if (op.kind === 'intent_shadow.count')
    return typeof op.campaign_id === 'string' && isUuid(op.campaign_id)
      ? []
      : ['campaign_id_invalid'];
  const reasons = recordReasons(op.record);
  if (
    typeof op.limit !== 'number' ||
    !Number.isSafeInteger(op.limit) ||
    op.limit < 1 ||
    op.limit > SHADOW_RECORD_LIMIT
  )
    reasons.push('limit_invalid');
  return reasons;
}

// --- 件数 ---

export function countShadows(db: SqliteDatabase, campaignId: string): number {
  const row = db
    .prepare(
      'SELECT count(*) AS value FROM intent_shadow WHERE campaign_id = ?',
    )
    .get(campaignId) as { value: number };
  return row.value;
}

// --- 保存 ---

// judgments の列に置く値。列にならない残り（schema・判定・実行に使わない印）を JCS の JSON にする。
function judgmentsJson(record: IntentShadowRecordInput): string {
  return canonicalIntentJson({
    schema: record.schema,
    primary: record.primary,
    shadows: record.shadows,
    used_for_execution: record.used_for_execution,
  });
}

function saveRecord(
  db: SqliteDatabase,
  op: Extract<IntentShadowOp, { kind: 'intent_shadow.save' }>,
): IntentShadowOpValues['intent_shadow.save'] {
  const record = op.record;
  const revision = Number(record.request_revision);
  // 1. 同じ組は 1 行だけ（再送・復元の後の再保存で増やさない）。上限より先に見る: すでにある行は上限で「書けなかった」
  //    のではなく、内容が変わっていない。
  const exists = db
    .prepare(
      'SELECT 1 FROM intent_shadow WHERE campaign_id = ? AND input_id = ? AND request_revision = ?',
    )
    .get(record.campaign_id, record.input_id, revision);
  if (exists !== undefined)
    return { record_id: record.record_id, result: 'duplicate' };
  // 2. 上限。件数の確認と INSERT を同じ transaction で行う（同時の保存でも超えない）。
  if (countShadows(db, record.campaign_id) >= op.limit)
    return { record_id: record.record_id, result: 'limit_reached' };
  // 3. INSERT。expires_at > recorded_at は表の CHECK が最後に確かめる。
  db.prepare(
    'INSERT INTO intent_shadow (record_id, campaign_id, input_id, request_revision, judgments, recorded_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    record.record_id,
    record.campaign_id,
    record.input_id,
    revision,
    judgmentsJson(record),
    Date.parse(record.recorded_at),
    Date.parse(record.expires_at),
  );
  return { record_id: record.record_id, result: 'saved' };
}

// 一意制約に当たった保存は duplicate にする（SELECT と INSERT の間に別の writer が入る経路はないが、表の保証として残す）。
function uniqueConflict(error: unknown): boolean {
  return (
    error instanceof Database.SqliteError &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

const rejected = (reasons: readonly string[]): IntentShadowOpResult => ({
  ok: false,
  outcome: 'rejected',
  reasons,
});

function failure(error: unknown): IntentShadowStoreResult {
  if (error instanceof IntentShadowRejection)
    return { result: rejected(error.reasons), halt: false };
  if (error instanceof Error && error.name === 'CommitUncertain')
    return {
      result: { ok: false, outcome: 'unknown', reasons: ['commit_failed'] },
      halt: true,
    };
  const code = error instanceof Database.SqliteError ? error.code : null;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
    return { result: rejected(['database_busy']), halt: false };
  if (code?.startsWith('SQLITE_CONSTRAINT'))
    return {
      result: rejected([
        error instanceof Error && /^[a-z_]{1,64}$/u.test(error.message)
          ? error.message
          : 'constraint_violation',
      ]),
      halt: false,
    };
  return {
    result: rejected([
      code === 'SQLITE_FULL' ? 'database_full' : 'transaction_failed',
    ]),
    halt: true,
  };
}

export interface IntentShadowContext {
  readonly platform: StoragePlatform;
  readonly halted: boolean;
  // 故障注入の試験用。transaction の本体の後・COMMIT の前に呼ぶ。
  readonly beforeCommit?: (op: IntentShadowOp) => void;
}

// 影モードの記録の命令と照会を 1 件処理する。DB worker の中から呼ぶ。
export function executeIntentShadowOp(
  db: SqliteDatabase,
  op: IntentShadowOp,
  context: IntentShadowContext,
): IntentShadowStoreResult {
  const shape = intentShadowOpShapeReasons(op);
  if (shape.length > 0) return { result: rejected(shape), halt: false };
  if (op.kind === 'intent_shadow.count')
    return {
      result: {
        ok: true,
        value: {
          campaign_id: op.campaign_id,
          count: countShadows(db, op.campaign_id),
        },
      },
      halt: false,
    };
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
    const run = runImmediate(
      db,
      () => {
        try {
          return saveRecord(db, op);
        } catch (error) {
          // 一意制約だけは書込みの失敗ではない（すでにある行を残す）。ほかは呼び出し側へ返す。
          if (uniqueConflict(error))
            return {
              record_id: op.record.record_id,
              result: 'duplicate' as const,
            };
          throw error;
        }
      },
      beforeCommit,
    );
    return { result: { ok: true, value: run.value }, halt: false };
  } catch (error) {
    return failure(error);
  }
}
