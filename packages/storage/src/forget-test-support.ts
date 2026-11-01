// 忘却の試験の合成の世界と手順（試験専用。index.ts から export しない。ADR 0054）。
// 期待値は手で書いた。連鎖の hash は、{entry, previous_hash} を Python の json.dumps（キーの整列・区切りなし。値は
// ASCII だけで RFC 8785 と同じ正規形）で書き出して hashlib の SHA-256 で別に求めた値を写した。HMAC・内容の HMAC は
// 試験用に決めた 64 桁の値で、鍵による計算ではない。

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { planForget } from '@buddy/domain';
import type { ForgetGraph, MemorySource } from '@buddy/domain';
import { executeCommand, executeMemoryOp } from './index.js';
import type {
  DbCommand,
  ForgetGraphValue,
  MemoryOp,
  MemoryOpResult,
  SqliteDatabase,
  SourceHmacValue,
  StoreOutcome,
} from './index.js';
import {
  STORE_GENERATION,
  approveCommand,
  createCommand,
  databasePath,
  dispatchCommand,
  openSeededDatabase,
  prepareCommand,
  resultCommand,
  withTempDir,
} from './operation-test-support.js';

// 合成の ID（UUID v4 の形）。
export const M = '11111111-1111-4111-8111-111111111111';
export const M2 = '22222222-2222-4222-8222-222222222222';
export const T_SRC = '33333333-3333-4333-8333-333333333333';
export const T_INST = '44444444-4444-4444-8444-444444444444';
export const T_OTHER = '55555555-5555-4555-8555-555555555555';
export const M_OTHER = '66666666-6666-4666-8666-666666666666';
export const S = '77777777-7777-4777-8777-777777777777';
export const S_INST = '88888888-8888-4888-8888-888888888888';
export const ENTRY_1 = '99999999-9999-4999-8999-999999999999';
export const ENTRY_2 = '99999999-9999-4999-8999-999999999998';
export const LEDGER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const OP_DONE = 'e0000000-0000-4000-8000-000000000001';
export const OP_RET = 'e0000000-0000-4000-8000-000000000002';
export const OP_DISP = 'e0000000-0000-4000-8000-000000000003';
export const DIRECTIVE = 'f0000000-0000-4000-8000-000000000001';
// 内容の HMAC（memories.dedupe_key）と台帳用 HMAC（試験用に決めた値）。
export const DK_M = 'd1'.repeat(32);
export const DK_M2 = 'd2'.repeat(32);
export const DK_OTHER = 'd3'.repeat(32);
export const H_T_SRC = 'b1'.repeat(32);
export const H_T_OTHER = 'b2'.repeat(32);
export const NOW_1 = Date.parse('2031-01-02T03:04:05.678Z');
export const NOW_2 = Date.parse('2031-01-03T00:00:00.000Z');
// 手で求めた連鎖の hash（上の説明のとおり Python で計算した値）。
export const HASH_1 =
  'b23f50ec7a08623b6156a1caa1440fe2481aae967ef37c4b2e74c916d246abbd';
export const HASH_2 =
  'fa9732e237f3ee3234d8495fd9bee5f1e74d223bc8e1c12ff7f0dfc707bf3afb';

export const HMACS: readonly SourceHmacValue[] = [
  { source_kind: 'turn', source_id: T_SRC, hmac: H_T_SRC },
  { source_kind: 'turn', source_id: T_OTHER, hmac: H_T_OTHER },
  { source_kind: 'turn', source_id: T_INST, hmac: 'b3'.repeat(32) },
  { source_kind: 'memory', source_id: M, hmac: 'c1'.repeat(32) },
  { source_kind: 'memory', source_id: M_OTHER, hmac: 'c3'.repeat(32) },
];

export function memoryOp(
  db: SqliteDatabase,
  op: MemoryOp,
  beforeCommit?: () => void,
): MemoryOpResult {
  return executeMemoryOp(db, op, {
    platform: 'macos',
    halted: false,
    ...(beforeCommit === undefined ? {} : { beforeCommit }),
  }).result;
}

export function value<T>(result: MemoryOpResult): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result.ok ? result.value : null) as T;
}

export function reasons(result: MemoryOpResult): readonly string[] {
  assert.equal(result.ok, false, JSON.stringify(result));
  return result.ok ? [] : result.reasons;
}

export function run(
  db: SqliteDatabase,
  command: DbCommand,
  now = 1_000_000,
): StoreOutcome {
  return executeCommand(db, command, {
    now,
    platform: 'macos',
    storeGeneration: STORE_GENERATION,
  }).outcome;
}

export function ok(
  db: SqliteDatabase,
  command: DbCommand,
  now = 1_000_000,
): void {
  const outcome = run(db, command, now);
  assert.equal(outcome.outcome, 'durable', JSON.stringify(outcome));
}

