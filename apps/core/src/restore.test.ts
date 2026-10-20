// 再起動の後の復元と起動時の回復、鍵の照合値・状態ファイルの移行・DB の拒否（ADR 0019）。
// - 同じプロセス内の startCore: Core の DB worker で操作を作って進め、停止・再起動して照会する。
// - 子プロセスの dist/cli.js: 停止中に DB へ操作を置き、起動（回復）→ 強制終了 → 再起動して照会する。
// 期待値（状態・state_revision・理由コード・H01 の hash）は手で書いた値。H01 は設計 08 §2 の値。
// 鍵は模擬の KeyStore だけで、実機のキーチェーンに触れない。DB は一時ディレクトリに作って消す。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMockKeyStore } from '@buddy/platform';
import type { KeyStore } from '@buddy/platform';
import {
  applyMigrations,
  executeCommand,
  listOutboxEvents,
  openOperationIntent,
  openWriteConnection,
  readCommandReceipt,
  readConnectionSql,
  readOperation,
  readStoreGeneration,
  sealOperationIntent,
  storagePlatform,
} from '@buddy/storage';
import type {
  CreateOperationCommand,
  DataKeyMaterial,
  DbCommand,
  DispatchIntentCommand,
  DispatchPermit,
  PrepareOperationCommand,
  RecordResultCommand,
  ResultState,
  SqliteDatabase,
} from '@buddy/storage';
import { CoreStartError, startCore } from './core.js';
import type { CoreHandle, StartCoreOptions } from './core.js';
import { MOCK_DATA_KEY_SEED } from './preflight.js';

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));
const TIMEOUT_MS = 20_000;
// 設計 08 §2 の H01 の期待値（手で写した値）。
const H01_SHA256 =
  '72c8a8c172bda32f8df7933dca1c490198a0f3670ce03adc40445d55a68b00bf';
const h01 = JSON.parse(
  await readFile(
    new URL('../../../packages/contracts/fixtures/h01.json', import.meta.url),
    'utf8',
  ),
) as { intent: Record<string, unknown>; expected_sha256: string };
const H01_OPERATION = String(h01.intent['operation_id']);
const LEGACY = '0b6f7f1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER_GENERATION = '7d4e2a10-5b6c-4d8e-9f01-a2b3c4d5e6f7';

// 合成の鍵（値に意味はない）。
const KEY_A = Buffer.alloc(32, 0x41);
const KEY_B = Buffer.alloc(32, 0x42);
const keyStoreOf = (key: Buffer): KeyStore =>
  createMockKeyStore({ stored: key.toString('base64') });
const materialOf = (key: Buffer): DataKeyMaterial => ({
  keyId: 'data-key-v1',
  key,
});

async function tempDataDir(t: test.TestContext): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'buddy-restore-'));
  t.after(() =>
    rm(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch(() => undefined),
  );
  return join(base, 'data');
}

async function start(
  t: test.TestContext,
  dataDir: string,
  options: Partial<StartCoreOptions> = {},
): Promise<CoreHandle> {
  const handle = await startCore({
    dataDir,
    keyStore: keyStoreOf(KEY_A),
    shutdownGraceMs: 200,
    probeTimeoutMs: 300,
    ...options,
  });
  t.after(async () => {
    await handle.stop('test').catch(() => undefined);
  });
  return handle;
}

async function refusal(
  run: Promise<CoreHandle>,
): Promise<{ code: string; reasons: readonly string[] }> {
  let handle: CoreHandle;
  try {
    handle = await run;
  } catch (error) {
    assert(error instanceof CoreStartError, String(error));
    return { code: error.code, reasons: error.reasons };
  }
  // 起動してしまった Core は止めてから失敗にする（試験の後に残さない）。
  await handle.stop('test').catch(() => undefined);
  assert.fail('起動が拒否されませんでした');
}

// --- 合成の命令（接続のない LocalCommand。方針の自動承認で approved から始める） ---

const base = (operationId: string, expected: string) => ({
  command_id: randomUUID(),
  operation_id: operationId,
  expected_state_revision: expected,
  request_revision: null,
  permission_revision: '0',
  forgetting_generation: '0',
  connection_id: null,
  request: null,
});

function intentFor(operationId: string): Record<string, unknown> {
  return { ...h01.intent, operation_id: operationId };
}

