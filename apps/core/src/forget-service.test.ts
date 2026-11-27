// 記憶の忘却の Core の経路（B06-07b-2、ADR 0180）の試験。計画を作り、本人が確かめた計画だけを実行し、台帳の世代が
// 変わった・系譜が増えた計画は実行せずに取り直させる。忘却の公開ゲート（U112）が閉じている間は何もしない。
// DB は一時ディレクトリに作り、記憶と忘却の命令は同じプロセスで実行する（worker の往復は保存層の試験で確かめている）。
// HMAC は試験用に決めた 64 桁の値を返す関数で、鍵による計算ではない。期待値（計画の件数・消える物・台帳・知らせ）は、
// 下の合成の世界から ADR 0044・0054 の閉包の規則で手で導いた値で、計画の関数から作らない。実機・実データは使わない。
// 消える指示の本文（U433、ADR 0185）は、試験用のデータ鍵で本当に封じた封筒を DB に書き、計画が開いて返すことを確かめる。

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { MemorySource } from '@buddy/domain';
import {
  applyMigrations,
  executeCommand,
  executeMemoryOp,
  initStoreGeneration,
  openWriteConnection,
  sealBlob,
} from '@buddy/storage';
import type {
  DataKeyMaterial,
  MemoryOp,
  MemoryOpResult,
  SqliteDatabase,
} from '@buddy/storage';
import { createForgetRoutes } from './api-forget.js';
import type { ApiRouteHandler } from './api-server.js';
import { sharedApiContract } from './api-test-support.js';
import { createCommand } from './event-test-support.js';
import {
  FORGET_MAX_PENDING_PLANS,
  FORGET_PLAN_TTL_MS,
  FORGET_PUBLIC_GATE_OPEN,
  FORGET_RESULT_RETENTION_MS,
  createForgetService,
} from './forget-service.js';
import type { ForgetService, ForgetServiceOptions } from './forget-service.js';
import type { ForgetLedgerStore } from './forget-ledger.js';
import { RecordingNoticeSink } from './notice-sink.js';
import type { JsonObject } from './strict-json.js';

const STORE_GENERATION = '00000000-0000-4000-8000-0000000000aa';
const S = 'a0000000-0000-4000-8000-000000000001';
const S2 = 'a0000000-0000-4000-8000-000000000002';
const T_SRC = 'b0000000-0000-4000-8000-000000000001';
const T_OTHER = 'b0000000-0000-4000-8000-000000000002';
const M = 'c0000000-0000-4000-8000-000000000001';
const M2 = 'c0000000-0000-4000-8000-000000000002';
const M_OTHER = 'c0000000-0000-4000-8000-000000000003';
const M3 = 'c0000000-0000-4000-8000-000000000004';
const DIRECTIVE = 'd0000000-0000-4000-8000-000000000001';
const OP_WAIT = 'e0000000-0000-4000-8000-000000000001';
// 行のない操作の確定内容（90 日の削除で行が先に消えた）。系譜にだけ残る。
const OP_GONE = 'e0000000-0000-4000-8000-000000000002';
const DEVICE = 'f0000000-0000-4000-8000-000000000001';
const OTHER_DEVICE = 'f0000000-0000-4000-8000-000000000002';
const DK_M = 'd1'.repeat(32);
const DK_M2 = 'd2'.repeat(32);
const DK_OTHER = 'd3'.repeat(32);
const DK_M3 = 'd4'.repeat(32);
// 台帳用の HMAC（試験用に決めた値）。
const HMAC: Readonly<Record<string, string>> = {
  [`turn:${T_SRC}`]: 'b1'.repeat(32),
  [`turn:${T_OTHER}`]: 'b2'.repeat(32),
};
const NOW = Date.parse('2031-02-03T04:05:06.000Z');
const contract = sharedApiContract();
// 試験用のデータ鍵（合成の値。実データの鍵ではない）と、開けないことを確かめる別の鍵。
const KEY: DataKeyMaterial = { keyId: 'data-key-v1', key: Buffer.alloc(32, 7) };
const OTHER_KEY: DataKeyMaterial = {
  keyId: 'data-key-v1',
  key: Buffer.alloc(32, 8),
};
const DIRECTIVE_TEXT = '今後は返信を短めにして';

// 本人の指示の本文の封筒を書く（owner = user_directives・sealedFor・版 0・用途 directive_text で封じ、行の所有者は owner）。
// sealedFor と owner を変えると、別の指示の封筒の差し替えになる。
function directiveBlob(
  db: SqliteDatabase,
  owner: string,
  plaintext: string | Uint8Array,
  options: { readonly key?: DataKeyMaterial; readonly sealedFor?: string } = {},
): string {
  const sealed = sealBlob(
    options.key ?? KEY,
    typeof plaintext === 'string'
      ? new TextEncoder().encode(plaintext)
      : plaintext,
    {
      ownerTable: 'user_directives',
      ownerId: options.sealedFor ?? owner,
      ownerVersion: 0,
      purpose: 'directive_text',
    },
  );
  assert(sealed.ok);
  const id = randomUUID();
  db.prepare(
    "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, 'directive_text', 'user_directives', ?, 0, ?, ?, ?, ?, ?, 1000, NULL)",
  ).run(
    id,
    owner,
    sealed.envelope.formatVersion,
    sealed.envelope.keyId,
    Buffer.from(sealed.envelope.nonce),
    Buffer.from(sealed.envelope.ciphertext),
    Buffer.from(sealed.envelope.tag),
  );
  return id;
}

function insertDirective(
  db: SqliteDatabase,
  directiveId: string,
  textBlobId: string,
  scope: 'this_time' | 'from_now_on' = 'from_now_on',
  turnId: string = T_SRC,
): void {
  db.prepare(
    'INSERT INTO user_directives (directive_id, text_blob_id, scope, session_id, turn_id, active, created_at) VALUES (?, ?, ?, ?, ?, 1, 1000)',
  ).run(
    directiveId,
    textBlobId,
    scope,
    scope === 'this_time' ? S : null,
    turnId,
  );
}

function blob(
  db: SqliteDatabase,
  purpose: string,
  table: string,
  owner: string,
): string {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?, ?, 1000, NULL)',
  ).run(
    id,
    purpose,
    table,
    owner,
    'k-test',
    randomBytes(12),
    randomBytes(24),
    randomBytes(16),
  );
  return id;
}

