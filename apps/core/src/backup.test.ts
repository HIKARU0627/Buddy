// 暗号化バックアップの作成・掃除・設定（B06-08 の段階 1。ADR 0040・0047・0055、本人の判断 J1・J2）。模擬だけ:
// 実機の Mac mini のキーチェーン・実際のバックアップと鍵の復元・同期フォルダーの実際の挙動は B15。
// 期待値は手で書いた（残る世代・消える世代・理由コード・除外する表・封筒の欄）。復旧キーの復号は、画面に出した文字列から
// domain の decodeRecoveryCode → storage の unwrapBackupKey → decryptBackupPayload と独立に開いて確かめる。
// 鍵・復旧キーは合成の値、DB は一時ディレクトリ。実データ・実鍵・実 API は使わない。

import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decodeRecoveryCode, planForget } from '@buddy/domain';
import type { MemorySource } from '@buddy/domain';
import { createMockBackupKeyStore, createMockKeyStore } from '@buddy/platform';
import type { MockBackupKeyStore } from '@buddy/platform';
import {
  decryptBackupPayload,
  openWriteConnection,
  readBackupFileHeader,
  readBackupPayload,
  recoveryCheckMatches,
  sha256Hex,
  unwrapBackupKey,
} from '@buddy/storage';
import type { BackupKeyWrapValue } from '@buddy/storage';
import { createApiContract } from './api-contract.js';
import { onCleanup } from './api-test-support.js';
import { BACKUP_CONFIG_FILE } from './backup-config.js';
import {
  BACKUP_KEY_FILE,
  BACKUP_STATE_FILE,
  readBackupKeyFile,
} from './backup-files.js';
import {
  BACKUP_INTERVAL_MS,
  BACKUP_WORK_DIR,
  startBackupScheduler,
} from './backup-service.js';
import type { BackupService } from './backup-service.js';
import {
  inspectBackupSetup,
  recordBackupSetup,
  runBackupSetup,
} from './backup-setup.js';
import { callControl } from './control-channel.js';
import { startCore } from './core.js';
import type { CoreHandle } from './core.js';
import { applyForgetAndSyncLedger } from './forget-ledger.js';
import { FORGET_LEDGER_FILE } from './paths.js';

const DATA_KEY = Buffer.alloc(32, 0x41);
const contract = createApiContract();
const DAY = 86_400_000;
const T0 = Date.parse('2031-03-01T00:00:00.000Z');
const SOURCE: MemorySource = {
  source_kind: 'source_item',
  source_id: 'mail-001',
};
const SOURCE_HMAC = 'a7'.repeat(32);

interface Rig {
  readonly dataDir: string;
  readonly backupDir: string;
  readonly handle: CoreHandle;
  readonly keys: MockBackupKeyStore;
  readonly logs: string[];
  readonly clock: { value: number };
  readonly displayed: string[];
}

