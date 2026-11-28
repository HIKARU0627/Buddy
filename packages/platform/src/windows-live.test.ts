// Windows の CI（windows-latest）でだけ動く試験（ADR 0203）。実際の whoami・PowerShell・schtasks・powercfg・netsh を
// 呼び、出力の形が模擬の試験の前提（合成の値）と合うことを確かめる。ほかの OS では飛ばす。
// CI の機械の値（SID・アドレス・MAC）は記録に出さない（assert の失敗の文言にも値を入れない）。
// タスクは試験ごとの別の名前で作り、終わったら必ず消す（本物の BuddyCore には触れない）。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHomeFingerprintCollector } from './home-fingerprint.js';
import { createNodeCommandRunner } from './runner.js';
import {
  fetchTailscaleStatus,
  tailscaleCommandsFor,
} from './tailscale-status.js';
import { readWindowsHostDiagnostics } from './windows-diagnostics.js';
import { powerShellArgs } from './windows-paths.js';
import {
  createWindowsScheduledTaskSupervisor,
  parseWhoamiUserSid,
  parseWindowsTaskQuery,
  windowsCoreCommandPaths,
  windowsTaskQueryScript,
} from './windows-scheduled-task.js';

const windowsOnly = {
  skip: process.platform !== 'win32',
  timeout: 120_000,
};

const runner = createNodeCommandRunner({ timeoutMs: 60_000 });
const systemRoot = process.env['SystemRoot'];

function paths() {
  const found = windowsCoreCommandPaths(systemRoot);
  assert.ok(found !== null, 'SystemRoot から絶対パスを作れない');
  return found;
}

test(
  'Windows の実機: whoami の CSV から本人の SID を読める',
  windowsOnly,
  async () => {
    const result = await runner.run(paths().whoami, [
      '/user',
      '/fo',
      'csv',
      '/nh',
    ]);
    assert.equal(result.exitCode, 0, 'whoami が失敗した');
    assert.ok(parseWhoamiUserSid(result.stdout) !== null, 'SID を読めない');
  },
);

test(
  'Windows の実機: ないタスクの問い合わせは {"found":false} になる',
  windowsOnly,
  async () => {
    const name = `BuddyCoreAbsent-${randomUUID().slice(0, 8)}`;
    const result = await runner.run(
      paths().powershell,
      powerShellArgs(windowsTaskQueryScript(name)),
    );
    assert.equal(result.exitCode, 0, 'PowerShell の問い合わせが失敗した');
    assert.deepEqual(parseWindowsTaskQuery(result.stdout), { found: false });
  },
);

