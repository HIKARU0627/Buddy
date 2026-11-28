// ログイン後の自動起動の設定（設計 02、決定事項 J01・質問129、ADR 0013・0203）。
// 本人が enable を選んだときだけ登録し、登録しても即時には起動しない（loadNow: false）。
// 実行中の Core と二重に起動しないためで、次のログインから有効になる。停止は buddy-core stop で行う。
// macOS は LaunchAgent（ADR 0013）、Windows は本人のログオン時に動くタスク（ADR 0203）。
// Windows のタスクは `autostart launch` を呼び、launch が Core（start）を窓のない別のプロセスとして起動してすぐ終わる。
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createStartupSupervisor,
  macHostDiagnosticWarnings,
  readMacHostDiagnostics,
  readWindowsHostDiagnostics,
  windowsHostDiagnosticWarnings,
} from '@buddy/platform';
import type { CommandRunner } from '@buddy/platform';

export type AutostartAction = 'enable' | 'disable' | 'status';

export interface AutostartDeps {
  readonly nodePlatform: string;
  readonly runner: CommandRunner;
  readonly homeDir: string;
  readonly uid: number | undefined;
  // Windows の %SystemRoot%（コマンドの絶対パスに使う）。Windows 以外では使わない。
  readonly systemRoot?: string | undefined;
  // LaunchAgent・タスクが起動する node と CLI の絶対パス。
  readonly nodePath: string;
  readonly coreCliPath: string;
}

export interface AutostartOutcome {
  readonly ok: boolean;
  readonly output: Record<string, unknown>;
}

export async function runAutostart(
  action: AutostartAction,
  dataDir: string,
  deps: AutostartDeps,
): Promise<AutostartOutcome> {
  const supervisor = createStartupSupervisor({
    nodePlatform: deps.nodePlatform,
    runner: deps.runner,
    homeDir: deps.homeDir,
    uid: deps.uid,
    systemRoot: deps.systemRoot,
  });
  if (action === 'enable') {
    const result = await supervisor.register({
      enabled: true,
      loadNow: false,
      launch: {
        nodePath: deps.nodePath,
        coreCliPath: deps.coreCliPath,
        dataDir,
      },
    });
    return { ok: result.status === 'registered', output: { ...result } };
  }
  if (action === 'disable') {
    const result = await supervisor.unregister({ unloadNow: false });
    return { ok: result.status === 'unregistered', output: { ...result } };
  }
  const result = await supervisor.status();
  if (result.status !== 'ok') return { ok: false, output: { ...result } };
  // スリープする設定・FileVault の無効（Windows はスリープ・休止状態）は警告だけを出す。起動の可否は決めない。
  const warnings =
    supervisor.platform === 'windows'
      ? windowsHostDiagnosticWarnings(
          await readWindowsHostDiagnostics(deps.runner, deps.systemRoot),
        )
      : macHostDiagnosticWarnings(await readMacHostDiagnostics(deps.runner));
  return { ok: true, output: { ...result, warnings } };
}

export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface AutostartLaunchDeps {
  readonly nodePlatform: string;
  readonly nodePath: string;
  readonly coreCliPath: string;
  // 試験で差し替える（既定は node:child_process の spawn）。
  readonly spawn?: SpawnFunction;
}

/**
 * Windows のタスクから呼ばれる起動役（`buddy-core autostart launch`）。Core（`start --data-dir <path>`）を
 * 窓のない切り離したプロセスとして起動し、標準出力・標準エラーをデータディレクトリの logs/ の core.out.log・
 * core.err.log に追記させて、起動を見届けたらすぐ終わる（ADR 0203）。二重起動は Core の単一起動のロックが拒否する。
 * 秘密は渡さない（環境変数はタスクの環境そのまま。鍵は Core が鍵保護から読む）。
 */
export async function runAutostartLaunch(
  dataDir: string,
  deps: AutostartLaunchDeps,
): Promise<AutostartOutcome> {
  if (deps.nodePlatform !== 'win32')
    return {
      ok: false,
      output: {
        status: 'unsupported',
        reason: 'autostart_launch_windows_only',
      },
    };
  const logs = join(dataDir, 'logs');
  let out;
  let err;
  try {
    await mkdir(logs, { recursive: true, mode: 0o700 });
    out = await open(join(logs, 'core.out.log'), 'a', 0o600);
    err = await open(join(logs, 'core.err.log'), 'a', 0o600);
  } catch (error) {
    await out?.close();
    const code = (error as { code?: unknown } | null)?.code;
    return {
      ok: false,
      output: {
        status: 'failed',
        step: 'open_logs',
        reasons: [`fs_error:${typeof code === 'string' ? code : 'unknown'}`],
      },
    };
  }
  try {
    const spawn = deps.spawn ?? (nodeSpawn as SpawnFunction);
    let child: ChildProcess | null = null;
    try {
      child = spawn(
        deps.nodePath,
        [deps.coreCliPath, 'start', '--data-dir', dataDir],
        {
          // Windows では DETACHED_PROCESS（コンソールなし）で起動し、起動役が終わっても残す。
          detached: true,
          windowsHide: true,
          shell: false,
          stdio: ['ignore', out.fd, err.fd],
        },
      );
    } catch {
      child = null;
    }
    const spawned = child;
    const started =
      spawned !== null &&
      (await new Promise<boolean>((resolve) => {
        spawned.once('spawn', () => resolve(true));
        spawned.once('error', () => resolve(false));
      }));
    if (!started || spawned === null)
      return {
        ok: false,
        output: { status: 'failed', step: 'spawn', reasons: ['spawn_failed'] },
      };
    spawned.unref();
    return { ok: true, output: { status: 'launched' } };
  } finally {
    await out.close();
    await err.close();
  }
}