async function rig(
  t: test.TestContext,
  options: {
    readonly config?: boolean;
    readonly keep?: number;
    readonly backupDirName?: string;
  } = {},
): Promise<Rig> {
  const base = await mkdtemp(join(tmpdir(), 'buddy-backup-'));
  onCleanup(t, () =>
    rm(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch(() => undefined),
  );
  const dataDir = join(base, 'data');
  const backupDir = join(
    base,
    ...(options.backupDirName === undefined ? [] : [options.backupDirName]),
    'backups',
  );
  await mkdir(backupDir, { recursive: true });
  const keys = createMockBackupKeyStore();
  const logs: string[] = [];
  const clock = { value: T0 };
  const handle = await startCore({
    dataDir,
    keyStore: createMockKeyStore({ stored: DATA_KEY.toString('base64') }),
    shutdownGraceMs: 200,
    probeTimeoutMs: 300,
    now: () => new Date(clock.value),
    log: (message) => logs.push(message),
    backup: { keyStore: keys },
  });
  onCleanup(t, async () => {
    await handle.stop('test').catch(() => undefined);
  });
  if (options.config !== false)
    await writeFile(
      join(dataDir, BACKUP_CONFIG_FILE),
      JSON.stringify({
        schema: 'buddy.backup-config.v1',
        directory: backupDir,
        keep_generations: options.keep ?? 7,
      }),
      { mode: 0o600 },
    );
  return { dataDir, backupDir, handle, keys, logs, clock, displayed: [] };
}

// CLI の設定と同じ流れ（Core の側は本物、CLI の側は同じ関数を直接呼ぶ）。復旧キーは displayed に出す。
async function setup(
  r: Rig,
  display: (code: string) => void = (code) => r.displayed.push(code),
) {
  return runBackupSetup({
    dataDir: r.dataDir,
    contract,
    dataKeys: createMockKeyStore({ stored: DATA_KEY.toString('base64') }),
    backupKeys: r.keys,
    now: () => new Date(r.clock.value),
    inspect: () => inspectBackupSetup(r.handle.store),
    record: (ledgerHmacKeyId) =>
      recordBackupSetup({
        dataDir: r.dataDir,
        contract,
        store: r.handle.store,
        backupKeys: r.keys,
        ledgerHmacKeyId,
      }),
    display: (shown) => display(shown.recovery_code),
  });
}

const sorted = (names: readonly string[]): string[] => [...names].sort();
async function backupFiles(r: Rig): Promise<string[]> {
  return sorted(
    (await readdir(r.backupDir)).filter((name) =>
      name.endsWith('.buddybackup'),
    ),
  );
}

interface Opened {
  readonly manifest: Record<string, unknown> & {
    key_wraps: BackupKeyWrapValue[];
    payload: { bytes: number; sha256: string };
  };
  readonly database: Buffer;
}

// 画面に出した復旧キーだけから封筒を開く（Core の鍵・KeyStore を使わない）。
async function openBackup(path: string, code: string): Promise<Opened> {
  const header = await readBackupFileHeader(path);
  assert.ok(header.ok);
  const manifest = header.manifest as Opened['manifest'];
  const recoveryKey = decodeRecoveryCode(code);
  assert.ok(recoveryKey !== null);
  const wrap = manifest.key_wraps.find(
    (entry) => entry.purpose === 'backup_file',
  );
  assert.ok(wrap !== undefined);
  const key = unwrapBackupKey(Buffer.from(recoveryKey), wrap);
  assert.ok(key !== null);
  const payload = await readBackupPayload(
    path,
    header.payload_offset,
    manifest.payload.bytes,
  );
  assert.ok(payload !== null);
  assert.equal(sha256Hex(payload), manifest.payload.sha256);
  const database = decryptBackupPayload(
    {
      key,
      keyId: wrap.key_id,
      fields: {
        backup_id: manifest['backup_id'] as string,
        created_at: manifest['created_at'] as string,
        store_generation: manifest['store_generation'] as string,
        db_schema_version: manifest['db_schema_version'] as number,
        forgetting_generation: manifest['forgetting_generation'] as string,
        ledger_id: manifest['ledger_id'] as string,
        ledger_head_hash: manifest['ledger_head_hash'] as string,
        excluded_tables: manifest['excluded_tables'] as string[],
      },
    },
    payload,
  );
  assert.ok(database !== null);
  return { manifest, database };
}

async function ready(r: Rig): Promise<string> {
  const outcome = await setup(r);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.equal(outcome.shown, true);
  const code = r.displayed.at(-1);
  assert.ok(code !== undefined);
  return code;
}

test('設定: 復旧キーは画面にだけ出て、包みは復旧キーだけで開け、台帳の系譜と鍵の ID が DB に記録される', async (t) => {
  const r = await rig(t);
  const code = await ready(r);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){12}$/u);
  const file = await readBackupKeyFile(r.dataDir, contract);
  assert.ok(file.ok);
  const wraps = file.value.key_wraps;
  assert.deepEqual(wraps.map((wrap) => wrap.purpose).sort(), [
    'backup_file',
    'data_key',
    'ledger_hmac_key',
  ]);
  assert.equal(new Set(wraps.map((wrap) => wrap.key_id)).size, 3);
  assert.equal(file.value.recovery_key.state, 'shown');
  assert.equal(file.value.recovery_key.shown_at, new Date(T0).toISOString());
  // 復旧キーの確認値が、画面に出した文字列と合う。
  const recoveryKey = decodeRecoveryCode(code);
  assert.ok(recoveryKey !== null);
  assert.equal(
    recoveryCheckMatches(
      Buffer.from(recoveryKey),
      file.value.recovery_key.check_value,
    ),
    true,
  );
  // 3 つの包みは、復旧キーだけで開ける。データ鍵は KeyStore の模擬の鍵（0x41 の 32 バイト）と同じ。
  const material = (purpose: string): Buffer | null => {
    const wrap = wraps.find((entry) => entry.purpose === purpose);
    return wrap === undefined
      ? null
      : unwrapBackupKey(Buffer.from(recoveryKey), wrap);
  };
  assert.deepEqual(material('data_key'), DATA_KEY);
  const fileKey = wraps.find((wrap) => wrap.purpose === 'backup_file');
  const ledgerKey = wraps.find((wrap) => wrap.purpose === 'ledger_hmac_key');
  assert.ok(fileKey !== undefined && ledgerKey !== undefined);
  const storedFile = await r.keys.read('backup_file', fileKey.key_id);
  assert.ok(storedFile.ok);
  assert.deepEqual(storedFile.key.key, material('backup_file'));
  const read = await r.keys.read('ledger_hmac_key', ledgerKey.key_id);
  assert.ok(read.ok);
  assert.deepEqual(read.key.key, material('ledger_hmac_key'));
  // DB: 台帳の鍵の ID と、台帳の系譜（まだ忘れていないので、設定のときに付く）。
  const facts = await r.handle.store.memory({ kind: 'backup.facts' });
  assert.ok(facts.ok);
  assert.equal(facts.value.recorded_ledger_key_id, ledgerKey.key_id);
  assert.match(
    facts.value.ledger_id ?? '',
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  assert.equal(facts.value.forgetting_generation, '0');
  // 復旧キーはファイル・ログ・状態のどこにも書かれない。
  const status = await r.handle.backup.status();
  for (const text of [
    await readFile(join(r.dataDir, BACKUP_KEY_FILE), 'utf8'),
    r.logs.join('\n'),
    JSON.stringify(status),
  ])
    assert.equal(text.includes(code.replaceAll('-', '')), false);
  assert.equal(JSON.stringify(status).includes(code), false);
});

test('設定のやり直し: 鍵は作り直さず、復旧キーだけが新しくなり、系譜は変わらない', async (t) => {
  const r = await rig(t);
  const code1 = await ready(r);
  const first = await readBackupKeyFile(r.dataDir, contract);
  const facts1 = await r.handle.store.memory({ kind: 'backup.facts' });
  assert.ok(first.ok && facts1.ok);
  r.clock.value += 1000;
  const again = await setup(r);
  assert.ok(again.ok);
  assert.deepEqual(again.actions, {
    backup_file: 'reuse',
    data_key: 'reuse',
    ledger_hmac_key: 'reuse',
  });
  const code2 = r.displayed.at(-1);
  assert.notEqual(code2, code1);
  const second = await readBackupKeyFile(r.dataDir, contract);
  assert.ok(second.ok);
  assert.notEqual(
    second.value.recovery_key.recovery_key_id,
    first.value.recovery_key.recovery_key_id,
  );
  assert.deepEqual(
    second.value.key_wraps
      .map((wrap) => `${wrap.purpose}:${wrap.key_id}`)
      .sort(),
    first.value.key_wraps
      .map((wrap) => `${wrap.purpose}:${wrap.key_id}`)
      .sort(),
  );
  const facts2 = await r.handle.store.memory({ kind: 'backup.facts' });
  assert.ok(facts2.ok);
  assert.equal(facts2.value.ledger_id, facts1.value.ledger_id);
  assert.equal(
    facts2.value.recorded_ledger_key_id,
    facts1.value.recorded_ledger_key_id,
  );
  // KeyStore の鍵は 2 つだけ（作り直していない）。
  assert.equal(r.keys.accounts().length, 2);
});

