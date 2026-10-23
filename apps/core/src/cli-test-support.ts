// CLI の常駐起動を通知で待つ試験専用の道具（Issue #108）。
// 起動だけの固定期限は置かず、呼び出し元の試験の期限（signal）を使う。
// 子プロセスの終了を待ってから一時ディレクトリを消す（Windows のファイルロック）。
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import type test from 'node:test';
import { fileURLToPath } from 'node:url';
import { onCleanup } from './api-test-support.js';

type Json = Record<string, unknown>;
const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));

export function observeCliStart(child: ChildProcess, signal: AbortSignal) {
  if (child.stdout === null || child.stderr === null)
    throw new Error('起動の観測には stdout と stderr の pipe が必要です。');
  const started = performance.now();
  const events: Json[] = [];
  let stdout = '';
  let stderr = '';
  let stage = 'process_start';
  let resolveRunning: (event: Json) => void;
  let rejectRunning: (error: Error) => void;
  const running = new Promise<Json>((resolve, reject) => {
    resolveRunning = resolve;
    rejectRunning = reject;
  });
  // 後始末や spawn の失敗が、呼び出し側の await より先でも未処理の拒否にしない。
  void running.catch(() => undefined);
  const fail = (reason: string) => {
    signal.removeEventListener('abort', aborted);
    // 生の stderr・JSON・例外にはパスや秘密が混じり得るので、固定の分類と経過だけを出す。
    rejectRunning(
      new Error(
        `CLI 起動失敗: ${reason}; stage=${stage}; elapsed_ms=${Math.round(performance.now() - started)}`,
      ),
    );
  };
  const aborted = () => fail('test_aborted');
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    stderr += text;
    if (stderr.includes('HTTPS を待ち受けました')) stage = 'https_listening';
    else if (stderr.includes('DB を開きました')) stage = 'store_opened';
    else if (stderr.includes('模擬の鍵保護で起動します')) stage = 'starting';
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    stdout += `${line}\n`;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      fail('invalid_json');
      return;
    }
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      fail('invalid_event');
      return;
    }
    const message = event as Json;
    events.push(message);
    if (message['event'] === 'refused') fail('refused');
    if (message['event'] === 'store_opened') stage = 'store_opened';
    if (message['event'] === 'https_listening') stage = 'https_listening';
    if (message['event'] === 'running') {
      if (message['state'] !== 'running' || message['pid'] !== child.pid) {
        fail('invalid_running');
        return;
      }
      stage = 'running';
      signal.removeEventListener('abort', aborted);
      resolveRunning(message);
    }
  });
  child.on('error', () => fail('spawn_error'));
  const exited = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    child.once('close', (code, exitSignal) => {
      lines.close();
      fail(`exited:${code ?? exitSignal ?? 'unknown'}`);
      resolve({ code, stdout, stderr });
    });
  });
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) aborted();
  return { child, events, running, exited, stderr: () => stderr };
}

export async function startCli(t: test.TestContext, args: readonly string[]) {
  const child = spawn(process.execPath, [CLI, 'start', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const observed = observeCliStart(child, t.signal);
  onCleanup(t, async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await observed.exited;
  });
  const running = await observed.running.catch((error: Error) => {
    t.diagnostic(error.message);
    throw error;
  });
  return { ...observed, running };
}