test(
  'Windows の実機: ログオン時のタスクを作り、状態を読み、消せる（管理者の権限を求めない定義）',
  windowsOnly,
  async (t) => {
    const taskName = `BuddyCoreTest-${randomUUID().slice(0, 8)}`;
    const dataDir = await mkdtemp(join(tmpdir(), 'buddy-task-'));
    const cli = join(dataDir, 'cli.js');
    await writeFile(cli, '// synthetic\n');
    t.after(async () => {
      await runner.run(paths().schtasks, [
        '/Delete',
        '/TN',
        `\\${taskName}`,
        '/F',
      ]);
      await rm(dataDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });
    const supervisor = createWindowsScheduledTaskSupervisor({
      runner,
      systemRoot,
      taskName,
    });
    const leftovers = async () =>
      (await readdir(tmpdir())).filter((name) =>
        /^buddy-autostart-task\..*\.xml$/u.test(name),
      );
    const before = await leftovers();
    const registered = await supervisor.register({
      enabled: true,
      loadNow: false,
      launch: { nodePath: process.execPath, coreCliPath: cli, dataDir },
    });
    assert.deepEqual(registered, {
      status: 'registered',
      definitionPath: `\\${taskName}`,
      loaded: false,
      alreadyLoaded: false,
    });
    assert.deepEqual(await supervisor.status(), {
      status: 'ok',
      platform: 'windows',
      definitionPath: `\\${taskName}`,
      installed: true,
      load: 'loaded',
    });
    // 一時の定義ファイル（os.tmpdir() に置く）を残さない。データディレクトリにも置かない。ログのディレクトリは作る。
    assert.deepEqual(await leftovers(), before);
    assert.deepEqual((await readdir(dataDir)).sort(), ['cli.js', 'logs']);
    assert.ok(existsSync(join(dataDir, 'logs')));
    // 登録した定義を XML で読み直し、失敗時の再起動・時間の上限・高い権限がないことを確かめる。
    const exported = await runner.run(paths().schtasks, [
      '/Query',
      '/TN',
      `\\${taskName}`,
      '/XML',
    ]);
    assert.equal(exported.exitCode, 0, 'タスクの定義を読めない');
    assert.ok(
      /<LogonType>InteractiveToken<\/LogonType>/u.test(exported.stdout),
      '定義に期待の項目がない',
    );
    // Task Scheduler は書き出しで既定値の RunLevel（LeastPrivilege）を省くので、ないか LeastPrivilege かを見る。
    const runLevel = /<RunLevel>([^<]*)<\/RunLevel>/u.exec(exported.stdout);
    assert.ok(
      runLevel === null || runLevel[1] === 'LeastPrivilege',
      '高い権限の定義になっている',
    );
    assert.ok(
      !exported.stdout.includes('HighestAvailable'),
      '高い権限の定義になっている',
    );
    // 登録された定義そのものの権限を ScheduledTasks モジュールで読み、Limited（最小の権限）であることを確かめる。
    const principal = await runner.run(
      paths().powershell,
      powerShellArgs(
        `$ErrorActionPreference = 'Stop'; [string](Get-ScheduledTask -TaskPath '\\' -TaskName '${taskName}').Principal.RunLevel`,
      ),
    );
    assert.equal(principal.exitCode, 0, 'タスクの権限を読めない');
    assert.equal(principal.stdout.trim(), 'Limited');
    assert.ok(
      /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/u.test(exported.stdout),
      '定義に期待の項目がない',
    );
    assert.ok(
      /<LogonTrigger>/u.test(exported.stdout),
      '定義に期待の項目がない',
    );
    assert.ok(
      !exported.stdout.includes('RestartOnFailure'),
      '失敗時の再起動がある',
    );
    assert.ok(
      exported.stdout.includes(' autostart launch --data-dir '),
      '起動役の引数がない',
    );
    assert.deepEqual(await supervisor.unregister({ unloadNow: false }), {
      status: 'unregistered',
      removedDefinition: true,
      bootedOut: false,
    });
    assert.deepEqual(await supervisor.status(), {
      status: 'ok',
      platform: 'windows',
      definitionPath: `\\${taskName}`,
      installed: false,
      load: 'not_loaded',
    });
  },
);

// CI の機械（Azure の VM）では電源のプランの設定が隠れている・ない場合があるので unknown も許す。
// ここでは powercfg・reg の呼び出しが例外にならず、読めた値が形どおりであることだけを確かめる。
test(
  'Windows の実機: powercfg・reg の呼び出しが動き、例外にならない',
  windowsOnly,
  async () => {
    const diagnostics = await readWindowsHostDiagnostics(runner, systemRoot);
    for (const setting of [diagnostics.systemSleep, diagnostics.hibernate])
      assert.ok(['never', 'after_idle', 'unknown'].includes(setting.state));
    assert.ok([true, false, null].includes(diagnostics.hibernateAvailable));
  },
);

test(
  'Windows の実機: tailscale.exe がなければ起動できない扱いになり、例外にしない',
  windowsOnly,
  async () => {
    const commands = tailscaleCommandsFor('win32', process.env);
    assert.ok(commands.length >= 1);
    assert.ok(commands.every((command) => /^[A-Za-z]:\\/u.test(command)));
    const status = await fetchTailscaleStatus(runner, commands);
    if (!commands.some((command) => existsSync(command)))
      assert.deepEqual(status, {
        ok: false,
        reason: 'tailscale_command_unavailable',
      });
  },
);

test(
  'Windows の実機: 自宅の指紋の PowerShell のスクリプトが動き、既定のゲートウェイを読める',
  windowsOnly,
  async () => {
    const collector = createHomeFingerprintCollector({
      platform: 'win32',
      runner,
      networkInterfaces: () => networkInterfaces(),
    });
    const observation = await collector.collect();
    assert.ok(
      !observation.unavailable.includes('system_root_unavailable'),
      'SystemRoot を使えない',
    );
    assert.ok(
      !observation.unavailable.includes('gateway_unavailable'),
      '既定のゲートウェイを読めない',
    );
    // 値は出さない。形だけを確かめる。
    assert.ok(
      observation.gateway_mac === null ||
        /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/u.test(observation.gateway_mac),
    );
  },
);