test('設定は、台帳の鍵を記録したのに KeyStore にないとき・データ鍵を読めないとき・Core が答えないときは止まる', async (t) => {
  const r = await rig(t);
  await ready(r);
  const file = await readBackupKeyFile(r.dataDir, contract);
  assert.ok(file.ok);
  const ledgerKey = file.value.key_wraps.find(
    (wrap) => wrap.purpose === 'ledger_hmac_key',
  );
  assert.ok(ledgerKey !== undefined);
  r.keys.remove('ledger_hmac_key', ledgerKey.key_id);
  const missing = await setup(r);
  assert.deepEqual(missing, {
    ok: false,
    stage: 'plan',
    reasons: ['ledger_key_missing'],
  });
  // 失敗した設定は包みを書き換えない（前の記録のまま）。
  const after = await readBackupKeyFile(r.dataDir, contract);
  assert.ok(after.ok);
  assert.equal(
    after.value.recovery_key.recovery_key_id,
    file.value.recovery_key.recovery_key_id,
  );
  // データ鍵を読めない。
  const noData = await runBackupSetup({
    dataDir: r.dataDir,
    contract,
    dataKeys: createMockKeyStore({ available: false }),
    backupKeys: r.keys,
    now: () => new Date(r.clock.value),
    inspect: () => inspectBackupSetup(r.handle.store),
    record: () => Promise.reject(new Error('呼ばれない')),
    display: () => assert.fail('出さない'),
  });
  assert.equal(noData.ok, false);
  assert.equal(noData.ok ? '' : noData.stage, 'plan');
  // Core が答えない。
  const offline = await runBackupSetup({
    dataDir: r.dataDir,
    contract,
    dataKeys: createMockKeyStore({ stored: DATA_KEY.toString('base64') }),
    backupKeys: r.keys,
    now: () => new Date(r.clock.value),
    inspect: () => Promise.resolve({ ok: false, reasons: ['not_running'] }),
    record: () => Promise.reject(new Error('呼ばれない')),
    display: () => assert.fail('出さない'),
  });
  assert.deepEqual(offline, {
    ok: false,
    stage: 'inspect',
    reasons: ['not_running'],
  });
});

test('復旧キーを画面に出せなかったときは shown にならず、見せていないキーのバックアップは取らない', async (t) => {
  const r = await rig(t);
  const outcome = await setup(r, () => {
    throw new Error('画面に出せない');
  });
  assert.ok(outcome.ok);
  assert.equal(outcome.shown, false);
  const file = await readBackupKeyFile(r.dataDir, contract);
  assert.ok(file.ok);
  assert.equal(file.value.recovery_key.state, 'not_shown');
  const run = await r.handle.backup.run();
  assert.equal(run.ok, false);
  assert.deepEqual(run.ok ? [] : run.reasons, ['recovery_key_not_shown']);
  assert.deepEqual(await backupFiles(r), []);
});

test('バックアップ: 設定・置き場所・鍵のどれかが欠けていれば取らず、封筒を書かない', async (t) => {
  const none = await rig(t, { config: false });
  const noConfig = await none.handle.backup.run();
  assert.equal(noConfig.ok, false);
  assert.deepEqual(noConfig.ok ? [] : noConfig.reasons, ['config_missing']);

  const r = await rig(t);
  // 設定の鍵（包み）がまだない。
  const noKeys = await r.handle.backup.run();
  assert.deepEqual(noKeys.ok ? [] : noKeys.reasons, ['backup_not_set_up']);
  await ready(r);
  // 置き場所がディレクトリでない。
  await writeFile(
    join(r.dataDir, BACKUP_CONFIG_FILE),
    JSON.stringify({
      schema: 'buddy.backup-config.v1',
      directory: join(r.backupDir, 'missing'),
      keep_generations: 7,
    }),
    { mode: 0o600 },
  );
  const missingDir = await r.handle.backup.run();
  assert.deepEqual(missingDir.ok ? [] : missingDir.reasons, [
    'location_not_a_directory',
  ]);
  // 置き場所が Core のデータディレクトリの中。
  await writeFile(
    join(r.dataDir, BACKUP_CONFIG_FILE),
    JSON.stringify({
      schema: 'buddy.backup-config.v1',
      directory: r.dataDir,
      keep_generations: 7,
    }),
    { mode: 0o600 },
  );
  const inData = await r.handle.backup.run();
  assert.deepEqual(inData.ok ? [] : inData.reasons, [
    'location_is_data_directory',
  ]);
  // 設定の形が違う（世代の数 0・知らない項目・相対パス）。
  for (const bad of [
    {
      schema: 'buddy.backup-config.v1',
      directory: r.backupDir,
      keep_generations: 0,
    },
    {
      schema: 'buddy.backup-config.v1',
      directory: r.backupDir,
      keep_generations: 7,
      extra: true,
    },
    {
      schema: 'buddy.backup-config.v1',
      directory: 'relative/path',
      keep_generations: 7,
    },
    {
      schema: 'buddy.backup-config.v1',
      directory: `${r.backupDir}/../x`,
      keep_generations: 7,
    },
  ]) {
    await writeFile(join(r.dataDir, BACKUP_CONFIG_FILE), JSON.stringify(bad), {
      mode: 0o600,
    });
    const refused = await r.handle.backup.run();
    assert.deepEqual(refused.ok ? [] : refused.reasons, [
      'config_schema_invalid',
    ]);
  }
  assert.deepEqual(await backupFiles(r), []);
});