export const count = (
  db: SqliteDatabase,
  sql: string,
  ...args: unknown[]
): number =>
  db
    .prepare(sql)
    .pluck()
    .get(...args) as number;

export function blob(
  db: SqliteDatabase,
  purpose: string,
  ownerTable: string,
  ownerId: string,
): string {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?, ?, 1000, NULL)',
  ).run(
    id,
    purpose,
    ownerTable,
    ownerId,
    'k-test',
    randomBytes(12),
    randomBytes(24),
    randomBytes(16),
  );
  return id;
}

function insertTurn(
  db: SqliteDatabase,
  turnId: string,
  sessionId: string,
): void {
  const text = blob(db, 'turn_text', 'turns', turnId);
  db.prepare(
    "INSERT INTO turns (turn_id, session_id, role, input_kind, text_blob_id, created_at, expires_at) VALUES (?, ?, 'user', 'text', ?, 1000, 9999999999999)",
  ).run(turnId, sessionId, text);
}

export function insertMemory(
  db: SqliteDatabase,
  memoryId: string,
  dedupe: string,
  sources: readonly MemorySource[],
): void {
  const text = blob(db, 'memory_text', 'memories', memoryId);
  const key = blob(db, 'memory_target_key', 'memories', memoryId);
  db.prepare(
    "INSERT INTO memories (memory_id, origin, kind, text_blob_id, target_key_blob_id, target_key_hash, dedupe_key, status, created_at, review_at, delete_at) VALUES (?, 'explicit_request', 'preference', ?, ?, ?, ?, 'active', 1000, 9000000000000, NULL)",
  ).run(memoryId, text, key, `${dedupe.slice(0, 62)}ff`, dedupe);
  for (const source of sources)
    db.prepare(
      'INSERT INTO memory_sources (memory_id, source_kind, source_id) VALUES (?, ?, ?)',
    ).run(memoryId, source.source_kind, source.source_id);
}

export function edge(
  db: SqliteDatabase,
  artifactKind: string,
  artifactId: string,
  sourceKind: string,
  sourceId: string,
): void {
  db.prepare(
    'INSERT INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at) VALUES (?, ?, ?, ?, 1000)',
  ).run(artifactKind, artifactId, sourceKind, sourceId);
}

// 成功した操作（完了の時刻 1_000_000。確定内容を消してよい・90 日の削除の対象になる）。
export function completeOperation(
  db: SqliteDatabase,
  operationId: string,
): void {
  ok(db, createCommand(operationId));
  ok(db, approveCommand(operationId, '1'));
  const attempt = randomUUID();
  ok(db, prepareCommand(operationId, '2', { attempt_id: attempt }));
  ok(db, dispatchCommand(operationId, '3', attempt));
  ok(db, resultCommand(operationId, '4', attempt, 'reconciling'));
  ok(db, resultCommand(operationId, '5', attempt, 'succeeded'));
}

