// OS のコマンド実行を注入できるようにする境界（ADR 0013）。
// アダプターは launchctl・pmset・fdesetup・security をこの runner 経由でだけ実行する。
// 試験では模擬の runner を渡し、実機の登録や設定の読み取りを行わない。
import { execFile } from 'node:child_process';

export interface CommandResult {
  /** 終了コード。起動できなかった・時間切れ・シグナルで終了した場合は null。 */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[]): Promise<CommandResult>;
}

export interface RecordedCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** 試験用の模擬 runner。実行せずに呼び出しを記録し、respond の結果を返す。 */
export interface MockCommandRunner extends CommandRunner {
  readonly kind: 'mock';
  readonly calls: readonly RecordedCommand[];
}

export function createMockCommandRunner(
  respond: (command: string, args: readonly string[]) => CommandResult,
): MockCommandRunner {
  const calls: RecordedCommand[] = [];
  return {
    kind: 'mock',
    calls,
    run(command, args) {
      calls.push({ command, args: [...args] });
      return Promise.resolve(respond(command, args));
    },
  };
}

export interface NodeCommandRunnerOptions {
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * 実機用の runner。shell を経由せず execFile で実行する（引数の展開・注入を避ける）。
 * 例外は投げず、起動失敗も exitCode: null の結果として返す。
 */
export function createNodeCommandRunner(
  options: NodeCommandRunnerOptions = {},
): CommandRunner {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    run(command, args) {
      return new Promise((resolve) => {
        execFile(
          command,
          [...args],
          {
            encoding: 'utf8',
            shell: false,
            timeout,
            maxBuffer: MAX_OUTPUT_BYTES,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            if (!error) {
              resolve({ exitCode: 0, stdout, stderr });
              return;
            }
            const code = (error as { code?: unknown }).code;
            const killed = (error as { killed?: unknown }).killed === true;
            resolve({
              exitCode: typeof code === 'number' && !killed ? code : null,
              stdout,
              stderr,
            });
          },
        );
      });
    },
  };
}