test('バックアップ: 封筒は契約と手書きの期待値のとおりで、復旧キーだけで開け、除外した表は空、作業用の写しは残らない', async (t) => {
  const r = await rig(t);
  const code = await ready(r);
  r.clock.value = T0 + 5000;
  const run = await r.handle.backup.run();
  assert.ok(run.ok, JSON.stringify(run));
  assert.equal(run.created_at, '2031-03-01T00:00:05.000Z');
  assert.equal(run.forgetting_generation, '0');
  assert.equal(run.excluded_tables, 10);
  assert.equal(run.sync_folder_warning, false);
  const files = await backupFiles(r);
  assert.deepEqual(files, [`buddy-${run.backup_id}.buddybackup`]);
  const opened = await openBackup(join(r.backupDir, files[0] as string), code);
  const manifest = opened.manifest;
  // 手書きの期待値。
  assert.equal(contract.valid('BackupManifest', manifest), true);
  assert.equal(manifest['schema'], 'buddy.backup-manifest.v1');
  assert.equal(manifest['backup_id'], run.backup_id);
  assert.equal(manifest['store_generation'], r.handle.storeGeneration);
  assert.equal(manifest['db_schema_version'], 12);
  assert.equal(manifest['forgetting_generation'], '0');
  assert.equal(manifest['ledger_head_hash'], '0'.repeat(64));
  assert.deepEqual(manifest['included_storage_modes'], ['normal', 'extended']);
  assert.deepEqual([...(manifest['excluded_data'] as string[])].sort(), [
    'api_keys',
    'oauth_tokens',
    'private_conversation',
    'raw_audio',
  ]);
  assert.deepEqual(manifest['excluded_tables'], [
    'async_context_guards',
    'command_receipts',
    'command_scopes',
    'event_outbox',
    'home_network_reports',
    'pairing_claims',
    'pairing_sessions',
    'source_items',
    'sync_batches',
    'sync_staging',
  ]);
  const file = await readBackupKeyFile(r.dataDir, contract);
  assert.ok(file.ok);
  assert.deepEqual(manifest.key_wraps, file.value.key_wraps);
  // 封筒の平文に、鍵の素材・復旧キー・データ鍵の値は出ない。
  const raw = await readFile(join(r.backupDir, files[0] as string));
  assert.equal(raw.includes(DATA_KEY), false);
  assert.equal(raw.includes(Buffer.from(DATA_KEY.toString('base64'))), false);
  assert.equal(raw.includes(Buffer.from(code.replaceAll('-', ''))), false);
  // 本体は SQLite で、取った時点の世代の DB。含める表は残り、除外した表は空。
  const dbPath = join(r.dataDir, 'opened.sqlite');
  await writeFile(dbPath, opened.database);
  const db = openWriteConnection(dbPath, { platform: 'macos' });
  try {
    assert.equal(
      db
        .prepare("SELECT value FROM schema_meta WHERE key = 'store_generation'")
        .pluck()
        .get(),
      r.handle.storeGeneration,
    );
    assert.equal(
      db.prepare('SELECT count(*) FROM command_scopes').pluck().get(),
      0,
    );
    assert.equal(
      db.prepare('SELECT count(*) FROM source_items').pluck().get(),
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT value FROM schema_meta WHERE key = 'ledger_hmac_key_id'",
        )
        .pluck()
        .get(),
      file.value.key_wraps.find((wrap) => wrap.purpose === 'ledger_hmac_key')
        ?.key_id,
    );
  } finally {
    db.close();
  }
  // 作業用の写し・取り残された一時ファイルはない。
  assert.deepEqual(await readdir(join(r.dataDir, BACKUP_WORK_DIR)), []);
  assert.deepEqual(
    (await readdir(r.backupDir)).filter((name) => name.endsWith('.tmp')),
    [],
  );
  // 状態: 最後の成功と初めて見た時刻。
  const status = await r.handle.backup.status();
  assert.deepEqual(status.last_success, {
    backup_id: run.backup_id,
    created_at: run.created_at,
    forgetting_generation: '0',
  });
  assert.equal(status.keys_ready, true);
  assert.equal(status.recovery_key_state, 'shown');
  // 別の復旧キーでは開けない。
  const wrongCode =
    '0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000';
  await assert.rejects(
    openBackup(join(r.backupDir, files[0] as string), wrongCode),
  );
});

test('同期フォルダーの置き場所は使えるが警告する', async (t) => {
  const r = await rig(t, { backupDirName: 'Dropbox' });
  await ready(r);
  const run = await r.handle.backup.run();
  assert.ok(run.ok);
  assert.equal(run.sync_folder_warning, true);
  const status = await r.handle.backup.status();
  assert.deepEqual(status.location?.warnings, ['sync_folder_detected']);
  assert.equal(status.location?.sync_provider_hint, 'dropbox');
  assert.equal(status.location?.usable, true);
});