function createCommand(
  key: DataKeyMaterial,
  operationId: string,
): CreateOperationCommand {
  const sealed = sealOperationIntent(
    key,
    { operationId, contentVersion: 1 },
    intentFor(operationId),
  );
  assert(sealed.ok);
  return {
    ...base(operationId, '0'),
    kind: 'operation.create',
    workflow_id: null,
    operation_kind: 'synthetic.local_change',
    effect_route: 'local_command',
    content_hash: sealed.content_hash,
    intent: sealed.intent,
    auto_approval: {
      approval_id: randomUUID(),
      policy_version: '3',
      current_policy_version: '3',
    },
  };
}

const prepareCommand = (
  operationId: string,
  expected: string,
): PrepareOperationCommand => ({
  ...base(operationId, expected),
  kind: 'operation.prepare',
  attempt_id: randomUUID(),
});

const dispatchCommand = (
  operationId: string,
  expected: string,
  attemptId: string,
): DispatchIntentCommand => ({
  ...base(operationId, expected),
  kind: 'operation.dispatch_intent',
  attempt_id: attemptId,
  reservation_id: null,
});

const resultCommand = (
  operationId: string,
  expected: string,
  attemptId: string,
  to: ResultState,
): RecordResultCommand => ({
  ...base(operationId, expected),
  kind: 'operation.record_result',
  attempt_id: attemptId,
  to,
  external_id: null,
});

// 作成（1・approved）→ 準備（2）→ 送出意図（3）→ 照合中（4）→ 成功（5）の命令列。
function plan(
  key: DataKeyMaterial,
  operationId: string,
  until: 'approved' | 'preparing' | 'dispatching' | 'succeeded',
): DbCommand[] {
  const commands: DbCommand[] = [createCommand(key, operationId)];
  if (until === 'approved') return commands;
  const prepare = prepareCommand(operationId, '1');
  commands.push(prepare);
  if (until === 'preparing') return commands;
  commands.push(dispatchCommand(operationId, '2', prepare.attempt_id));
  if (until === 'dispatching') return commands;
  commands.push(
    resultCommand(operationId, '3', prepare.attempt_id, 'reconciling'),
    resultCommand(operationId, '4', prepare.attempt_id, 'succeeded'),
  );
  return commands;
}

