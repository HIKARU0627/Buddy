// HTTPS の待ち受けの設定ファイル（https.json、ADR 0203 の U723）と、保存した設定で起動した Core の試験。
// アドレスは Tailscale の範囲（100.64.0.0/10・fd7a:115c:a1e0::/48）の合成値で、このマシンにはないアドレス。
// 期待値は手で書いた値。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './api-test-support.js';
import { startCli } from './cli-test-support.js';
import {
  HTTPS_CONFIG_FILE,
  checkHttpsListenConfig,
  loadHttpsConfig,
  saveHttpsConfig,
} from './https-config.js';

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));
const POSIX = process.platform !== 'win32';

test('保存できるのは Tailscale のアドレスと 1〜65535 のポートだけ', () => {
  assert.deepEqual(checkHttpsListenConfig('100.64.0.10', 47443), {
    ok: true,
    config: { host: '100.64.0.10', port: 47443 },
  });
  // IPv6 は正規化した形にする。
  assert.deepEqual(checkHttpsListenConfig('FD7A:115C:A1E0:0:0:0:0:1', 1), {
    ok: true,
    config: { host: 'fd7a:115c:a1e0::1', port: 1 },
  });
  const refused: [unknown, unknown, string][] = [
    ['0.0.0.0', 47443, 'https_host_unspecified'],
    ['::', 47443, 'https_host_unspecified'],
    ['192.168.1.10', 47443, 'https_host_not_allowed'],
    ['10.0.0.5', 47443, 'https_host_not_allowed'],
    ['100.128.0.1', 47443, 'https_host_not_allowed'],
    ['127.0.0.1', 47443, 'https_host_not_tailscale'],
    ['::1', 47443, 'https_host_not_tailscale'],
    ['hub.example.test', 47443, 'https_host_not_ip_address'],
    [7, 47443, 'https_host_not_ip_address'],
    ['100.64.0.10', 0, 'https_port_invalid'],
    ['100.64.0.10', 65_536, 'https_port_invalid'],
    ['100.64.0.10', 1.5, 'https_port_invalid'],
    ['100.64.0.10', '47443', 'https_port_invalid'],
  ];
  for (const [host, port, reason] of refused)
    assert.deepEqual(
      checkHttpsListenConfig(host, port),
      { ok: false, reason },
      `${String(host)}:${String(port)}`,
    );
});

test('保存して読み直せる。ないときは missing、形の違うファイルは invalid', async (t) => {
  const dataDir = join(await tempDir(t, 'buddy-https-config-'), 'data');
  assert.deepEqual(await loadHttpsConfig(dataDir), { kind: 'missing' });
  // データディレクトリがまだなくても作って書く（自動起動の設定を先に行う場合）。
  await saveHttpsConfig(dataDir, { host: '100.64.0.10', port: 47443 });
  assert.equal(
    await readFile(join(dataDir, HTTPS_CONFIG_FILE), 'utf8'),
    '{"host":"100.64.0.10","port":47443}\n',
  );
  if (POSIX)
    assert.equal(
      (await stat(join(dataDir, HTTPS_CONFIG_FILE))).mode & 0o777,
      0o600,
    );
  assert.deepEqual(await loadHttpsConfig(dataDir), {
    kind: 'ok',
    config: { host: '100.64.0.10', port: 47443 },
  });
  await assert.rejects(
    saveHttpsConfig(dataDir, { host: '0.0.0.0', port: 47443 }),
    TypeError,
  );
  const cases: [string, string][] = [
    [
      '{"host":"0.0.0.0","port":47443}',
      'https_config_invalid:https_host_unspecified',
    ],
    ['{"host":"100.64.0.10"}', 'https_config_invalid'],
    ['{"host":"100.64.0.10","port":47443,"x":1}', 'https_config_invalid'],
    [
      '{"host":"100.64.0.10","port":47443,"host":"100.64.0.11"}',
      'https_config_unreadable',
    ],
    [
      '{"host":"FD7A:115C:A1E0::1","port":47443}',
      'https_config_invalid:https_host_not_normalized',
    ],
    ['[]', 'https_config_invalid'],
    ['not json', 'https_config_unreadable'],
  ];
  for (const [text, reason] of cases) {
    await writeFile(join(dataDir, HTTPS_CONFIG_FILE), text, { mode: 0o600 });
    assert.deepEqual(
      await loadHttpsConfig(dataDir),
      { kind: 'invalid', reason },
      text,
    );
  }
  await writeFile(join(dataDir, HTTPS_CONFIG_FILE), 'x'.repeat(2048), {
    mode: 0o600,
  });
  assert.deepEqual(await loadHttpsConfig(dataDir), {
    kind: 'invalid',
    reason: 'https_config_too_large',
  });
});

test(
  '本人以外が書ける https.json は使わない（POSIX）',
  { skip: !POSIX },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-https-config-'), 'data');
    await saveHttpsConfig(dataDir, { host: '100.64.0.10', port: 47443 });
    await chmod(join(dataDir, HTTPS_CONFIG_FILE), 0o666);
    assert.deepEqual(await loadHttpsConfig(dataDir), {
      kind: 'invalid',
      reason: 'https_config_writable_by_others',
    });
    // Windows の判定（ACL は別の作業）では権限を見ない。
    assert.equal(
      (await loadHttpsConfig(dataDir, { platform: 'win32' })).kind,
      'ok',
    );
  },
);