test('データ鍵が DB の暗号文を覆わないときは取らない（2 つの鍵の暗号文がある DB）', async (t) => {
  const r = await rig(t);
  await ready(r);
  // DB に、包みのデータ鍵（data-key-v1）と別の鍵 ID の暗号文がある状態にする（入れ替えの途中の再現）。
  const dbPath = join(r.dataDir, 'buddy.sqlite');
  const sql = openWriteConnection(`${dbPath}`, { platform: 'macos' });
  try {
    sql
      .prepare(
        "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES ('b-other-key', 'turn_text', 'turns', 'o', 0, 1, 'data-key-v2', randomblob(12), randomblob(8), randomblob(16), 1000, NULL)",
      )
      .run();
  } finally {
    sql.close();
  }
  const run = await r.handle.backup.run();
  assert.equal(run.ok, false);
  assert.deepEqual(run.ok ? [] : run.reasons, ['data_key_not_covering_db']);
  assert.deepEqual(await backupFiles(r), []);
  assert.deepEqual(await readdir(join(r.dataDir, BACKUP_WORK_DIR)), []);
});

test('掃除: 世代の数 × 1 日を過ぎた封筒を消し、ちょうどの封筒も消す（3 世代・1 日 1 回）', async (t) => {
  const r = await rig(t, { keep: 3 });
  await ready(r);
  const ids: string[] = [];
  for (let day = 0; day <= 4; day += 1) {
    r.clock.value = T0 + day * DAY;
    const run = await r.handle.backup.run();
    assert.ok(run.ok, JSON.stringify(run));
    ids.push(run.backup_id);
    if (day === 3) {
      // 3 日目までは 4 つ取っても、世代の数（3）を超えた古い方（0 日目）が消える。1 日目は 3 日ちょうどではない（2 日）。
      assert.deepEqual(run.sweep.ok ? run.sweep.deleted : [], [ids[0]]);
    }
  }
  // 4 日目: 0 日目は前に消えた。1 日目は作成からちょうど 3 日なので期限（<=）で消える。残るのは 2・3・4 日目。
  assert.deepEqual(
    await backupFiles(r),
    sorted([2, 3, 4].map((day) => `buddy-${ids[day]}.buddybackup`)),
  );
});

test('掃除: 取るのに失敗が続いても期限は延びず、成功した最新の 1 つだけが残り、新しいバックアップを取るよう印が付く', async (t) => {
  const r = await rig(t, { keep: 3 });
  await ready(r);
  const first = await r.handle.backup.run();
  const second = (() => {
    r.clock.value = T0 + DAY;
    return r.handle.backup.run();
  })();
  const secondRun = await second;
  assert.ok(first.ok && secondRun.ok);
  // 10 日後。バックアップの鍵が KeyStore からなくなり、取れない。
  const file = await readBackupKeyFile(r.dataDir, contract);
  assert.ok(file.ok);
  const fileKey = file.value.key_wraps.find(
    (wrap) => wrap.purpose === 'backup_file',
  );
  assert.ok(fileKey !== undefined);
  r.keys.remove('backup_file', fileKey.key_id);
  r.clock.value = T0 + 10 * DAY;
  const failed = await r.handle.backup.run();
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.ok ? [] : failed.reasons, [
    'backup_key_backup_key_missing',
  ]);
  const sweep = failed.sweep;
  assert.ok(sweep?.ok);
  // 期限を過ぎた 2 つのうち、成功した最新の 1 つ（1 日目）だけが残る。
  assert.deepEqual(sweep.deleted, [first.backup_id]);
  assert.deepEqual(await backupFiles(r), [
    `buddy-${secondRun.backup_id}.buddybackup`,
  ]);
  assert.equal(sweep.needs_new_backup, true);
  assert.deepEqual(sweep.notices, [
    { backup_id: secondRun.backup_id, reason: 'last_backup_kept' },
  ]);
  assert.equal((await r.handle.backup.status()).needs_new_backup, true);
  assert.equal(await r.handle.backup.due(), true);
});

async function forgetSource(r: Rig): Promise<void> {
  const read = await r.handle.store.memory({
    kind: 'forget.graph',
    target: SOURCE,
  });
  assert.ok(read.ok);
  const plan = planForget({
    target: SOURCE,
    instruction_turn_id: null,
    executing_operation_id: null,
    graph: read.value.graph,
    sourceHmac: () => SOURCE_HMAC,
  });
  assert.ok(plan.ok);
  const applied = await applyForgetAndSyncLedger(
    r.handle.store,
    {
      kind: 'forget.apply',
      target: SOURCE,
      instruction_turn_id: null,
      plan: plan.plan,
      source_hmacs: [{ ...SOURCE, hmac: SOURCE_HMAC }],
      entry_id: '9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a',
      previous_generation: read.value.forgetting_generation,
      new_ledger_id: 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0',
      now: r.clock.value,
    },
    join(r.dataDir, FORGET_LEDGER_FILE),
    new Date(r.clock.value),
  );
  assert.ok(applied.result.ok, JSON.stringify(applied.result));
}