test(
  'a restart restores the same IDs, versions, approvals, receipts and generation, and holds dispatching',
  { timeout: 60_000 },
  async (t) => {
    const dataDir = await tempDataDir(t);
    const key = materialOf(KEY_A);
    const first = await start(t, dataDir);
    assert.equal(first.storeGenerationSource, 'created');
    assert.equal(first.dataKeyCheck, 'stored');
    assert.equal(first.schemaVersion, 2);
    assert.deepEqual(first.recovery, { held: [], resumable: [] });

    const plans: Record<string, DbCommand[]> = {
      [H01_OPERATION]: plan(key, H01_OPERATION, 'dispatching'),
      'op-preparing': plan(key, 'op-preparing', 'preparing'),
      'op-succeeded': plan(key, 'op-succeeded', 'succeeded'),
      'op-approved': plan(key, 'op-approved', 'approved'),
    };
    let permit: DispatchPermit | null = null;
    for (const commands of Object.values(plans))
      for (const command of commands) {
        const outcome = await first.store.submit(command).result;
        assert.equal(outcome.outcome, 'durable', JSON.stringify(outcome));
        if (outcome.outcome === 'durable' && outcome.dispatch_permit)
          permit = outcome.dispatch_permit;
      }
    assert(permit, '送出意図の許可');
    const before = new Map<string, unknown>();
    for (const id of Object.keys(plans))
      before.set(
        id,
        await first.store.query({ kind: 'operation', operation_id: id }),
      );
    const receiptsBefore = new Map<string, unknown>();
    for (const command of Object.values(plans).flat())
      receiptsBefore.set(
        command.command_id,
        await first.store.query({
          kind: 'command',
          command_id: command.command_id,
        }),
      );
    const eventsBefore = await first.store.query({
      kind: 'events',
      after_sequence: 0,
      limit: 100,
    });
    assert.equal(eventsBefore.length, 1 + 3 + 2 + 5);
    await first.stop('test');
    // 停止した Core の許可は使えない（送出の直前に止まった。自動では送らない）。
    assert.equal(first.store.consumeDispatchPermit(permit), false);

    const second = await start(t, dataDir);
    assert.notEqual(second.coreInstanceId, first.coreInstanceId);
    assert.equal(second.storeGeneration, first.storeGeneration);
    assert.equal(second.storeGenerationSource, 'database');
    assert.equal(second.dataKeyCheck, 'matched');
    // dispatching は unknown_held へ回し、preparing は残す（参照確認からの再開は B04）。
    assert.deepEqual(second.recovery, {
      held: [H01_OPERATION],
      resumable: ['op-preparing'],
    });
    for (const id of ['op-preparing', 'op-succeeded', 'op-approved'])
      assert.deepEqual(
        await second.store.query({ kind: 'operation', operation_id: id }),
        before.get(id),
        id,
      );
    const held = await second.store.query({
      kind: 'operation',
      operation_id: H01_OPERATION,
    });
    const heldBefore = before.get(H01_OPERATION) as NonNullable<typeof held>;
    assert(held);
    assert.equal(held.state, 'unknown_held');
    assert.equal(heldBefore.state_revision, '3');
    assert.equal(held.state_revision, '4');
    assert.equal(held.current_content_version, '1');
    // 承認ハッシュ: 内容版の hash は H01 の独立した期待値と一致し、再起動の前後で変わらない。
    assert.equal(held.content_hash, H01_SHA256);
    assert.equal(heldBefore.content_hash, H01_SHA256);
    assert.deepEqual(held.approvals, heldBefore.approvals);
    assert.equal(held.approvals[0]?.status, 'valid');
    assert.deepEqual(
      held.attempts.map((attempt) => [
        attempt.attempt_id,
        attempt.status,
        attempt.result_status,
        attempt.dispatch_intent_at,
      ]),
      heldBefore.attempts.map((attempt) => [
        attempt.attempt_id,
        'unknown_held',
        'unknown',
        attempt.dispatch_intent_at,
      ]),
    );
    for (const [commandId, receipt] of receiptsBefore)
      assert.deepEqual(
        await second.store.query({ kind: 'command', command_id: commandId }),
        receipt,
      );
    const events = await second.store.query({
      kind: 'events',
      after_sequence: 0,
      limit: 100,
    });
    assert.deepEqual(events.slice(0, eventsBefore.length), eventsBefore);
    assert.deepEqual(
      events
        .slice(eventsBefore.length)
        .map((event) => [
          event.target_id,
          event.state_revision,
          event.store_generation,
        ]),
      [[H01_OPERATION, '4', first.storeGeneration]],
    );
    // 古い許可は新しい世代では使えず、同じ送出意図の命令を送り直しても許可は出ない。
    assert.equal(second.store.isDispatchPermitCurrent(permit), false);
    const dispatch = plans[H01_OPERATION]?.[2] as DispatchIntentCommand;
    const replay = await second.store.submit(dispatch).result;
    assert.equal(replay.outcome, 'durable');
    assert.equal(replay.outcome === 'durable' && replay.replayed, true);
    assert.equal(
      replay.outcome === 'durable' ? replay.dispatch_permit : 'x',
      null,
    );
    await second.stop('test');

    // 三度目の起動では回復するものがない（回復は一度だけ記録される）。
    const third = await start(t, dataDir);
    assert.deepEqual(third.recovery, { held: [], resumable: ['op-preparing'] });
    assert.equal(third.storeGeneration, first.storeGeneration);
    await third.stop('test');

    // 停止中の DB の確定 intent は同じ鍵で復号でき、保存した hash と一致する。
    const db = openWriteConnection(join(dataDir, 'buddy.sqlite'), {
      platform: storagePlatform(),
    });
    try {
      const row = db
        .prepare(
          'SELECT b.format_version, b.key_id, b.nonce, b.ciphertext, b.tag, v.content_hash FROM operation_versions v JOIN sealed_blobs b ON b.blob_id = v.intent_blob_id WHERE v.operation_id = ? AND v.content_version = 1',
        )
        .get(H01_OPERATION) as {
        format_version: number;
        key_id: string;
        nonce: Buffer;
        ciphertext: Buffer;
        tag: Buffer;
        content_hash: string;
      };
      const opened = openOperationIntent(
        key,
        { operationId: H01_OPERATION, contentVersion: 1 },
        {
          formatVersion: row.format_version,
          keyId: row.key_id,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
          tag: row.tag,
        },
        row.content_hash,
      );
      assert.equal(opened.ok && opened.content_hash, H01_SHA256);
    } finally {
      db.close();
    }
  },
);