// 忘却の世界: 記憶 M（発言 T_SRC から）、M から作った記憶 M2・気づき・3 つの操作の確定内容、会話 S の要約（由来の記録なし。
// S の発言は T_SRC だけ）、忘却の指示の発言 T_INST（会話 S_INST）と、その影モードの記録（由来の記録なし）・応答・
// 本人の指示、関係のない記憶 M_OTHER（発言 T_OTHER から）。
export function seedWorld(db: SqliteDatabase): void {
  db.prepare(
    "INSERT INTO sessions (session_id, storage_mode, display_device_id, route_revision, summary_blob_id, created_at, ended_at) VALUES (?, 'normal', 'dev-1', 0, NULL, 1000, NULL)",
  ).run(S);
  db.prepare(
    "INSERT INTO sessions (session_id, storage_mode, display_device_id, route_revision, summary_blob_id, created_at, ended_at) VALUES (?, 'normal', 'dev-1', 0, NULL, 1000, NULL)",
  ).run(S_INST);
  insertTurn(db, T_SRC, S);
  insertTurn(db, T_INST, S_INST);
  insertTurn(db, T_OTHER, S_INST);
  const summary = blob(db, 'session_summary', 'sessions', S);
  db.prepare(
    'UPDATE sessions SET summary_blob_id = ? WHERE session_id = ?',
  ).run(summary, S);
  insertMemory(db, M, DK_M, [{ source_kind: 'turn', source_id: T_SRC }]);
  insertMemory(db, M2, DK_M2, [{ source_kind: 'memory', source_id: M }]);
  insertMemory(db, M_OTHER, DK_OTHER, [
    { source_kind: 'turn', source_id: T_OTHER },
  ]);
  const title = blob(db, 'candidate_title', 'notification_candidates', 'n-1');
  db.prepare(
    "INSERT INTO notification_candidates (candidate_id, request_entity_id, request_revision, source_revision, kind, notification_key, title_blob_id, excerpt_blob_id, state, closed_at, key_delete_at) VALUES ('n-1', NULL, NULL, NULL, 'mail_reply', 'nk-1', ?, NULL, 'new', NULL, NULL)",
  ).run(title);
  edge(db, 'notification_candidate', 'n-1', 'memory', M);
  db.prepare(
    "INSERT INTO input_snapshots (input_id, request_revision, workflow_id, turn_id, origin, state, seal_reason, input_evidence, policy_version, permission_revision, forgetting_generation, audio_epoch) VALUES ('in-1', 1, NULL, ?, 'typed', 'sealed', 'submitted_text', 'submitted_text', NULL, 0, 0, NULL)",
  ).run(T_INST);
  db.prepare(
    "INSERT INTO intent_shadow (record_id, campaign_id, input_id, request_revision, judgments, recorded_at, expires_at) VALUES ('r-1', 'camp', 'in-1', 1, '{}', 1000, 2000)",
  ).run();
  db.prepare(
    "INSERT INTO turn_responses (turn_id, response_json, created_at, delete_at) VALUES (?, '{}', 1000, 2000)",
  ).run(T_INST);
  const directive = blob(db, 'directive_text', 'user_directives', DIRECTIVE);
  db.prepare(
    "INSERT INTO user_directives (directive_id, text_blob_id, scope, session_id, turn_id, active, created_at) VALUES (?, ?, 'from_now_on', NULL, ?, 1, 1000)",
  ).run(DIRECTIVE, directive, T_INST);
  // 操作: 成功した操作（確定内容を消してよい）、承認済み（進行中）、送出中（送出の境界を越えた進行中）。
  completeOperation(db, OP_DONE);
  ok(db, createCommand(OP_RET));
  ok(db, approveCommand(OP_RET, '1'));
  ok(db, createCommand(OP_DISP));
  ok(db, approveCommand(OP_DISP, '1'));
  ok(db, prepareCommand(OP_DISP, '2', { attempt_id: 'att-disp' }));
  ok(db, dispatchCommand(OP_DISP, '3', 'att-disp'));
  for (const id of [OP_DONE, OP_RET, OP_DISP])
    edge(db, 'operation_content', id, 'memory', M);
}

function lookup(
  hmacs: readonly SourceHmacValue[],
  source: MemorySource,
): string {
  return (
    hmacs.find(
      (item) =>
        item.source_kind === source.source_kind &&
        item.source_id === source.source_id,
    )?.hmac ?? ''
  );
}

// Core がする手順（系譜を読み、鍵の HMAC で計画を作る）を試験の中で行う。
export function planFor(
  db: SqliteDatabase,
  target: MemorySource,
  instruction: string | null,
  hmacs: readonly SourceHmacValue[] = HMACS,
): { graph: ForgetGraph; generation: string; plan: unknown } {
  const read = value<ForgetGraphValue>(
    memoryOp(db, { kind: 'forget.graph', target }),
  );
  const planned = planForget({
    target,
    instruction_turn_id: instruction,
    executing_operation_id: null,
    graph: read.graph,
    sourceHmac: (source) => lookup(hmacs, source),
  });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  return {
    graph: read.graph,
    generation: read.forgetting_generation,
    plan: planned.ok ? planned.plan : null,
  };
}

export function forgetM(
  db: SqliteDatabase,
  beforeCommit?: () => void,
): MemoryOpResult {
  const target: MemorySource = { source_kind: 'memory', source_id: M };
  const { plan, generation } = planFor(db, target, T_INST);
  return memoryOp(
    db,
    {
      kind: 'forget.apply',
      target,
      instruction_turn_id: T_INST,
      plan: plan as never,
      source_hmacs: HMACS,
      entry_id: ENTRY_1,
      previous_generation: generation,
      new_ledger_id: LEDGER_ID,
      now: NOW_1,
    },
    beforeCommit,
  );
}

export function forgetOther(
  db: SqliteDatabase,
  beforeCommit?: () => void,
): MemoryOpResult {
  const target: MemorySource = { source_kind: 'memory', source_id: M_OTHER };
  const { plan, generation } = planFor(db, target, null);
  return memoryOp(
    db,
    {
      kind: 'forget.apply',
      target,
      instruction_turn_id: null,
      plan: plan as never,
      source_hmacs: HMACS,
      entry_id: ENTRY_2,
      previous_generation: generation,
      new_ledger_id: randomUUID(),
      now: NOW_2,
    },
    beforeCommit,
  );
}

export async function withWorld(
  run: (db: SqliteDatabase) => Promise<void> | void,
): Promise<void> {
  await withTempDir(async (dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedWorld(db);
      await run(db);
    } finally {
      db.close();
    }
  });
}