test('忘却: 古い世代のバックアップは、今の世代のバックアップができてから消える（その前は残して取り直しを求める）', async (t) => {
  const r = await rig(t);
  const code = await ready(r);
  const before = await r.handle.backup.run();
  assert.ok(before.ok);
  const beforeFile = join(r.backupDir, `buddy-${before.backup_id}.buddybackup`);
  assert.equal(
    (await openBackup(beforeFile, code)).manifest['forgetting_generation'],
    '0',
  );
  r.clock.value = T0 + 1000;
  await forgetSource(r);
  // 忘却の後・新しいバックアップの前。古い世代の封筒は残り、取り直しを求める。
  const swept = await r.handle.backup.sweep();
  assert.ok(swept.ok);
  assert.deepEqual(swept.deleted, []);
  assert.equal(swept.needs_new_backup, true);
  assert.deepEqual(swept.decisions, [
    {
      backup_id: before.backup_id,
      action: 'keep',
      reasons: ['awaiting_replacement'],
    },
  ]);
  assert.equal(await r.handle.backup.due(), true);
  // 新しいバックアップ（世代 1）を取ると、古い方が消える。
  r.clock.value = T0 + 2000;
  const after = await r.handle.backup.run();
  assert.ok(after.ok);
  assert.equal(after.forgetting_generation, '1');
  assert.ok(after.sweep.ok);
  assert.deepEqual(after.sweep.deleted, [before.backup_id]);
  assert.deepEqual(
    after.sweep.decisions.find((entry) => entry.backup_id === before.backup_id)
      ?.reasons,
    ['forgetting_superseded'],
  );
  assert.deepEqual(await backupFiles(r), [
    `buddy-${after.backup_id}.buddybackup`,
  ]);
  const opened = await openBackup(
    join(r.backupDir, `buddy-${after.backup_id}.buddybackup`),
    code,
  );
  assert.equal(opened.manifest['forgetting_generation'], '1');
  assert.notEqual(opened.manifest['ledger_head_hash'], '0'.repeat(64));
  // 忘れた元情報の生の ID は、台帳にも封筒にも書かれない（HMAC だけ）。
  assert.equal(opened.database.includes(Buffer.from('mail-001')), false);
});

test('掃除: 時計が戻っても最終確認時刻で判定し、期限を延ばさない', async (t) => {
  const r = await rig(t, { keep: 3 });
  await ready(r);
  const old = await r.handle.backup.run();
  assert.ok(old.ok);
  // 5 日後に確認（古い封筒は消える側。ただし最新の 1 つなので残り、最終確認時刻が 5 日後になる）。
  r.clock.value = T0 + 5 * DAY;
  const swept = await r.handle.backup.sweep();
  assert.ok(swept.ok);
  assert.equal(swept.clock_state, 'ok');
  // 時計を 1 日後へ戻して新しい封筒を取る。戻った時計の封筒の作成時刻は 1 日後だが、判定は最終確認時刻（5 日後）で行う。
  r.clock.value = T0 + DAY;
  const created = await r.handle.backup.run();
  assert.ok(created.ok);
  assert.ok(created.sweep.ok);
  assert.equal(created.sweep.clock_state, 'regressed');
  // 5 日後の目で見ると、最初の封筒（0 日目）は期限切れで、戻った時計で取った封筒（1 日目）が期限内。最初のものだけが消える。
  assert.deepEqual(created.sweep.deleted, [old.backup_id]);
  assert.deepEqual(await backupFiles(r), [
    `buddy-${created.backup_id}.buddybackup`,
  ]);
});

test('掃除: 読めない封筒・別の系譜の封筒・取り残された一時ファイルを扱い、状態ファイルが壊れていれば何も消さない', async (t) => {
  const r = await rig(t, { keep: 3 });
  await ready(r);
  const good = await r.handle.backup.run();
  assert.ok(good.ok);
  // 壊れた封筒（読めない）、書きかけの一時ファイル、封筒の形でない名前のファイル。
  const garbageId = 'abababab-abab-4bab-8bab-abababababab';
  const garbage = join(r.backupDir, `buddy-${garbageId}.buddybackup`);
  await writeFile(garbage, 'not a backup');
  // 試験の時計（2031 年）に合わせる。実際のファイルの更新時刻は今日で、試験の時計より前になってしまう。
  await utimes(garbage, new Date(T0), new Date(T0));
  await writeFile(join(r.backupDir, '.buddy-backup-leftover.tmp'), 'partial');
  await writeFile(join(r.backupDir, 'notes.txt'), 'keep me');
  r.clock.value = T0 + 1000;
  const swept = await r.handle.backup.sweep();
  assert.ok(swept.ok);
  assert.equal(swept.removed_temp_files, 1);
  // 読めない封筒は、ファイルの更新時刻が新しいうちは消さない（復元には使えないので数えない）。
  assert.deepEqual(
    swept.decisions.find((entry) => entry.backup_id === garbageId)?.reasons,
    ['manifest_unreadable'],
  );
  assert.equal(
    swept.decisions.find((entry) => entry.backup_id === garbageId)?.action,
    'keep',
  );
  assert.equal(swept.restorable_count, 1);
  assert.equal((await readdir(r.backupDir)).includes('notes.txt'), true);
  assert.equal(
    (await readdir(r.backupDir)).includes('.buddy-backup-leftover.tmp'),
    false,
  );
  // 更新時刻が 3 日以上前の読めない封筒は、期限で消える。
  const old = new Date(T0 - 4 * DAY);
  await utimes(garbage, old, old);
  r.clock.value = T0 + 2000;
  const later = await r.handle.backup.sweep();
  assert.ok(later.ok);
  assert.deepEqual(later.deleted, [garbageId]);
  // 状態ファイル（時計の最終確認）が壊れていれば、期限を判定できないので何も消さない。
  await writeFile(join(r.dataDir, BACKUP_STATE_FILE), '{broken');
  r.clock.value = T0 + 30 * DAY;
  const refused = await r.handle.backup.sweep();
  assert.deepEqual(refused, { ok: false, reasons: ['state_invalid'] });
  assert.deepEqual(await backupFiles(r), [
    `buddy-${good.backup_id}.buddybackup`,
  ]);
  const blocked = await r.handle.backup.run();
  assert.deepEqual(blocked.ok ? [] : blocked.reasons, ['state_invalid']);
});

test('2 つの実行は重ならず順に動き、封筒の ID は別になる', async (t) => {
  const r = await rig(t);
  await ready(r);
  const [a, b] = await Promise.all([
    r.handle.backup.run(),
    r.handle.backup.run(),
  ]);
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.backup_id, b.backup_id);
  assert.equal((await backupFiles(r)).length, 2);
});