test('a different data key, a missing key after the lock, and a key replaced before the lock are handled', async (t) => {
  const dataDir = await tempDataDir(t);
  const first = await start(t, dataDir);
  const generation = first.storeGeneration;
  await first.stop('test');
  // DB を作った鍵と違う鍵では書込みを始めない（ロックも返す）。
  assert.deepEqual(
    await refusal(
      startCore({ dataDir, keyStore: keyStoreOf(KEY_B), probeTimeoutMs: 300 }),
    ),
    { code: 'data_key_mismatch', reasons: ['data_key_check_mismatch'] },
  );
  // ロックの後の読み直しで鍵がない（作成しない）。
  assert.deepEqual(
    await refusal(
      startCore({
        dataDir,
        keyStore: createMockKeyStore(),
        probeTimeoutMs: 300,
      }),
    ),
    {
      code: 'data_key_unavailable',
      reasons: ['data_key_unavailable:data_key_missing'],
    },
  );
  assert.deepEqual((await readdir(dataDir)).sort(), ['buddy.sqlite']);
  const again = await start(t, dataDir);
  assert.equal(again.storeGeneration, generation);
  assert.equal(again.dataKeyCheck, 'matched');
  await again.stop('test');

  // 初回の起動前検査で作った鍵（A）が、ロックの前に別の Core の鍵（B）で上書きされた場合:
  // ロックの後に読み直した鍵（B）だけを使い、DB の照合値は B になる。以後 A では書込みを始めない。
  const raceDir = await tempDataDir(t);
  let current = KEY_A;
  const raced: KeyStore = {
    kind: 'mock',
    backend: 'mock',
    loadOrCreateDataKey: async () => {
      const result = await keyStoreOf(current).loadDataKey();
      current = KEY_B;
      return result;
    },
    loadDataKey: () => keyStoreOf(current).loadDataKey(),
  };
  const racedCore = await start(t, raceDir, {
    keyStore: raced,
    preflight: [
      async () => {
        const result = await raced.loadOrCreateDataKey();
        return result.ok ? [] : ['key_protection_unavailable'];
      },
    ],
  });
  assert.equal(racedCore.dataKeyCheck, 'stored');
  await racedCore.stop('test');
  const withB = await start(t, raceDir, { keyStore: keyStoreOf(KEY_B) });
  assert.equal(withB.dataKeyCheck, 'matched');
  await withB.stop('test');
  assert.equal(
    (
      await refusal(
        startCore({
          dataDir: raceDir,
          keyStore: keyStoreOf(KEY_A),
          probeTimeoutMs: 300,
        }),
      )
    ).code,
    'data_key_mismatch',
  );
});

test('the B01 state file generation moves into the DB once and a conflicting state file is refused', async (t) => {
  const dataDir = await tempDataDir(t);
  await mkdir(dataDir, { recursive: true });
  const stateFile = join(dataDir, 'core-state.json');
  await writeFile(
    stateFile,
    `${JSON.stringify({ store_generation: LEGACY, created_at: '2026-10-20T00:00:00.000Z' })}\n`,
  );
  const first = await start(t, dataDir);
  assert.equal(first.storeGeneration, LEGACY);
  assert.equal(first.storeGenerationSource, 'state_file');
  assert.equal(first.status().store_generation, LEGACY);
  // 移した後の状態ファイルは消す（DB を作り直したときに古い世代を移さないため）。
  await assert.rejects(readFile(stateFile), { code: 'ENOENT' });
  await first.stop('test');
  const second = await start(t, dataDir);
  assert.equal(second.storeGeneration, LEGACY);
  assert.equal(second.storeGenerationSource, 'database');
  await second.stop('test');
  // DB と食い違う状態ファイルは、どちらも書き換えずに拒否する。
  const conflicting = `${JSON.stringify({ store_generation: OTHER_GENERATION, created_at: '2026-10-20T00:00:00.000Z' })}\n`;
  await writeFile(stateFile, conflicting);
  assert.deepEqual(
    await refusal(
      startCore({ dataDir, keyStore: keyStoreOf(KEY_A), probeTimeoutMs: 300 }),
    ),
    {
      code: 'store_generation_mismatch',
      reasons: ['store_generation_mismatch'],
    },
  );
  assert.equal(await readFile(stateFile, 'utf8'), conflicting);
  await rm(stateFile);
  const third = await start(t, dataDir);
  assert.equal(third.storeGeneration, LEGACY);
  await third.stop('test');
  // DB を消して作り直すと、新しい世代になる（状態ファイルは残っていない）。
  for (const name of await readdir(dataDir))
    if (name.startsWith('buddy.sqlite')) await rm(join(dataDir, name));
  const fresh = await start(t, dataDir);
  assert.equal(fresh.storeGenerationSource, 'created');
  assert.notEqual(fresh.storeGeneration, LEGACY);
});

