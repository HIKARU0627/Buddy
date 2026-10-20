// ログイン後の自動起動の設定（設計 02、決定事項 J01・質問129、ADR 0013）。
// 本人が enable を選んだときだけ LaunchAgent を登録し、登録しても即時には起動しない（loadNow: false）。
// 実行中の Core と二重に起動しないためで、次のログインから有効になる。停止は buddy-core stop で行う。
import {
  createStartupSupervisor,
  macHostDiagnosticWarnings,
  readMacHostDiagnostics,
} from '@buddy/platform';
import type { CommandRunner } from '@buddy/platform';

export type AutostartAction = 'enable' | 'disable' | 'status';

export interface AutostartDeps {
  readonly nodePlatform: string;
  readonly runner: CommandRunner;
  readonly homeDir: string;
  readonly uid: number | undefined;
  // LaunchAgent が起動する node と CLI の絶対パス。
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
  // スリープする設定・FileVault の無効は警告だけを出す。起動の可否は決めない（ADR 0013）。
  const warnings = macHostDiagnosticWarnings(
    await readMacHostDiagnostics(deps.runner),
  );
  return { ok: true, output: { ...result, warnings } };
}
