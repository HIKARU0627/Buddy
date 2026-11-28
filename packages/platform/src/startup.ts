// 実行中の OS に合う起動・監督アダプターを選ぶ（macOS は ADR 0013、Windows は ADR 0203）。
import { createMacLaunchAgentSupervisor } from './macos-launch-agent.js';
import type { CommandRunner } from './runner.js';
import type { StartupSupervisor } from './supervisor.js';
import { createWindowsScheduledTaskSupervisor } from './windows-scheduled-task.js';
import {
  corePlatformOf,
  createUnsupportedStartupSupervisor,
} from './supervisor.js';

export interface StartupSupervisorOptions {
  /** Core では process.platform。 */
  readonly nodePlatform: string;
  readonly runner: CommandRunner;
  /** Core では os.homedir()。macOS 以外では使わない。 */
  readonly homeDir: string;
  /** Core では process.getuid?.()。macOS 以外では使わない。 */
  readonly uid: number | undefined;
  /** Core では process.env.SystemRoot。Windows 以外では使わない。 */
  readonly systemRoot?: string | undefined;
}

export function createStartupSupervisor(
  options: StartupSupervisorOptions,
): StartupSupervisor {
  const platform = corePlatformOf(options.nodePlatform);
  if (platform === 'windows')
    return createWindowsScheduledTaskSupervisor({
      runner: options.runner,
      systemRoot: options.systemRoot,
    });
  if (platform !== 'macos') return createUnsupportedStartupSupervisor(platform);
  if (options.uid === undefined)
    throw new TypeError('macOS では uid が必要です。');
  return createMacLaunchAgentSupervisor({
    runner: options.runner,
    homeDir: options.homeDir,
    uid: options.uid,
  });
}