test('a weakened durability setting or a newer schema refuses startup before any write', async (t) => {
  const dataDir = await tempDataDir(t);
  const weakened = readConnectionSql().replace(
    'PRAGMA synchronous = FULL;',
    'PRAGMA synchronous = NORMAL;',
  );
  assert.notEqual(weakened, readConnectionSql());
  assert.deepEqual(
    await refusal(
      startCore({
        dataDir,
        keyStore: keyStoreOf(KEY_A),
        probeTimeoutMs: 300,
        storeOptions: { connectionSql: weakened },
      }),
    ),
    {
      code: 'store_open_failed',
      reasons: ['write_connection_rejected', 'synchronous_not_full'],
    },
  );
  // 接続を拒否した DB にはスキーマも鍵の照合値も書いていない。ロックは返している。
  const empty = openWriteConnection(join(dataDir, 'buddy.sqlite'), {
    platform: storagePlatform(),
  });
  try {
    assert.equal(
      (
        empty
          .prepare(
            "SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
          )
          .get() as { n: number }
      ).n,
      0,
    );
    // コードより新しい版の DB を用意する。
    applyMigrations(empty);
    empty
      .prepare(
        "UPDATE schema_meta SET value = '99' WHERE key = 'schema_version'",
      )
      .run();
  } finally {
    empty.close();
  }
  assert.deepEqual(
    await refusal(
      startCore({ dataDir, keyStore: keyStoreOf(KEY_A), probeTimeoutMs: 300 }),
    ),
    { code: 'store_open_failed', reasons: ['schema_newer_than_code'] },
  );
  assert.deepEqual(
    (await readdir(dataDir)).filter((name) => !name.startsWith('buddy.sqlite')),
    [],
  );
});

// --- 子プロセス（dist/cli.js） ---

interface Background {
  readonly child: ChildProcess;
  readonly events: Record<string, Record<string, unknown>>;
  readonly exited: Promise<number | null>;
}

async function startCli(
  t: test.TestContext,
  dataDir: string,
): Promise<Background> {
  const child = spawn(
    process.execPath,
    [CLI, 'start', '--mock-key-protection', '--data-dir', dataDir],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  });
  let stderr = '';
  child.stderr
    ?.setEncoding('utf8')
    .on('data', (text: string) => (stderr += text));
  const exited = new Promise<number | null>((resolve) =>
    child.on('close', (code) => resolve(code)),
  );
  const events: Record<string, Record<string, unknown>> = {};
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`起動待ちの期限切れ: ${stderr}`)),
      TIMEOUT_MS,
    );
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on(
      'line',
      (line) => {
        const message = JSON.parse(line) as Record<string, unknown>;
        events[String(message['event'])] = message;
        if (message['event'] === 'running') {
          clearTimeout(timer);
          resolve();
        }
      },
    );
    child.on('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`起動前に終了しました（${code}）: ${stderr}`));
    });
  });
  return { child, events, exited };
}

function runCli(
  args: readonly string[],
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: TIMEOUT_MS,
    });
    let stdout = '';
    child.stdout
      .setEncoding('utf8')
      .on('data', (text: string) => (stdout += text));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

function snapshot(db: SqliteDatabase, ids: readonly string[]) {
  return Object.fromEntries(ids.map((id) => [id, readOperation(db, id)]));
}