test('制御チャネル: 状態・実行は置き場所のパスを返さず、台帳の鍵の ID の形が違う要求は拒否する', async (t) => {
  const r = await rig(t);
  await ready(r);
  const status = await callControl(r.handle.endpoint, 'backup_status', 5000);
  assert.equal(status.kind, 'response');
  const body = status.kind === 'response' ? status.body : {};
  assert.equal(body['ok'], true);
  assert.equal(JSON.stringify(body).includes(r.backupDir), false);
  assert.equal((body['backup'] as Record<string, unknown>)['kind'], 'status');
  assert.equal((body['backup'] as Record<string, unknown>)['keys_ready'], true);
  const run = await callControl(r.handle.endpoint, 'backup_run', 60_000);
  assert.equal(run.kind, 'response');
  const ran =
    run.kind === 'response'
      ? (run.body['backup'] as Record<string, unknown>)
      : {};
  assert.equal(ran['kind'], 'run');
  assert.equal(ran['ok'], true);
  assert.equal(JSON.stringify(run).includes(r.backupDir), false);
  assert.equal((await backupFiles(r)).length, 1);
  const inspect = await callControl(
    r.handle.endpoint,
    'backup_setup_inspect',
    5000,
  );
  assert.equal(inspect.kind === 'response' ? inspect.body['ok'] : null, true);
  const bad = await callControl(
    r.handle.endpoint,
    'backup_setup_record',
    5000,
    { ledger_hmac_key_id: 'Bad Key!' },
  );
  assert.equal(
    bad.kind === 'response' ? bad.body['error'] : null,
    'invalid_request',
  );
  assert.equal(
    bad.kind === 'response' ? bad.body['reason'] : null,
    'invalid_key_id',
  );
  // 知らない鍵の ID は、包みと一致しないので記録しない。
  const mismatch = await callControl(
    r.handle.endpoint,
    'backup_setup_record',
    5000,
    { ledger_hmac_key_id: 'ledger-hmac-ffffffffffffffff' },
  );
  assert.equal(
    mismatch.kind === 'response' ? mismatch.body['error'] : null,
    'refused',
  );
  assert.equal(
    mismatch.kind === 'response' ? mismatch.body['reason'] : null,
    'ledger_key_id_mismatch',
  );
});

// レビュー（PR #175 の P1）の再現: 古い正常な A と新しい本体破損の B があり、次の作成が失敗しても、A を消さない。
for (const [name, corrupt] of [
  ['切り詰め', (bytes: Buffer): Buffer => bytes.subarray(0, bytes.length - 5)],
  [
    '同じ長さで 1 バイト書き換え',
    (bytes: Buffer): Buffer => {
      const copy = Buffer.from(bytes);
      copy.writeUInt8(
        (copy.readUInt8(copy.length - 1) ^ 1) & 0xff,
        copy.length - 1,
      );
      return copy;
    },
  ],
  [
    '末尾に余分なバイト',
    (bytes: Buffer): Buffer => Buffer.concat([bytes, Buffer.from('x')]),
  ],
] as const) {
  test(`掃除: 最新の封筒の本体が壊れて（${name}）いても、正常な最後の世代を消さず、壊れた封筒は復元できる世代に数えない`, async (t) => {
    const r = await rig(t, { keep: 1 });
    await ready(r);
    const good = await r.handle.backup.run();
    assert.ok(good.ok);
    r.clock.value = T0 + 1000;
    const newer = await r.handle.backup.run();
    assert.ok(newer.ok);
    // 1 世代なので、新しい方を取った時点で古い方は消える。もう一度古い方を作るため、いったん別の置き場所に正常な封筒を戻す。
    assert.deepEqual(await backupFiles(r), [
      `buddy-${newer.backup_id}.buddybackup`,
    ]);
    // 正常な封筒を 2 つにするため、keep を増やして取り直し、その後 keep を 1 に戻す。
    await writeFile(
      join(r.dataDir, BACKUP_CONFIG_FILE),
      JSON.stringify({
        schema: 'buddy.backup-config.v1',
        directory: r.backupDir,
        keep_generations: 3,
      }),
      { mode: 0o600 },
    );
    r.clock.value = T0 + 2000;
    const second = await r.handle.backup.run();
    assert.ok(second.ok);
    // newer（A 相当）と second（B 相当、より新しい）の 2 つ。B の本体を壊す。
    const brokenPath = join(
      r.backupDir,
      `buddy-${second.backup_id}.buddybackup`,
    );
    await writeFile(brokenPath, corrupt(await readFile(brokenPath)));
    // 試験の時計（2031 年）に合わせる（実際の更新時刻は今日で、試験の時計より前になってしまう）。
    await utimes(brokenPath, new Date(T0 + 2000), new Date(T0 + 2000));
    await writeFile(
      join(r.dataDir, BACKUP_CONFIG_FILE),
      JSON.stringify({
        schema: 'buddy.backup-config.v1',
        directory: r.backupDir,
        keep_generations: 1,
      }),
      { mode: 0o600 },
    );
    // 次の作成が鍵の欠落で失敗する。
    const file = await readBackupKeyFile(r.dataDir, contract);
    assert.ok(file.ok);
    const fileKey = file.value.key_wraps.find(
      (wrap) => wrap.purpose === 'backup_file',
    );
    assert.ok(fileKey !== undefined);
    r.keys.remove('backup_file', fileKey.key_id);
    r.clock.value = T0 + 3000;
    const failed = await r.handle.backup.run();
    assert.equal(failed.ok, false);
    const sweep = failed.sweep;
    assert.ok(sweep?.ok);
    // 正常な A は消えない。壊れた B は復元できる世代に数えず（manifest_unreadable）、期限内なので消さない。
    assert.deepEqual(sweep.deleted, []);
    assert.equal(sweep.restorable_count, 1);
    assert.deepEqual(
      sweep.decisions.find((entry) => entry.backup_id === second.backup_id)
        ?.reasons,
      ['manifest_unreadable'],
    );
    assert.deepEqual(
      sweep.decisions.find((entry) => entry.backup_id === newer.backup_id)
        ?.action,
      'keep',
    );
    assert.deepEqual(
      await backupFiles(r),
      sorted(
        [newer.backup_id, second.backup_id].map(
          (id) => `buddy-${id}.buddybackup`,
        ),
      ),
    );
  });
}

