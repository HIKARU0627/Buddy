#!/usr/bin/env node
// buddy-core start | status | stop（ADR 0012）。
// start はフォアグラウンドで動き、SIGINT / SIGTERM（Windows では SIGINT・SIGBREAK と制御チャネルの stop）
// で「新しい要求の受付停止 → 終了処理 → ソケット・ロックの解放 → 終了」を行う。
// 標準出力には機械向けの JSON を 1 行ずつ、標準エラーには人向けの記録を書く。

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { callControl } from './control-channel.js';
import { CoreStartError, startCore } from './core.js';
import type { CoreHandle } from './core.js';
import { parseLockRecord } from './lock.js';
import { LOCK_FILE, controlEndpoint, defaultDataDir } from './paths.js';
import { keyProtectionCheck } from './preflight.js';
import type { KeyProtectionMode } from './preflight.js';

const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  // status / stop: 動いている Core がない。
  not_running: 3,
  // start: 排他により拒否（二重起動・旧担当の終了を確認できない）。
  refused: 4,
  // start: 起動前の検査が理由を返した。
  preflight_failed: 5,
} as const;

const USAGE = `使い方: buddy-core <start|status|stop> [--data-dir <path>]
  start  フォアグラウンドで起動する
         --mock-key-protection              模擬の鍵保護で起動する（B01 の模擬起動）
         --mock-key-protection-unavailable  模擬の鍵保護が使えない状態を再現する
  status 状態を JSON で表示する（動いていなければ終了コード 3）
  stop   停止を要求し、解放まで待つ`;

const out = (value: object) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
const log = (message: string) =>
  process.stderr.write(`buddy-core: ${message}\n`);

async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        'data-dir': { type: 'string' },
        'mock-key-protection': { type: 'boolean' },
        'mock-key-protection-unavailable': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    log((error as Error).message);
    process.stderr.write(`${USAGE}\n`);
    return EXIT.usage;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.ok;
  }
  const command = positionals[0];
  if (
    positionals.length !== 1 ||
    !['start', 'status', 'stop'].includes(command ?? '')
  ) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT.usage;
  }
  if (
    command !== 'start' &&
    (values['mock-key-protection'] || values['mock-key-protection-unavailable'])
  ) {
    log('鍵保護の指定は start だけで使えます。');
    return EXIT.usage;
  }
  const dataDir = resolve(
    values['data-dir'] ??
      defaultDataDir({
        platform: process.platform,
        env: process.env,
        homedir: homedir(),
      }),
  );
  if (command === 'start') {
    const mode: KeyProtectionMode = values['mock-key-protection-unavailable']
      ? 'mock_unavailable'
      : values['mock-key-protection']
        ? 'mock'
        : 'os';
    return start(dataDir, mode);
  }
  return command === 'status' ? status(dataDir) : stop(dataDir);
}

async function start(
  dataDir: string,
  mode: KeyProtectionMode,
): Promise<number> {
  let handle: CoreHandle | null = null;
  let stopReason: string | null = null;
  let signals = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    signals += 1;
    if (signals > 1) {
      log(`${signal} を再度受け取りました。終了処理を待たずに終了します。`);
      process.exit(EXIT.error);
    }
    stopReason = signal;
    void handle?.stop(signal);
  };
  const signalNames: NodeJS.Signals[] =
    process.platform === 'win32'
      ? ['SIGINT', 'SIGBREAK']
      : ['SIGINT', 'SIGTERM'];
  for (const name of signalNames) process.on(name, onSignal);
  try {
    if (mode !== 'os') log('模擬の鍵保護で起動します（実検査は B01-02）。');
    try {
      handle = await startCore({
        dataDir,
        preflight: [keyProtectionCheck(mode)],
        log,
      });
    } catch (error) {
      if (!(error instanceof CoreStartError)) throw error;
      log(`起動を拒否しました: ${error.reasons.join(', ')}`);
      out({ event: 'refused', code: error.code, reasons: error.reasons });
      return error.code === 'preflight_failed'
        ? EXIT.preflight_failed
        : EXIT.refused;
    }
    out({ event: 'running', ...handle.status() });
    log('起動しました。');
    // 起動中に受け取ったシグナルは、起動完了後に停止として扱う。
    if (stopReason) void handle.stop(stopReason);
    try {
      await handle.closed;
    } catch (error) {
      log(`終了処理で失敗しました: ${(error as Error).message}`);
      out({ event: 'stopped', ok: false });
      return EXIT.error;
    }
    out({
      event: 'stopped',
      ok: true,
      core_instance_id: handle.coreInstanceId,
    });
    return EXIT.ok;
  } finally {
    for (const name of signalNames) process.off(name, onSignal);
  }
}

async function endpointFor(dataDir: string): Promise<string | null> {
  try {
    return controlEndpoint(await realpath(dataDir), process.platform);
  } catch {
    return null;
  }
}

async function status(dataDir: string): Promise<number> {
  const endpoint = await endpointFor(dataDir);
  const result = endpoint
    ? await callControl(endpoint, 'status', 2000)
    : { kind: 'absent' as const };
  if (result.kind !== 'response' || result.body['ok'] !== true) {
    out({ ok: false, state: 'not_running' });
    return EXIT.not_running;
  }
  out(result.body);
  return EXIT.ok;
}

async function stop(dataDir: string): Promise<number> {
  const endpoint = await endpointFor(dataDir);
  const result = endpoint
    ? await callControl(endpoint, 'stop', 2000)
    : { kind: 'absent' as const };
  if (result.kind !== 'response' || result.body['ok'] !== true) {
    out({ ok: false, state: 'not_running' });
    return EXIT.not_running;
  }
  // 停止した Core のロックが消えるまで待つ（その後に別の Core が作ったロックは待たない）。
  // 期限を過ぎたら失敗として返し、強制終了はしない。
  const instance = result.body['core_instance_id'];
  const lock = join(dataDir, LOCK_FILE);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const text = await readFile(lock, 'utf8').catch(() => null);
    if (text === null || parseLockRecord(text)?.core_instance_id !== instance) {
      out({ ok: true, state: 'stopped', core_instance_id: instance });
      return EXIT.ok;
    }
    await delay(50);
  }
  log('停止の完了を確認できませんでした。');
  out({ ok: false, state: 'stopping', core_instance_id: instance });
  return EXIT.error;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    log(`予期しない障害: ${(error as Error).stack ?? String(error)}`);
    process.exitCode = EXIT.error;
  },
);
