// 起動の秘密の扱い（cli-secrets.ts）の試験。期待値は手で書いた。実 API・実機の鍵は使わない。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeCommandRunner } from '@buddy/platform';
import { householdOptionsFor, takeStartupSecrets } from './cli-secrets.js';

// 合成の秘密。鍵に見える文字列はソースに置かず、実行時に組み立てる。
const RECEIPT_KEY = ['synthetic', 'receipt', 'credential', '0002'].join('-');
const OAUTH_SECRET = ['synthetic', 'oauth', 'client', 'material', '0003'].join(
  '-',
);

const PRINT_ENV_NAMES =
  'process.stdout.write(Object.keys(process.env).sort().join(","))';

test('秘密を読んだ後は process.env から消え、読んだ値だけが返る', () => {
  const env: NodeJS.ProcessEnv = {
    BUDDY_GEMINI_API_KEY: RECEIPT_KEY,
    BUDDY_GOOGLE_OAUTH_CLIENT_SECRET: OAUTH_SECRET,
    BUDDY_GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client-id',
  };
  const secrets = takeStartupSecrets(env);
  assert.deepEqual(secrets, {
    receiptApiKey: RECEIPT_KEY,
    googleClientSecret: OAUTH_SECRET,
  });
  // 秘密でないクライアント ID は残す。
  assert.deepEqual(env, {
    BUDDY_GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client-id',
  });
});

test('未設定・空は null で、形の違う値は落とさずそのまま返す（形の検査は起動の設定）', () => {
  assert.deepEqual(takeStartupSecrets({}), {
    receiptApiKey: null,
    googleClientSecret: null,
  });
  assert.deepEqual(
    takeStartupSecrets({
      BUDDY_GEMINI_API_KEY: '',
      BUDDY_GOOGLE_OAUTH_CLIENT_SECRET: '',
    }),
    { receiptApiKey: null, googleClientSecret: null },
  );
  assert.equal(
    takeStartupSecrets({ BUDDY_GEMINI_API_KEY: `${RECEIPT_KEY}\r` })
      .receiptApiKey,
    `${RECEIPT_KEY}\r`,
  );
});

test('消した後に実機用 runner が起動する子プロセスの環境に秘密が出ない（消す前は出る）', async (t) => {
  const names = ['BUDDY_GEMINI_API_KEY', 'BUDDY_GOOGLE_OAUTH_CLIENT_SECRET'];
  const saved = names.map((name) => [name, process.env[name]] as const);
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env['BUDDY_GEMINI_API_KEY'] = RECEIPT_KEY;
  process.env['BUDDY_GOOGLE_OAUTH_CLIENT_SECRET'] = OAUTH_SECRET;
  const runner = createNodeCommandRunner();
  const run = () => runner.run(process.execPath, ['-e', PRINT_ENV_NAMES]);
  // 対照: 消す前は子プロセスが親の環境を受け継ぐので、秘密の名前が見える。
  const before = (await run()).stdout.split(',');
  assert.ok(before.includes('BUDDY_GEMINI_API_KEY'));
  assert.ok(before.includes('BUDDY_GOOGLE_OAUTH_CLIENT_SECRET'));
  takeStartupSecrets(process.env);
  const after = await run();
  assert.equal(after.exitCode, 0);
  const afterNames = after.stdout.split(',');
  assert.ok(!afterNames.includes('BUDDY_GEMINI_API_KEY'));
  assert.ok(!afterNames.includes('BUDDY_GOOGLE_OAUTH_CLIENT_SECRET'));
  // 値も出力に出ない。
  assert.ok(!after.stdout.includes(RECEIPT_KEY));
  assert.ok(!after.stdout.includes(OAUTH_SECRET));
});

test('模擬の起動（mock・mock_unavailable）では household の provider を付けず、os のときだけ鍵を渡す', () => {
  assert.deepEqual(householdOptionsFor('mock', RECEIPT_KEY), {});
  assert.deepEqual(householdOptionsFor('mock_unavailable', RECEIPT_KEY), {});
  assert.ok(!('household' in householdOptionsFor('mock', RECEIPT_KEY)));
  assert.deepEqual(householdOptionsFor('os', RECEIPT_KEY), {
    household: { receiptProvider: { apiKey: RECEIPT_KEY } },
  });
  assert.deepEqual(householdOptionsFor('os', null), {
    household: { receiptProvider: { apiKey: null } },
  });
});