// 上限は呼び出し元の試験の期限（signal）だけ。
function runCli(
  signal: AbortSignal,
  args: readonly string[],
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      signal,
    });
    let stdout = '';
    child.stdout
      .setEncoding('utf8')
      .on('data', (text: string) => (stdout += text));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

test(
  'start --save と autostart enable --https-host は Tailscale のアドレスだけを https.json に保存する',
  { timeout: 60_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-https-save-'), 'data');
    // 保存できないアドレス・--save の誤用は使い方の誤り（2）で、ファイルを書かない。
    for (const args of [
      ['start', '--https-host', '0.0.0.0', '--save'],
      ['start', '--https-host', '192.168.1.10', '--save'],
      ['start', '--https-host', '127.0.0.1', '--save'],
      ['start', '--https-host', '100.64.0.10', '--https-port', '0', '--save'],
      ['start', '--save'],
      ['status', '--save'],
      ['autostart', 'enable', '--https-host', '0.0.0.0'],
      ['autostart', 'status', '--https-host', '100.64.0.10'],
    ]) {
      const result = await runCli(t.signal, [...args, '--data-dir', dataDir]);
      assert.equal(result.code, 2, args.join(' '));
    }
    assert.deepEqual(await loadHttpsConfig(dataDir), { kind: 'missing' });
    // autostart enable は登録より前に保存する（Linux では登録が unsupported で 6。保存は残る）。
    // macOS・Windows では本物の LaunchAgent・タスクを作ってしまうので、ここから先は Linux だけで確かめる。
    if (process.platform !== 'linux') return;
    const enabled = await runCli(t.signal, [
      'autostart',
      'enable',
      '--https-host',
      '100.64.0.10',
      '--https-port',
      '47444',
      '--data-dir',
      dataDir,
    ]);
    const lines = enabled.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines[0], { event: 'https_config_saved', port: 47444 });
    // 標準出力に待ち受けのアドレスを出さない。
    assert.ok(!enabled.stdout.includes('100.64.0.10'));
    assert.deepEqual(await loadHttpsConfig(dataDir), {
      kind: 'ok',
      config: { host: '100.64.0.10', port: 47444 },
    });
  },
);

test(
  '保存した https.json のアドレスがまだないときは、Core を起動して HTTPS を pending にし、アドレスを出さない',
  { timeout: 60_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-https-pending-'), 'data');
    await mkdir(dataDir, { recursive: true });
    // このマシンにない Tailscale のアドレス（待ち受けは EADDRNOTAVAIL）。
    await saveHttpsConfig(dataDir, { host: '100.64.0.123', port: 47445 });
    const core = await startCli(t, [
      '--mock-key-protection',
      '--data-dir',
      dataDir,
    ]);
    const pending = core.events.find(
      (event) => event['event'] === 'https_pending',
    );
    assert.ok(pending);
    assert.equal(pending['host'], undefined);
    assert.equal(pending['port'], 47445);
    assert.equal(core.running['https'], 'pending');
    assert.ok(
      !core.events.some((event) => event['event'] === 'https_listening'),
    );
    // ログ（標準エラー）にもアドレスを出さない。
    assert.ok(!core.stderr().includes('100.64.0.123'));
    const status = await runCli(t.signal, ['status', '--data-dir', dataDir]);
    assert.equal(status.code, 0);
    assert.equal(
      (JSON.parse(status.stdout.trim()) as Record<string, unknown>)['https'],
      'pending',
    );
    assert.equal(
      (await runCli(t.signal, ['stop', '--data-dir', dataDir])).code,
      0,
    );
    assert.equal((await core.exited).code, 0);
  },
);

test(
  'コマンドラインの --https-host は従来どおり、アドレスがなければ起動を拒否する（https.json より優先）',
  { timeout: 60_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-https-cmdline-'), 'data');
    await saveHttpsConfig(dataDir, { host: '100.64.0.123', port: 47445 });
    const refused = await runCli(t.signal, [
      'start',
      '--mock-key-protection',
      '--https-host',
      '100.64.0.124',
      '--https-port',
      '47446',
      '--data-dir',
      dataDir,
    ]);
    assert.equal(refused.code, 4);
    const last = JSON.parse(
      refused.stdout.trim().split('\n').at(-1) as string,
    ) as Record<string, unknown>;
    assert.equal(last['code'], 'https_listen_failed');
    // 壊れた https.json は使わず、起動を拒否する。
    await writeFile(
      join(dataDir, HTTPS_CONFIG_FILE),
      '{"host":"0.0.0.0","port":1}',
      {
        mode: 0o600,
      },
    );
    const invalid = await runCli(t.signal, [
      'start',
      '--mock-key-protection',
      '--data-dir',
      dataDir,
    ]);
    assert.equal(invalid.code, 4);
    assert.equal(
      (
        JSON.parse(
          invalid.stdout.trim().split('\n').at(-1) as string,
        ) as Record<string, unknown>
      )['code'],
      'https_config_invalid',
    );
  },
);