test(
  'the CLI restores the store after a forced kill: same generation, same records, dispatching held once',
  { timeout: 90_000 },
  async (t) => {
    const dataDir = await tempDataDir(t);
    const first = await startCli(t, dataDir);
    const generation = first.events['running']?.['store_generation'];
    assert.equal(
      first.events['store_opened']?.['store_generation_source'],
      'created',
    );
    assert.equal((await runCli(['stop', '--data-dir', dataDir])).code, 0);
    assert.equal(await first.exited, 0);

    // Core の停止中に、DB worker と同じ処理（executeCommand）で操作を置く。
    // 模擬起動の鍵（公開の値から求める）で封じ、再起動の後に同じ鍵で読めることも確かめる。
    const mockKey = materialOf(
      createHash('sha256').update(MOCK_DATA_KEY_SEED, 'utf8').digest(),
    );
    const path = join(dataDir, 'buddy.sqlite');
    const ids = [H01_OPERATION, 'op-preparing', 'op-succeeded'];
    const commands = [
      ...plan(mockKey, H01_OPERATION, 'dispatching'),
      ...plan(mockKey, 'op-preparing', 'preparing'),
      ...plan(mockKey, 'op-succeeded', 'succeeded'),
    ];
    let seeded: ReturnType<typeof snapshot>;
    {
      const db = openWriteConnection(path, { platform: storagePlatform() });
      try {
        assert.equal(readStoreGeneration(db), generation);
        let now = Date.now();
        for (const command of commands) {
          now += 1;
          const result = executeCommand(db, command, {
            now,
            platform: storagePlatform(),
            storeGeneration: String(generation),
          });
          assert.equal(
            result.outcome.outcome,
            'durable',
            JSON.stringify(result.outcome),
          );
        }
        seeded = snapshot(db, ids);
      } finally {
        db.close();
      }
    }

    // 起動時の回復を確かめてから、終了処理をさせずに強制終了する（ロック・ソケットが残る）。
    const crashed = await startCli(t, dataDir);
    assert.deepEqual(crashed.events['store_opened'], {
      event: 'store_opened',
      schema_version: 2,
      store_generation: generation,
      store_generation_source: 'database',
      data_key_check: 'matched',
      held_after_restart: [H01_OPERATION],
      resumable_preparing: ['op-preparing'],
    });
    crashed.child.kill('SIGKILL');
    await crashed.exited;
    assert((await readdir(dataDir)).includes('core.lock'));

    // 古いロックを片付けて起動する。回復は記録済みなので、もう一度は回さない。
    const restarted = await startCli(t, dataDir);
    assert.equal(restarted.events['running']?.['store_generation'], generation);
    assert.deepEqual(
      restarted.events['store_opened']?.['held_after_restart'],
      [],
    );
    assert.deepEqual(
      restarted.events['store_opened']?.['resumable_preparing'],
      ['op-preparing'],
    );
    const status = await runCli(['status', '--data-dir', dataDir]);
    assert.equal(status.code, 0);
    assert.equal(
      (JSON.parse(status.stdout.trim()) as Record<string, unknown>)[
        'store_generation'
      ],
      generation,
    );
    assert.equal((await runCli(['stop', '--data-dir', dataDir])).code, 0);
    assert.equal(await restarted.exited, 0);

    const db = openWriteConnection(path, { platform: storagePlatform() });
    try {
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal(readStoreGeneration(db), generation);
      const after = snapshot(db, ids);
      assert.deepEqual(after['op-preparing'], seeded['op-preparing']);
      assert.deepEqual(after['op-succeeded'], seeded['op-succeeded']);
      const held = after[H01_OPERATION];
      const before = seeded[H01_OPERATION];
      assert(held && before);
      assert.deepEqual(
        {
          ...held,
          state: before.state,
          state_revision: before.state_revision,
          attempts: before.attempts,
        },
        before,
      );
      assert.equal(held.state, 'unknown_held');
      assert.equal(held.state_revision, '4');
      assert.equal(held.content_hash, H01_SHA256);
      assert.deepEqual(
        held.attempts.map((attempt) => [attempt.attempt_id, attempt.status]),
        before.attempts.map((attempt) => [attempt.attempt_id, 'unknown_held']),
      );
      for (const command of commands)
        assert.equal(
          readCommandReceipt(db, command.command_id)?.status,
          'durable',
          command.kind,
        );
      const events = listOutboxEvents(db, String(generation));
      assert.equal(events.length, commands.length + 1);
      assert.deepEqual(
        [events.at(-1)?.target_id, events.at(-1)?.state_revision],
        [H01_OPERATION, '4'],
      );
    } finally {
      db.close();
    }
  },
);
