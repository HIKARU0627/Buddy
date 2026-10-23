// 最初の端末の CLI（buddy-core first-device start | approve）と制御チャネルの命令の試験（ADR 0021）。
// ビルド済みの CLI を子プロセスで動かす。鍵は模擬（--mock-key-protection）、待ち受けは 127.0.0.1。
// 期待値（終了コード・理由）は手で書いた値。コード・秘密・トークンは出力のアサーションのメッセージに入れない。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMockKeyStore } from '@buddy/platform';
import { onCleanup, pinnedRequest, tempDir } from './api-test-support.js';
import { parseControlRequest } from './control-protocol.js';
import { startCore } from './core.js';
import { startCli } from './cli-test-support.js';
import {
  claimPairing,
  containsAny,
  createClaimSecret,
  fetchPeerCertificate,
  pickupToken,
  requireFingerprint,
} from './pairing-test-support.js';

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));

function runCli(
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout += text;
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr += text;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const lastJson = (stdout: string): Record<string, unknown> =>
  JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as Record<
    string,
    unknown
  >;

test(
  'buddy-core first-device registers the first device only while none is registered',
  { timeout: 90_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-first-cli-'), 'data');
    const core = await startCli(t, [
      '--mock-key-protection',
      '--https-host',
      '127.0.0.1',
      '--https-port',
      '0',
      '--data-dir',
      dataDir,
    ]);
    const listening = core.events.find(
      (event) => event['event'] === 'https_listening',
    );
    assert(listening);
    const host = String(listening['host']);
    const port = Number(listening['port']);

    // 承認の前にペアリング ID が要る（使い方の誤り）。
    assert.equal(
      (await runCli(['first-device', 'approve', '--data-dir', dataDir])).code,
      2,
    );
    assert.equal(
      (
        await runCli([
          'first-device',
          'start',
          '--pairing-id',
          randomUUID(),
          '--data-dir',
          dataDir,
        ])
      ).code,
      2,
    );
    const started = await runCli([
      'first-device',
      'start',
      '--data-dir',
      dataDir,
    ]);
    assert.equal(started.code, 0);
    const session = lastJson(started.stdout);
    assert.equal(session['ok'], true);
    assert.equal(
      session['certificate_fingerprint'],
      listening['certificate_fingerprint'],
    );
    const code = String(session['pairing_code']);
    assert.match(code, /^[0-9]{8}$/u);
    // 人が見比べる指紋は、端末の画面と同じ 4 桁区切り・4 行で stderr に出る（最後の 4 桁は端末に入力する）。
    const fingerprint = String(session['certificate_fingerprint']);
    const humanLines = started.stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^([0-9a-f]{4} ){3}[0-9a-f]{4}$/u.test(line));
    assert.equal(humanLines.length, 4);
    assert.equal(humanLines.join('').replaceAll(' ', ''), fingerprint);
    assert.match(started.stderr, /最後の 4 桁を端末に入力/u);
    const pairingId = String(session['pairing_id']);

    // 承認の前（申請がない）は拒否する。
    const early = await runCli([
      'first-device',
      'approve',
      '--pairing-id',
      pairingId,
      '--data-dir',
      dataDir,
    ]);
    assert.equal(early.code, 7);
    assert.equal(lastJson(early.stdout)['reason'], 'claim_not_found');

    // 同じマシンの端末: 証明書を受け取り、CLI の表示の指紋と比べてから申請する。
    const peer = await fetchPeerCertificate(host, port);
    const target = requireFingerprint(
      host,
      port,
      peer,
      String(session['certificate_fingerprint']),
    );
    const secret = createClaimSecret();
    const claim = await claimPairing(target, code, secret, {
      name: '中枢の画面',
      platform: 'macos',
    });
    assert.equal(claim.status, 202);
    const claimId = String(claim.json?.['claim_id']);
    // 承認の前の受取りは 409。
    assert.equal(
      (await pickupToken(target, claimId, secret.secret)).status,
      409,
    );

    const approved = await runCli([
      'first-device',
      'approve',
      '--pairing-id',
      pairingId,
      '--data-dir',
      dataDir,
    ]);
    assert.equal(approved.code, 0);
    const approval = lastJson(approved.stdout);
    assert.equal(approval['ok'], true);
    assert.equal(approval['claim_id'], claimId);
    assert.equal(approval['status'], 'approved');
    assert.equal(approval['device_name'], '中枢の画面');

    const picked = await pickupToken(target, claimId, secret.secret);
    assert.equal(picked.status, 200);
    const token = String(picked.json?.['device_token']);
    const boot = await pinnedRequest(target, {
      method: 'GET',
      path: '/v1/bootstrap',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(boot.status, 200);
    assert.equal(boot.json?.['device_id'], picked.json?.['device_id']);
    // 2 回目の受取りは 410。
    assert.equal(
      (await pickupToken(target, claimId, secret.secret)).status,
      410,
    );

    // 1 台でも登録があれば、CLI の開始は拒否する（終了コード 7）。
    const refused = await runCli([
      'first-device',
      'start',
      '--data-dir',
      dataDir,
    ]);
    assert.equal(refused.code, 7);
    assert.deepEqual(lastJson(refused.stdout), {
      ok: false,
      error: 'refused',
      reason: 'devices_registered',
    });
    const refusedApprove = await runCli([
      'first-device',
      'approve',
      '--pairing-id',
      pairingId,
      '--data-dir',
      dataDir,
    ]);
    assert.equal(refusedApprove.code, 7);
    // 不正なペアリング ID は制御チャネルが形式で拒否する（使い方の誤り）。
    assert.equal(
      (
        await runCli([
          'first-device',
          'approve',
          '--pairing-id',
          'not-a-uuid',
          '--data-dir',
          dataDir,
        ])
      ).code,
      2,
    );

    assert.equal((await runCli(['stop', '--data-dir', dataDir])).code, 0);
    assert.equal((await core.exited).code, 0);
    // Core のログ（標準エラー）・機械向けの出力にコード・秘密・トークンを出さない。
    const coreOutput = `${core.stderr()}\n${JSON.stringify(core.events)}`;
    assert.equal(
      containsAny(coreOutput, [code, secret.secret, secret.hash, token]),
      false,
    );
    assert(core.stderr().includes(claimId));
    // 動いている Core がなければ終了コード 3。
    assert.equal(
      (await runCli(['first-device', 'start', '--data-dir', dataDir])).code,
      3,
    );
  },
);

test(
  'first-device is refused without HTTPS and while the core is not running',
  { timeout: 60_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-first-nohttps-'), 'data');
    const handle = await startCore({
      dataDir,
      keyStore: createMockKeyStore({
        stored: Buffer.alloc(32, 0x5c).toString('base64'),
      }),
      shutdownGraceMs: 200,
      probeTimeoutMs: 300,
    });
    onCleanup(t, () => handle.stop('test').catch(() => undefined));
    assert.equal(handle.pairing, null);
    const refused = await runCli([
      'first-device',
      'start',
      '--data-dir',
      dataDir,
    ]);
    assert.equal(refused.code, 7);
    assert.equal(lastJson(refused.stdout)['reason'], 'https_not_configured');
    await handle.stop('test');
    assert.equal(
      (await runCli(['first-device', 'start', '--data-dir', dataDir])).code,
      3,
    );
  },
);

test('the control protocol accepts the first-device operations strictly', () => {
  const parse = (value: unknown) =>
    parseControlRequest(Buffer.from(JSON.stringify(value), 'utf8'));
  const requestId = randomUUID();
  const pairingId = randomUUID();
  assert.deepEqual(
    parse({ op: 'pairing_first_start', request_id: requestId }),
    {
      ok: true,
      request: { op: 'pairing_first_start', request_id: requestId },
    },
  );
  assert.deepEqual(
    parse({
      op: 'pairing_first_approve',
      request_id: requestId,
      pairing_id: pairingId,
    }),
    {
      ok: true,
      request: {
        op: 'pairing_first_approve',
        request_id: requestId,
        pairing_id: pairingId,
      },
    },
  );
  const reasonOf = (value: unknown) => {
    const result = parse(value);
    return result.ok ? null : result.reason;
  };
  assert.equal(
    reasonOf({ op: 'pairing_first_approve', request_id: requestId }),
    'missing_field',
  );
  assert.equal(
    reasonOf({
      op: 'pairing_first_approve',
      request_id: requestId,
      pairing_id: 'x',
    }),
    'invalid_pairing_id',
  );
  assert.equal(
    reasonOf({
      op: 'pairing_first_approve',
      request_id: requestId,
      pairing_id: 1,
    }),
    'invalid_type',
  );
  // pairing_id は承認だけ。他の命令に付ければ未知の項目。
  assert.equal(
    reasonOf({
      op: 'pairing_first_start',
      request_id: requestId,
      pairing_id: pairingId,
    }),
    'unknown_field',
  );
  assert.equal(
    reasonOf({ op: 'status', request_id: requestId, pairing_id: pairingId }),
    'unknown_field',
  );
  assert.equal(
    reasonOf({
      op: 'pairing_first_approve',
      request_id: requestId,
      pairing_id: pairingId,
      code: '12345678',
    }),
    'unknown_field',
  );
});