// レビュー（PR #175 の P2）の再現: 成功したバックアップの後に忘れても、手動の sweep を挟まず、定期の確認だけで 24 時間を
// 待たずに取り直し、忘れた内容を持つ古い封筒が消える。
test('定期の確認: バックアップの成功の後に忘却すると、24 時間を待たずに取り直され、古い世代の封筒が消える', async (t) => {
  const r = await rig(t);
  const code = await ready(r);
  const before = await r.handle.backup.run();
  assert.ok(before.ok);
  // 忘却がなければ、24 時間たつまで予定にならない。
  r.clock.value = T0 + 1000;
  assert.equal(await r.handle.backup.due(), false);
  await forgetSource(r);
  // 掃除（sweep）を一度も呼んでいない。needs_new_backup は立っていないが、忘却の世代が最後の成功より進んでいる。
  assert.equal((await r.handle.backup.status()).needs_new_backup, false);
  assert.equal(await r.handle.backup.due(), true);
  const timers: (() => void)[] = [];
  const logs: string[] = [];
  const scheduler = startBackupScheduler({
    service: r.handle.backup,
    log: (message) => logs.push(message),
    now: () => new Date(r.clock.value),
    setTimer: (run) => timers.push(run),
    clearTimer: () => undefined,
  });
  const next = timers.shift();
  assert.ok(next !== undefined);
  r.clock.value = T0 + 2000;
  next();
  // 実行の完了を待つ（古い封筒が消えるまで）。
  const beforeFile = `buddy-${before.backup_id}.buddybackup`;
  for (
    let i = 0;
    i < 200 && (await backupFiles(r)).includes(beforeFile);
    i += 1
  )
    await new Promise((resolve) => setTimeout(resolve, 25));
  scheduler.stop();
  const files = await backupFiles(r);
  assert.equal(files.length, 1);
  assert.equal(files.includes(beforeFile), false);
  const opened = await openBackup(join(r.backupDir, files[0] as string), code);
  assert.equal(opened.manifest['forgetting_generation'], '1');
  assert.equal(
    logs.some((line) => line.includes('バックアップを取りました')),
    true,
  );
  // 取り直した後は、24 時間たつまで予定にならない。
  assert.equal(await r.handle.backup.due(), false);
});

// --- 定期の実行 ---

test('定期の実行: 設定がなければ動かず、1 日 1 回と忘却の置き換えを待つときに動き、失敗の後は 1 時間待つ', async () => {
  let clock = T0;
  let dueNow = false;
  let runs = 0;
  let succeed = true;
  const service = {
    due: () => Promise.resolve(dueNow),
    run: () => {
      runs += 1;
      return Promise.resolve(
        succeed
          ? ({
              ok: true,
              backup_id: 'b',
              sweep: { ok: true },
            } as unknown as Awaited<ReturnType<BackupService['run']>>)
          : ({
              ok: false,
              reasons: ['config_missing'],
              sweep: null,
            } as unknown as Awaited<ReturnType<BackupService['run']>>),
      );
    },
  } as unknown as BackupService;
  const timers: (() => void)[] = [];
  const logs: string[] = [];
  const scheduler = startBackupScheduler({
    service,
    log: (message) => logs.push(message),
    now: () => new Date(clock),
    setTimer: (run) => timers.push(run),
    clearTimer: () => undefined,
    checkIntervalMs: 15 * 60_000,
    retryAfterFailureMs: 60 * 60_000,
  });
  const tick = async (): Promise<void> => {
    const next = timers.shift();
    assert.ok(next !== undefined);
    next();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  await tick();
  assert.equal(runs, 0, '予定の前は動かない');
  dueNow = true;
  succeed = false;
  clock += 15 * 60_000;
  await tick();
  assert.equal(runs, 1);
  clock += 15 * 60_000;
  await tick();
  assert.equal(runs, 1, '失敗の後 1 時間は取り直さない');
  clock += 46 * 60_000;
  succeed = true;
  await tick();
  assert.equal(runs, 2, '1 時間を過ぎたら取り直す');
  dueNow = false;
  clock += BACKUP_INTERVAL_MS;
  await tick();
  assert.equal(runs, 2);
  scheduler.stop();
  assert.equal(timers.length <= 1, true);
  assert.equal(
    logs.some((line) => line.includes('config_missing')),
    true,
  );
});

test('due: 設定があり、まだ一度も取っていない・24 時間たった・取り直しが要るときだけ true', async (t) => {
  const none = await rig(t, { config: false });
  assert.equal(await none.handle.backup.due(), false);
  const r = await rig(t);
  assert.equal(await r.handle.backup.due(), true);
  await ready(r);
  const run = await r.handle.backup.run();
  assert.ok(run.ok);
  assert.equal(await r.handle.backup.due(), false);
  r.clock.value += BACKUP_INTERVAL_MS - 1;
  assert.equal(await r.handle.backup.due(), false);
  r.clock.value += 1;
  assert.equal(await r.handle.backup.due(), true);
  assert.ok((await stat(join(r.dataDir, BACKUP_STATE_FILE))).isFile());
});