function insertMemory(
  db: SqliteDatabase,
  memoryId: string,
  dedupe: string,
  source: MemorySource,
): void {
  const text = blob(db, 'memory_text', 'memories', memoryId);
  const key = blob(db, 'memory_target_key', 'memories', memoryId);
  db.prepare(
    "INSERT INTO memories (memory_id, origin, kind, text_blob_id, target_key_blob_id, target_key_hash, dedupe_key, status, created_at, review_at, delete_at) VALUES (?, 'explicit_request', 'preference', ?, ?, ?, ?, 'active', 1000, 9000000000000, NULL)",
  ).run(memoryId, text, key, `${dedupe.slice(0, 62)}ff`, dedupe);
  db.prepare(
    'INSERT INTO memory_sources (memory_id, source_kind, source_id) VALUES (?, ?, ?)',
  ).run(memoryId, source.source_kind, source.source_id);
}

// 合成の世界: 記憶 M（発言 T_SRC から）・M から作った記憶 M2・会話 S の要約（由来の記録なし。S の発言は T_SRC だけ）・
// T_SRC から作った本人の指示・承認待ちの操作 OP_WAIT（確定内容が M から）・行のない操作 OP_GONE（確定内容が M から）・
// 関係のない記憶 M_OTHER（会話 S2 の発言 T_OTHER から）。
function seed(db: SqliteDatabase): void {
  const session = db.prepare(
    "INSERT INTO sessions (session_id, storage_mode, display_device_id, route_revision, summary_blob_id, created_at, ended_at) VALUES (?, 'normal', NULL, 0, NULL, 1000, NULL)",
  );
  session.run(S);
  session.run(S2);
  const turn = db.prepare(
    "INSERT INTO turns (turn_id, session_id, role, input_kind, text_blob_id, created_at, expires_at) VALUES (?, ?, 'user', 'text', ?, 1000, 9999999999999)",
  );
  turn.run(T_SRC, S, blob(db, 'turn_text', 'turns', T_SRC));
  turn.run(T_OTHER, S2, blob(db, 'turn_text', 'turns', T_OTHER));
  db.prepare(
    'UPDATE sessions SET summary_blob_id = ? WHERE session_id = ?',
  ).run(blob(db, 'session_summary', 'sessions', S), S);
  insertMemory(db, M, DK_M, { source_kind: 'turn', source_id: T_SRC });
  insertMemory(db, M2, DK_M2, { source_kind: 'memory', source_id: M });
  insertMemory(db, M_OTHER, DK_OTHER, {
    source_kind: 'turn',
    source_id: T_OTHER,
  });
  insertDirective(db, DIRECTIVE, directiveBlob(db, DIRECTIVE, DIRECTIVE_TEXT));
  const created = executeCommand(db, createCommand(OP_WAIT), {
    now: 1_000_000,
    platform: 'macos',
    storeGeneration: STORE_GENERATION,
  }).outcome;
  assert.equal(created.outcome, 'durable', JSON.stringify(created));
  const edge = db.prepare(
    "INSERT INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at) VALUES ('operation_content', ?, 'memory', ?, 1000)",
  );
  edge.run(OP_WAIT, M);
  edge.run(OP_GONE, M);
}

interface World {
  readonly db: SqliteDatabase;
  readonly dir: string;
  readonly ledgerPath: string;
  readonly store: ForgetLedgerStore;
  readonly applies: { count: number };
  readonly clock: { now: number };
  readonly sink: RecordingNoticeSink;
  readonly gate: { open: boolean };
  // データ鍵を読んだ回数。
  readonly keyReads: { count: number };
  readonly service: ForgetService;
}

function world(
  t: test.TestContext,
  overrides: Partial<ForgetServiceOptions> & {
    readonly applyResult?: (op: MemoryOp) => MemoryOpResult | null;
  } = {},
): World {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-forget-service-'));
  const db = openWriteConnection(join(dir, 'buddy.db'), { platform: 'macos' });
  applyMigrations(db);
  initStoreGeneration(db, STORE_GENERATION);
  seed(db);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const applies = { count: 0 };
  const store = {
    memory: (op: MemoryOp) => {
      if (op.kind === 'forget.apply') applies.count += 1;
      const injected = overrides.applyResult?.(op) ?? null;
      return Promise.resolve(
        injected ??
          executeMemoryOp(db, op, { platform: 'macos', halted: false }).result,
      );
    },
  } as unknown as ForgetLedgerStore;
  const clock = { now: NOW };
  const sink = new RecordingNoticeSink();
  const gate = { open: true };
  const keyReads = { count: 0 };
  let counter = 0;
  const ledgerPath = join(dir, 'forget-ledger.json');
  const service = createForgetService({
    store,
    ledgerPath,
    gate: () => gate.open,
    sourceHmac: () =>
      Promise.resolve(
        (source: MemorySource) =>
          HMAC[`${source.source_kind}:${source.source_id}`] ?? '',
      ),
    dataKey: () => {
      keyReads.count += 1;
      return Promise.resolve(KEY);
    },
    notices: sink,
    now: () => clock.now,
    // 計画・台帳の 1 件・知らせの ID（UUID v4 の形の連番）。
    newId: () => {
      counter += 1;
      return `9a000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
    },
    ...overrides,
  });
  return {
    db,
    dir,
    ledgerPath,
    store,
    applies,
    clock,
    sink,
    gate,
    keyReads,
    service,
  };
}

const count = (db: SqliteDatabase, sql: string, ...args: unknown[]): number =>
  db
    .prepare(sql)
    .pluck()
    .get(...args) as number;

const memories = (db: SqliteDatabase): string[] =>
  db
    .prepare('SELECT memory_id FROM memories ORDER BY memory_id')
    .pluck()
    .all() as string[];

const generation = (db: SqliteDatabase): number =>
  count(
    db,
    'SELECT COALESCE(MAX(forgetting_generation), 0) FROM forget_ledger',
  );

async function planOk(w: World, memoryId = M) {
  const planned = await w.service.plan({
    device_id: DEVICE,
    memory_id: memoryId,
  });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  if (!planned.ok) throw new Error('plan');
  return planned.view;
}

test('the public forget gate is closed in the product build', () => {
  // ゲートを開けるのは忘却の画面（UI-10、#180）の PR だけ（2026-10-31 Q1・U382）。
  assert.equal(FORGET_PUBLIC_GATE_OPEN, false);
});

test('while the gate is closed nothing is planned, nothing is executed and the ledger does not move', async (t) => {
  const w = world(t);
  const view = await planOk(w);
  w.gate.open = false;
  assert.deepEqual(await w.service.plan({ device_id: DEVICE, memory_id: M }), {
    ok: false,
    reason: 'forget_gate_closed',
    reasons: [],
  });
  assert.deepEqual(
    await w.service.execute({
      device_id: DEVICE,
      plan_id: view.plan_id,
      forgetting_generation: '0',
    }),
    { ok: false, reason: 'forget_gate_closed', reasons: [] },
  );
  assert.equal(w.applies.count, 0);
  assert.deepEqual(memories(w.db), [M, M2, M_OTHER]);
  assert.equal(generation(w.db), 0);
  assert.equal(w.sink.notices.length + w.sink.ledgerNotices.length, 0);
});

test('without the ledger key no plan is made (the HMAC would not survive a restore)', async (t) => {
  const w = world(t, { sourceHmac: () => Promise.resolve(null) });
  assert.deepEqual(await w.service.plan({ device_id: DEVICE, memory_id: M }), {
    ok: false,
    reason: 'ledger_key_unavailable',
    reasons: [],
  });
  assert.equal(w.service.pendingPlans(), 0);
});

test('a missing memory is not planned', async (t) => {
  const w = world(t);
  assert.deepEqual(await w.service.plan({ device_id: DEVICE, memory_id: M3 }), {
    ok: false,
    reason: 'target_not_found',
    reasons: [],
  });
});

test('the plan shows what disappears before anything is deleted, then the confirmed plan is applied once', async (t) => {
  const w = world(t);
  const view = await planOk(w);
  assert.deepEqual(view, {
    schema: 'buddy.forget-plan-view.v1',
    plan_id: '9a000000-0000-4000-8000-000000000001',
    target: { source_kind: 'memory', source_id: M },
    forgetting_generation: '0',
    expires_at: '2031-02-03T04:15:06.000Z',
    removed: {
      counts: [
        { kind: 'session_summary', count: 1 },
        { kind: 'memory', count: 2 },
        { kind: 'user_directive', count: 1 },
      ],
      memory_ids: [M, M2],
      // 消える指示は本文と範囲を付けて返す（U433）。
      directives: [
        { directive_id: DIRECTIVE, scope: 'from_now_on', text: DIRECTIVE_TEXT },
      ],
    },
    kept: {
      operations: [{ operation_id: OP_WAIT, state: 'awaiting_approval' }],
      lineage_only: 1,
    },
    blocked_source_count: 1,
  });
  assert(contract.valid('ForgetPlanView', view));
  // 計画の時点では何も消えていない。
  assert.deepEqual(memories(w.db), [M, M2, M_OTHER]);
  assert.equal(
    count(
      w.db,
      'SELECT COUNT(*) FROM user_directives WHERE directive_id = ?',
      DIRECTIVE,
    ),
    1,
  );
  assert.equal(generation(w.db), 0);

  const executed = await w.service.execute({
    device_id: DEVICE,
    plan_id: view.plan_id,
    forgetting_generation: '0',
  });
  assert.equal(executed.ok, true, JSON.stringify(executed));
  if (!executed.ok) return;
  assert.deepEqual(executed.result, {
    schema: 'buddy.forget-execute-result.v1',
    plan_id: view.plan_id,
    forgetting_generation: '1',
  });
  assert(contract.valid('ForgetExecuteResult', executed.result));
  assert.equal(executed.ledger_file, 'written');
  // 消える物だけが消え、由来の発言と関係のない記憶は残る。進行中の操作は状態を変えずに送出禁止の印だけが付く。
  assert.deepEqual(memories(w.db), [M_OTHER]);
  assert.equal(count(w.db, 'SELECT COUNT(*) FROM user_directives'), 0);
  assert.equal(
    count(
      w.db,
      'SELECT COUNT(*) FROM sessions WHERE session_id = ? AND summary_blob_id IS NULL',
      S,
    ),
    1,
  );
  assert.equal(
    count(w.db, 'SELECT COUNT(*) FROM turns WHERE turn_id = ?', T_SRC),
    1,
  );
  assert.deepEqual(
    w.db
      .prepare(
        'SELECT state, state_revision, send_blocked_generation FROM operations WHERE operation_id = ?',
      )
      .get(OP_WAIT),
    {
      state: 'awaiting_approval',
      state_revision: 1,
      send_blocked_generation: 1,
    },
  );
  // 台帳: 消した記憶と、再登録を禁じる発言の HMAC と内容の HMAC。
  const items = w.db
    .prepare(
      'SELECT item_kind, item_id FROM forget_ledger_items ORDER BY item_kind, item_id',
    )
    .all();
  assert.deepEqual(items, [
    { item_kind: 'blocked_content', item_id: DK_M },
    { item_kind: 'blocked_content', item_id: DK_M2 },
    { item_kind: 'blocked_source', item_id: 'b1'.repeat(32) },
    { item_kind: 'memory', item_id: M },
    { item_kind: 'memory', item_id: M2 },
  ]);
  const file = JSON.parse(readFileSync(w.ledgerPath, 'utf8')) as {
    head: { forgetting_generation: string };
  };
  assert.equal(file.head.forgetting_generation, '1');
  // 知らせ: 選んだ記憶は forgotten、そこから作られて消えた記憶は derived_from_forgotten、台帳が進んだ知らせが 1 回。
  assert.deepEqual(
    w.sink.notices.map((notice) => [
      notice.kind,
      notice.reason,
      notice.forgetting_generation,
      notice.items,
    ]),
    [
      ['forgotten', 'forgotten', '1', [{ item_kind: 'memory', item_id: M }]],
      [
        'forgotten',
        'derived_from_forgotten',
        '1',
        [{ item_kind: 'memory', item_id: M2 }],
      ],
    ],
  );
  for (const notice of w.sink.notices)
    assert(contract.valid('RetentionNotice', notice));
  assert.equal(w.sink.ledgerNotices.length, 1);
  const ledgerNotice = w.sink.ledgerNotices[0];
  assert(
    ledgerNotice !== undefined &&
      contract.valid('ForgetLedgerNotice', ledgerNotice),
  );
  assert.equal(ledgerNotice.forgetting_generation, '1');
  assert.equal(ledgerNotice.ledger_id, '9a000000-0000-4000-8000-000000000003');

  // 同じ計画の実行の再送: 同じ結果で、二度は消さない（台帳は 1 件のまま、適用の命令も 1 回）。
  const replay = await w.service.execute({
    device_id: DEVICE,
    plan_id: view.plan_id,
    forgetting_generation: '0',
  });
  assert.deepEqual(replay, {
    ok: true,
    result: executed.result,
    ledger_file: null,
  });
  assert.equal(w.applies.count, 1);
  assert.equal(count(w.db, 'SELECT COUNT(*) FROM forget_ledger'), 1);
  assert.equal(w.sink.ledgerNotices.length, 1);
});

test('two executions of one plan at the same time forget once', async (t) => {
  const w = world(t);
  const view = await planOk(w);
  const request = {
    device_id: DEVICE,
    plan_id: view.plan_id,
    forgetting_generation: '0',
  };
  const [first, second] = await Promise.all([
    w.service.execute(request),
    w.service.execute(request),
  ]);
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(first.result, second.result);
  assert.equal(w.applies.count, 1);
  assert.equal(generation(w.db), 1);
});

test('forgetting the same memory twice: the second plan is not applied and asks to plan again', async (t) => {
  const w = world(t);
  const first = await planOk(w);
  // 同じ端末は計画を 1 件しか持てないので、2 つ目の計画は別の端末が作る。
  const secondPlanned = await w.service.plan({
    device_id: OTHER_DEVICE,
    memory_id: M,
  });
  assert.equal(secondPlanned.ok, true);
  if (!secondPlanned.ok) return;
  const second = secondPlanned.view;
  assert.notEqual(first.plan_id, second.plan_id);
  const done = await w.service.execute({
    device_id: DEVICE,
    plan_id: first.plan_id,
    forgetting_generation: '0',
  });
  assert.equal(done.ok, true);
  const stale = await w.service.execute({
    device_id: OTHER_DEVICE,
    plan_id: second.plan_id,
    forgetting_generation: '0',
  });
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.reason, 'replan_required');
  assert.deepEqual(stale.reasons, ['forgetting_generation_changed']);
  // 取り直しを求めた計画は捨てる。同じ計画をもう一度送っても消さない。
  assert.deepEqual(
    await w.service.execute({
      device_id: OTHER_DEVICE,
      plan_id: second.plan_id,
      forgetting_generation: '0',
    }),
    { ok: false, reason: 'plan_not_found', reasons: [] },
  );
  // 計画を取り直すと、もう対象がない。
  assert.deepEqual(await w.service.plan({ device_id: DEVICE, memory_id: M }), {
    ok: false,
    reason: 'target_not_found',
    reasons: [],
  });
  assert.equal(generation(w.db), 1);
  assert.deepEqual(memories(w.db), [M_OTHER]);
});

test('a derivative made after the plan stops the execution; nothing is deleted until the new plan is confirmed', async (t) => {
  const w = world(t);
  const view = await planOk(w);
  // 計画の後に、M から新しい記憶 M3 が作られた（系譜が増えた）。
  insertMemory(w.db, M3, DK_M3, { source_kind: 'memory', source_id: M });
  const stale = await w.service.execute({
    device_id: DEVICE,
    plan_id: view.plan_id,
    forgetting_generation: '0',
  });
  assert.deepEqual(stale, {
    ok: false,
    reason: 'replan_required',
    reasons: ['forget_plan_stale'],
  });
  assert.deepEqual(memories(w.db), [M, M2, M_OTHER, M3]);
  assert.equal(generation(w.db), 0);
  assert.equal(w.sink.notices.length + w.sink.ledgerNotices.length, 0);
  // 取り直した計画には M3 が出る。確かめてから実行すると M3 も消える。
  const again = await planOk(w);
  assert.deepEqual(again.removed.memory_ids, [M, M2, M3]);
  assert.deepEqual(again.removed.counts, [
    { kind: 'session_summary', count: 1 },
    { kind: 'memory', count: 3 },
    { kind: 'user_directive', count: 1 },
  ]);
  const done = await w.service.execute({
    device_id: DEVICE,
    plan_id: again.plan_id,
    forgetting_generation: '0',
  });
  assert.equal(done.ok, true);
  assert.deepEqual(memories(w.db), [M_OTHER]);
});

test('an unrelated forget between the plan and the execution changes the generation, so the plan is made again', async (t) => {
  const w = world(t);
  const mine = await planOk(w);
  const otherPlanned = await w.service.plan({
    device_id: OTHER_DEVICE,
    memory_id: M_OTHER,
  });
  assert.equal(otherPlanned.ok, true);
  if (!otherPlanned.ok) return;
  const other = otherPlanned.view;
  const otherDone = await w.service.execute({
    device_id: OTHER_DEVICE,
    plan_id: other.plan_id,
    forgetting_generation: '0',
  });
  assert.equal(otherDone.ok, true);
  const stale = await w.service.execute({
    device_id: DEVICE,
    plan_id: mine.plan_id,
    forgetting_generation: '0',
  });
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.reason, 'replan_required');
  assert.deepEqual(memories(w.db), [M, M2]);
  const again = await planOk(w);
  assert.equal(again.forgetting_generation, '1');
  const done = await w.service.execute({
    device_id: DEVICE,
    plan_id: again.plan_id,
    forgetting_generation: '1',
  });
  assert.equal(done.ok, true);
  if (done.ok) assert.equal(done.result.forgetting_generation, '2');
  assert.deepEqual(memories(w.db), []);
});

test('plans are bound to the device, the shown generation and ten minutes', async (t) => {
  const w = world(t);
  assert.equal(FORGET_PLAN_TTL_MS, 600_000);
  const view = await planOk(w);
  assert.deepEqual(
    await w.service.execute({
      device_id: OTHER_DEVICE,
      plan_id: view.plan_id,
      forgetting_generation: '0',
    }),
    { ok: false, reason: 'plan_not_found', reasons: [] },
  );
  assert.deepEqual(
    await w.service.execute({
      device_id: DEVICE,
      plan_id: view.plan_id,
      forgetting_generation: '1',
    }),
    { ok: false, reason: 'generation_mismatch', reasons: [] },
  );
  assert.deepEqual(
    await w.service.execute({
      device_id: DEVICE,
      plan_id: '9a000000-0000-4000-8000-0000000000ff',
      forgetting_generation: '0',
    }),
    { ok: false, reason: 'plan_not_found', reasons: [] },
  );
  // ちょうど 10 分で無効（1 ms 前はまだ有効なことは、別の計画で確かめる）。
  w.clock.now = NOW + FORGET_PLAN_TTL_MS;
  assert.deepEqual(
    await w.service.execute({
      device_id: DEVICE,
      plan_id: view.plan_id,
      forgetting_generation: '0',
    }),
    { ok: false, reason: 'plan_expired', reasons: [] },
  );
  const fresh = await planOk(w);
  w.clock.now = NOW + 2 * FORGET_PLAN_TTL_MS - 1;
  const done = await w.service.execute({
    device_id: DEVICE,
    plan_id: fresh.plan_id,
    forgetting_generation: '0',
  });
  assert.equal(done.ok, true);
  assert.equal(w.applies.count, 1);
});

test('an execution whose commit is uncertain is not sent again and the plan is dropped', async (t) => {
  const w = world(t, {
    applyResult: (op) =>
      op.kind === 'forget.apply'
        ? { ok: false, outcome: 'unknown', reasons: ['commit_failed'] }
        : null,
  });
  const view = await planOk(w);
  assert.deepEqual(
    await w.service.execute({
      device_id: DEVICE,
      plan_id: view.plan_id,
      forgetting_generation: '0',
    }),
    { ok: false, reason: 'outcome_unknown', reasons: ['commit_failed'] },
  );
  assert.deepEqual(
    await w.service.execute({
      device_id: DEVICE,
      plan_id: view.plan_id,
      forgetting_generation: '0',
    }),
    { ok: false, reason: 'plan_not_found', reasons: [] },
  );
  assert.equal(w.applies.count, 1);
  assert.equal(w.sink.notices.length + w.sink.ledgerNotices.length, 0);
});

test('when the ledger file cannot be written the forget still stands and devices read the entry from the DB', async (t) => {
  const w = world(t);
  // 台帳のファイルの置き場所がない（ディレクトリがない）。COMMIT の後に止まったのと同じく、DB だけが進む。
  const broken = createForgetService({
    store: w.store,
    ledgerPath: join(w.dir, 'missing', 'forget-ledger.json'),
    gate: () => true,
    sourceHmac: () =>
      Promise.resolve(
        (source: MemorySource) =>
          HMAC[`${source.source_kind}:${source.source_id}`] ?? '',
      ),
    dataKey: () => Promise.resolve(KEY),
    now: () => NOW,
  });
  const planned = await broken.plan({ device_id: DEVICE, memory_id: M });
  assert(planned.ok);
  const done = await broken.execute({
    device_id: DEVICE,
    plan_id: planned.view.plan_id,
    forgetting_generation: '0',
  });
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.notEqual(done.ledger_file, 'written');
  assert.notEqual(done.ledger_file, null);
  assert.equal(generation(w.db), 1);
  const routes = createForgetRoutes({
    service: broken,
    store: w.store as never,
  });
  const delta = await call(routes.handlers.getForgetLedgerEntries, {
    ledger_id: null,
    forgetting_generation: '0',
    entry_hash: '0'.repeat(64),
  });
  assert.equal(delta.status, 200);
  const body = delta.body as {
    outcome: string;
    entries: { entry: { forgetting_generation: string } }[];
  };
  assert.equal(body.outcome, 'entries');
  assert.deepEqual(
    body.entries.map((link) => link.entry.forgetting_generation),
    ['1'],
  );
});

test('one pending plan per device: a new plan drops the old one, other devices keep theirs', async (t) => {
  const w = world(t);
  const first = await planOk(w);
  const other = await w.service.plan({
    device_id: OTHER_DEVICE,
    memory_id: M,
  });
  assert.equal(other.ok, true);
  if (!other.ok) return;
  assert.equal(w.service.pendingPlans(), 2);
  const second = await planOk(w, M2);
  assert.equal(w.service.pendingPlans(), 2);
  assert.deepEqual(
    await w.service.execute({
      device_id: DEVICE,
      plan_id: first.plan_id,
      forgetting_generation: '0',
    }),
    { ok: false, reason: 'plan_not_found', reasons: [] },
  );
  assert.equal(w.applies.count, 0);
  // 別の端末の計画は残っていて、実行できる。
  const done = await w.service.execute({
    device_id: OTHER_DEVICE,
    plan_id: other.view.plan_id,
    forgetting_generation: '0',
  });
  assert.equal(done.ok, true);
  assert.equal(w.applies.count, 1);
  // 新しい計画（second）はまだ未実行。
  assert.equal(w.service.pendingPlans(), 1);
  assert.notEqual(second.plan_id, first.plan_id);
});

test('a new plan does not drop an executed plan of the same device, and its result is still returned', async (t) => {
  const w = world(t);
  const view = await planOk(w);
  const done = await w.service.execute({
    device_id: DEVICE,
    plan_id: view.plan_id,
    forgetting_generation: '0',
  });
  assert.equal(done.ok, true);
  const next = await planOk(w, M_OTHER);
  assert.notEqual(next.plan_id, view.plan_id);
  const again = await w.service.execute({
    device_id: DEVICE,
    plan_id: view.plan_id,
    forgetting_generation: '0',
  });
  assert.equal(again.ok, true);
  if (!done.ok || !again.ok) return;
  assert.deepEqual(again.result, done.result);
  assert.equal(w.applies.count, 1);
});

test('the number of pending plans is limited to 64: the 64th is made, the 65th is refused without dropping any', async (t) => {
  assert.equal(FORGET_MAX_PENDING_PLANS, 64);
  const w = world(t);
  const deviceOf = (n: number): string =>
    `f1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const plans: string[] = [];
  for (let n = 1; n <= 64; n += 1) {
    const planned = await w.service.plan({
      device_id: deviceOf(n),
      memory_id: M,
    });
    assert.equal(planned.ok, true, `device ${String(n)}`);
    if (planned.ok) plans.push(planned.view.plan_id);
  }
  assert.equal(w.service.pendingPlans(), 64);
  assert.deepEqual(
    await w.service.plan({ device_id: deviceOf(65), memory_id: M }),
    { ok: false, reason: 'too_many_plans', reasons: [] },
  );
  assert.equal(w.service.pendingPlans(), 64);
  // 上限の端末が計画を取り直すのは、自分の古い計画の置き換えなので断らない。
  const replaced = await w.service.plan({
    device_id: deviceOf(1),
    memory_id: M,
  });
  assert.equal(replaced.ok, true);
  assert.equal(w.service.pendingPlans(), 64);
  // 断った 65 番目は何も捨てていない（2 番目の端末の計画は実行できる）。
  const kept = await w.service.execute({
    device_id: deviceOf(2),
    plan_id: plans[1] ?? '',
    forgetting_generation: '0',
  });
  assert.equal(kept.ok, true);
  // 期限が過ぎれば空き、65 番目も作れる。
  w.clock.now = NOW + FORGET_PLAN_TTL_MS;
  assert.equal(w.service.pendingPlans(), 0);
  assert.equal(
    (await w.service.plan({ device_id: deviceOf(65), memory_id: M_OTHER })).ok,
    true,
  );
});

test('an executed plan returns its result before the expiry check and is dropped after the retention time', async (t) => {
  assert.equal(FORGET_RESULT_RETENTION_MS, 600_000);
  const w = world(t);
  const view = await planOk(w);
  const request = {
    device_id: DEVICE,
    plan_id: view.plan_id,
    forgetting_generation: '0',
  };
  const done = await w.service.execute(request);
  assert.equal(done.ok, true);
  if (!done.ok) return;
  // 期限（NOW + 10 分）を 1 ms 過ぎても、結果を持つ計画は同じ結果を返す。二度は消さない。
  w.clock.now = NOW + FORGET_PLAN_TTL_MS + 1;
  const late = await w.service.execute(request);
  assert.equal(late.ok, true);
  if (late.ok) assert.deepEqual(late.result, done.result);
  // 期限の 10 分後の 1 ms 前までは返し、ちょうどで捨てる。
  w.clock.now = NOW + 2 * FORGET_PLAN_TTL_MS - 1;
  assert.equal((await w.service.execute(request)).ok, true);
  w.clock.now = NOW + 2 * FORGET_PLAN_TTL_MS;
  assert.deepEqual(await w.service.execute(request), {
    ok: false,
    reason: 'plan_not_found',
    reasons: [],
  });
  assert.equal(w.applies.count, 1);
  // 結果を持たない計画は、期限で 410 相当の plan_expired のまま。
  const fresh = await planOk(w, M_OTHER);
  w.clock.now += FORGET_PLAN_TTL_MS;
  assert.deepEqual(
    await w.service.execute({ ...request, plan_id: fresh.plan_id }),
    { ok: false, reason: 'plan_expired', reasons: [] },
  );
});

// --- 経路の処理（形式・認可の検査は api-server と契約の api-cases が受け持つ） ---

function request(
  body: JsonObject,
  params: Record<string, string> = {},
  device: string | null = DEVICE,
): Parameters<ApiRouteHandler>[0] {
  return {
    route: null as never,
    device: device === null ? null : ({ device_id: device } as never),
    body,
    params,
    remoteAddress: '127.0.0.1',
    query: {},
    declaredLockState: null,
  };
}

const call = (
  handler: ApiRouteHandler,
  body: JsonObject,
  params: Record<string, string> = {},
) => handler(request(body, params));

test('the routes answer 503 while the gate is closed and map stale plans to 409', async (t) => {
  const w = world(t);
  const routes = createForgetRoutes({
    service: w.service,
    store: w.store as never,
  });
  const scope = '00000000-0000-4000-8000-000000009002';
  w.gate.open = false;
  const closed = await call(routes.handlers.createForgetPlan, {
    request_id: '00000000-0000-4000-8000-0000000f0101',
    command_scope_id: scope,
    memory_id: M,
  });
  assert.deepEqual(closed, {
    status: 503,
    body: {
      code: 'dependency_unavailable',
      message: (closed.body as { message: string }).message,
      request_id: '00000000-0000-4000-8000-0000000f0101',
    },
  });
  w.gate.open = true;
  const missing = await call(routes.handlers.createForgetPlan, {
    request_id: '00000000-0000-4000-8000-0000000f0102',
    command_scope_id: scope,
    memory_id: M3,
  });
  assert.equal(missing.status, 409);
  const planned = await call(routes.handlers.createForgetPlan, {
    request_id: '00000000-0000-4000-8000-0000000f0103',
    command_scope_id: scope,
    memory_id: M,
  });
  assert.equal(planned.status, 200);
  assert(contract.valid('ForgetPlanView', planned.body));
  const planId = (planned.body as { plan_id: string }).plan_id;
  const wrong = await call(
    routes.handlers.executeForgetPlan,
    {
      request_id: '00000000-0000-4000-8000-0000000f0104',
      command_scope_id: scope,
      forgetting_generation: '5',
    },
    { plan_id: planId },
  );
  assert.equal(wrong.status, 409);
  assert.deepEqual(memories(w.db), [M, M2, M_OTHER]);
  const done = await call(
    routes.handlers.executeForgetPlan,
    {
      request_id: '00000000-0000-4000-8000-0000000f0105',
      command_scope_id: scope,
      forgetting_generation: '0',
    },
    { plan_id: planId },
  );
  assert.equal(done.status, 200);
  assert(contract.valid('ForgetExecuteResult', done.body));
  assert.deepEqual(memories(w.db), [M_OTHER]);
});

test('the ledger route returns the continuation, a divergence or a replica ahead without rewinding', async (t) => {
  const w = world(t);
  const routes = createForgetRoutes({
    service: w.service,
    store: w.store as never,
  });
  const sync = (body: JsonObject) =>
    call(routes.handlers.getForgetLedgerEntries, body);
  const ZERO = '0'.repeat(64);
  // 台帳が空: 系譜なし・世代 0。
  const empty = await sync({
    ledger_id: null,
    forgetting_generation: '0',
    entry_hash: ZERO,
  });
  assert.deepEqual(empty, {
    status: 200,
    body: {
      schema: 'buddy.forget-ledger-delta.v1',
      outcome: 'entries',
      ledger_id: null,
      head: { forgetting_generation: '0', entry_hash: ZERO },
      entries: [],
      has_more: false,
    },
  });
  // 2 回忘れる（世代 1・2）。
  for (const memoryId of [M_OTHER, M]) {
    const view = await planOk(w, memoryId);
    const done = await w.service.execute({
      device_id: DEVICE,
      plan_id: view.plan_id,
      forgetting_generation: view.forgetting_generation,
    });
    assert.equal(done.ok, true);
  }
  const all = await sync({
    ledger_id: null,
    forgetting_generation: '0',
    entry_hash: ZERO,
  });
  assert.equal(all.status, 200);
  assert(contract.valid('ForgetLedgerDelta', all.body));
  const full = all.body as {
    ledger_id: string;
    head: { forgetting_generation: string; entry_hash: string };
    entries: {
      entry: { forgetting_generation: string };
      previous_hash: string;
      entry_hash: string;
    }[];
  };
  assert.deepEqual(
    full.entries.map((link) => link.entry.forgetting_generation),
    ['1', '2'],
  );
  const [first, second] = full.entries;
  assert(first !== undefined && second !== undefined);
  assert.equal(first.previous_hash, ZERO);
  assert.equal(second.previous_hash, first.entry_hash);
  assert.deepEqual(full.head, {
    forgetting_generation: '2',
    entry_hash: second.entry_hash,
  });
  // 本文・生の元サービス ID・HMAC の鍵は配信に出ない（試験の世界の本文の暗号文は乱数で、ID と HMAC だけが出る）。
  assert(!JSON.stringify(full).includes('text'));
  // 世代 1 を持つ端末には世代 2 だけ。追いついた端末には何も返さない。
  const after1 = await sync({
    ledger_id: full.ledger_id,
    forgetting_generation: '1',
    entry_hash: first.entry_hash,
  });
  assert.deepEqual(
    (after1.body as typeof full).entries.map(
      (link) => link.entry.forgetting_generation,
    ),
    ['2'],
  );
  const caughtUp = await sync({
    ledger_id: full.ledger_id,
    forgetting_generation: '2',
    entry_hash: second.entry_hash,
  });
  assert.deepEqual((caughtUp.body as typeof full).entries, []);
  // hash が食い違う・系譜が違う複製は diverged、中枢より進んだ複製は replica_ahead（どちらも項目を返さない）。
  for (const [body, outcome] of [
    [
      {
        ledger_id: full.ledger_id,
        forgetting_generation: '1',
        entry_hash: 'ab'.repeat(32),
      },
      'diverged',
    ],
    [
      {
        ledger_id: '00000000-0000-4000-8000-00000000abcd',
        forgetting_generation: '1',
        entry_hash: first.entry_hash,
      },
      'diverged',
    ],
    [
      {
        ledger_id: full.ledger_id,
        forgetting_generation: '3',
        entry_hash: 'ab'.repeat(32),
      },
      'replica_ahead',
    ],
  ] as const) {
    const response = await sync(body);
    assert.equal(response.status, 200);
    assert(contract.valid('ForgetLedgerDelta', response.body));
    const got = response.body as { outcome: string; entries: unknown[] };
    assert.equal(got.outcome, outcome, JSON.stringify(body));
    assert.deepEqual(got.entries, []);
  }
});

test('uncertain outcomes, refusals and capacity map to distinct HTTP answers', async (t) => {
  const scope = '00000000-0000-4000-8000-000000009002';
  const planBody = {
    request_id: '00000000-0000-4000-8000-0000000f0201',
    command_scope_id: scope,
    memory_id: M,
  };
  const executeBody = {
    request_id: '00000000-0000-4000-8000-0000000f0202',
    command_scope_id: scope,
    forgetting_generation: '0',
  };
  // 成否不明: 503 outcome_unknown（dependency_unavailable と分ける）。計画は残っておらず、再試行は 409。
  const unknown = world(t, {
    applyResult: (op) =>
      op.kind === 'forget.apply'
        ? { ok: false, outcome: 'unknown', reasons: ['commit_failed'] }
        : null,
  });
  const unknownRoutes = createForgetRoutes({
    service: unknown.service,
    store: unknown.store as never,
  });
  const planned = await call(unknownRoutes.handlers.createForgetPlan, planBody);
  const planId = (planned.body as { plan_id: string }).plan_id;
  const lost = await call(
    unknownRoutes.handlers.executeForgetPlan,
    executeBody,
    { plan_id: planId },
  );
  assert.equal(lost.status, 503);
  assert.equal((lost.body as { code: string }).code, 'outcome_unknown');
  assert.equal(
    (lost.body as { request_id: string }).request_id,
    executeBody.request_id,
  );
  assert(contract.valid('ApiError', lost.body));
  const retry = await call(
    unknownRoutes.handlers.executeForgetPlan,
    executeBody,
    {
      plan_id: planId,
    },
  );
  assert.equal(retry.status, 409);
  assert.equal((retry.body as { code: string }).code, 'conflict');
  // 計画の照合以外の拒否（何も消していない）は、成否不明と分けて 503 dependency_unavailable。
  const rejected = world(t, {
    applyResult: (op) =>
      op.kind === 'forget.apply'
        ? { ok: false, outcome: 'rejected', reasons: ['something_else'] }
        : null,
  });
  const rejectedRoutes = createForgetRoutes({
    service: rejected.service,
    store: rejected.store as never,
  });
  const rejectedPlan = await call(
    rejectedRoutes.handlers.createForgetPlan,
    planBody,
  );
  const refused = await call(
    rejectedRoutes.handlers.executeForgetPlan,
    executeBody,
    { plan_id: (rejectedPlan.body as { plan_id: string }).plan_id },
  );
  assert.equal(refused.status, 503);
  assert.equal(
    (refused.body as { code: string }).code,
    'dependency_unavailable',
  );
  // 台帳の鍵がない: 503 dependency_unavailable。
  const keyless = world(t, { sourceHmac: () => Promise.resolve(null) });
  const keylessRoutes = createForgetRoutes({
    service: keyless.service,
    store: keyless.store as never,
  });
  const noKey = await call(keylessRoutes.handlers.createForgetPlan, planBody);
  assert.equal(noKey.status, 503);
  assert.equal((noKey.body as { code: string }).code, 'dependency_unavailable');
  // 計画の上限と、一覧の大きすぎる計画（サービスの結果を直接返す代役）。
  for (const reason of ['plan_too_large', 'too_many_plans'] as const) {
    const stub = createForgetRoutes({
      service: {
        plan: () => Promise.resolve({ ok: false, reason, reasons: [] }),
        execute: () =>
          Promise.resolve({
            ok: false,
            reason: 'forget_gate_closed',
            reasons: [],
          }),
      },
      store: unknown.store as never,
    });
    const answer = await call(stub.handlers.createForgetPlan, planBody);
    assert.equal(answer.status, 503, reason);
    assert.equal(
      (answer.body as { code: string }).code,
      'dependency_unavailable',
    );
    const closed = await call(stub.handlers.executeForgetPlan, executeBody, {
      plan_id: planId,
    });
    assert.equal(closed.status, 503);
  }
});

// ---- 消える指示の本文（U433、ADR 0185） ----

const D_200 = 'd0000000-0000-4000-8000-000000000002';
const D_EMOJI = 'd0000000-0000-4000-8000-000000000003';
const D_201 = 'd0000000-0000-4000-8000-000000000004';
const D_WRONG_KEY = 'd0000000-0000-4000-8000-000000000005';
const D_SWAPPED = 'd0000000-0000-4000-8000-000000000006';
const D_EMPTY = 'd0000000-0000-4000-8000-000000000007';
const D_BAD_UTF8 = 'd0000000-0000-4000-8000-000000000008';
const D_NO_ENVELOPE = 'd0000000-0000-4000-8000-000000000009';
const D_UNRELATED = 'd0000000-0000-4000-8000-00000000000a';

test('the plan shows the text of each disappearing directive and keeps an unreadable one in the plan', async (t) => {
  const w = world(t);
  // 記憶 M の元の発言 T_SRC から作った指示を足す（どれも M と一緒に消える）。T_OTHER から作った指示は消えない。
  insertDirective(
    w.db,
    D_200,
    directiveBlob(w.db, D_200, 'い'.repeat(200)),
    'this_time',
  );
  // 200 文字は UTF-16 では 400 単位（文字数はコードポイントで数える）。
  insertDirective(
    w.db,
    D_EMOJI,
    directiveBlob(w.db, D_EMOJI, '👍'.repeat(200)),
  );
  insertDirective(w.db, D_201, directiveBlob(w.db, D_201, 'う'.repeat(201)));
  insertDirective(
    w.db,
    D_WRONG_KEY,
    directiveBlob(w.db, D_WRONG_KEY, '別の鍵で封じた指示', { key: OTHER_KEY }),
  );
  // 別の指示（DIRECTIVE）のために封じた封筒を、この指示の行に差し替えた。
  insertDirective(
    w.db,
    D_SWAPPED,
    directiveBlob(w.db, D_SWAPPED, '差し替えた指示', { sealedFor: DIRECTIVE }),
  );
  insertDirective(w.db, D_EMPTY, directiveBlob(w.db, D_EMPTY, ''));
  insertDirective(
    w.db,
    D_BAD_UTF8,
    directiveBlob(w.db, D_BAD_UTF8, new Uint8Array([0xe3, 0x81])),
  );
  // 封筒の行はあるが、所有者が別の ID（この指示の封筒として読めない）。
  insertDirective(
    w.db,
    D_NO_ENVELOPE,
    directiveBlob(w.db, 'd0000000-0000-4000-8000-0000000000ff', '迷子の封筒'),
  );
  insertDirective(
    w.db,
    D_UNRELATED,
    directiveBlob(w.db, D_UNRELATED, '関係のない指示'),
    'from_now_on',
    T_OTHER,
  );
  const view = await planOk(w);
  assert.deepEqual(view.removed.counts, [
    { kind: 'session_summary', count: 1 },
    { kind: 'memory', count: 2 },
    { kind: 'user_directive', count: 9 },
  ]);
  assert.deepEqual(view.removed.directives, [
    { directive_id: DIRECTIVE, scope: 'from_now_on', text: DIRECTIVE_TEXT },
    { directive_id: D_200, scope: 'this_time', text: 'い'.repeat(200) },
    { directive_id: D_EMOJI, scope: 'from_now_on', text: '👍'.repeat(200) },
    { directive_id: D_201, scope: 'from_now_on', text: null },
    { directive_id: D_WRONG_KEY, scope: 'from_now_on', text: null },
    { directive_id: D_SWAPPED, scope: 'from_now_on', text: null },
    { directive_id: D_EMPTY, scope: 'from_now_on', text: null },
    { directive_id: D_BAD_UTF8, scope: 'from_now_on', text: null },
    { directive_id: D_NO_ENVELOPE, scope: 'from_now_on', text: null },
  ]);
  assert(contract.valid('ForgetPlanView', view));
  // 消えない指示の本文・元の発言の ID・台帳の HMAC は計画に出ない。
  const text = JSON.stringify(view);
  for (const hidden of ['関係のない指示', T_SRC, T_OTHER, 'b1'.repeat(32)])
    assert(!text.includes(hidden), hidden);
  assert.equal(w.keyReads.count, 1);
  // 読めない指示も、見せたとおりに一緒に消える（計画から外していない）。
  const executed = await w.service.execute({
    device_id: DEVICE,
    plan_id: view.plan_id,
    forgetting_generation: '0',
  });
  assert.equal(executed.ok, true, JSON.stringify(executed));
  assert.deepEqual(
    w.db
      .prepare('SELECT directive_id FROM user_directives ORDER BY directive_id')
      .pluck()
      .all(),
    [D_UNRELATED],
  );
});

test('a plan with disappearing directives needs the data key; a plan without them does not read it', async (t) => {
  const holder: { key: DataKeyMaterial | null | 'throw' } = { key: KEY };
  let reads = 0;
  const w = world(t, {
    dataKey: () => {
      reads += 1;
      if (holder.key === 'throw')
        return Promise.reject(new Error('key store failed'));
      return Promise.resolve(holder.key);
    },
  });
  // 消える指示のない記憶（M_OTHER）は、データ鍵を読まずに計画を作る。
  const other = await w.service.plan({
    device_id: OTHER_DEVICE,
    memory_id: M_OTHER,
  });
  assert(other.ok);
  assert.deepEqual(other.view.removed.directives, []);
  assert.equal(reads, 0);
  const first = await planOk(w);
  assert.equal(reads, 1);
  // 鍵がない・読めないときは計画を作らず、同じ端末の前の計画も捨てない。
  for (const key of [null, 'throw'] as const) {
    holder.key = key;
    assert.deepEqual(
      await w.service.plan({ device_id: DEVICE, memory_id: M }),
      { ok: false, reason: 'directive_text_unavailable', reasons: [] },
      String(key),
    );
  }
  assert.equal(reads, 3);
  assert.equal(w.service.pendingPlans(), 2);
  const routes = createForgetRoutes({
    service: w.service,
    store: w.store as never,
  });
  const refused = await call(routes.handlers.createForgetPlan, {
    request_id: '00000000-0000-4000-8000-0000000f0301',
    command_scope_id: '00000000-0000-4000-8000-000000009002',
    memory_id: M,
  });
  assert.equal(refused.status, 503);
  assert.equal(
    (refused.body as { code: string }).code,
    'dependency_unavailable',
  );
  assert(contract.valid('ApiError', refused.body));
  // 前の計画（本文を見せた計画）は、そのまま実行できる。
  const executed = await w.service.execute({
    device_id: DEVICE,
    plan_id: first.plan_id,
    forgetting_generation: '0',
  });
  assert.equal(executed.ok, true, JSON.stringify(executed));
  assert.equal(w.applies.count, 1);
});
