#!/usr/bin/env node
// buddy-core start | status | stop（ADR 0012）。
// start はフォアグラウンドで動き、SIGINT / SIGTERM（Windows では SIGINT・SIGBREAK と制御チャネルの stop）
// で「新しい要求の受付停止 → 終了処理 → ソケット・ロックの解放 → 終了」を行う。
// 標準出力には機械向けの JSON を 1 行ずつ、標準エラーには人向けの記録を書く。

import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  createMockTlsKeyStore,
  createNodeCommandRunner,
  createTlsKeyStore,
} from '@buddy/platform';
import type { TlsKeyStore } from '@buddy/platform';
import { DEFAULT_HTTPS_PORT } from './api-server.js';
import { runAutostart } from './autostart.js';
import type { AutostartAction } from './autostart.js';
import { join, resolve } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { callControl } from './control-channel.js';
import { CoreStartError, startCore } from './core.js';
import type { CoreHandle, CoreHttpsOptions } from './core.js';
import { parseLockRecord } from './lock.js';
import { LOCK_FILE, controlEndpoint, defaultDataDir } from './paths.js';
import { createCoreKeyStore, keyProtectionCheck } from './preflight.js';
import type { KeyProtectionMode } from './preflight.js';

const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  // status / stop: 動いている Core がない。
  not_running: 3,
  // start: 排他・保存の検査により拒否（二重起動・旧担当の終了を確認できない・状態ファイル・DB）。
  refused: 4,
  // start: 起動前の検査（鍵保護）が理由を返した、またはロックの後のデータ鍵の読み直し・照合で拒否した。
  preflight_failed: 5,
  // autostart: この OS では対応しない、または登録・解除に失敗した。
  autostart_failed: 6,
  // first-device: Core が拒否した（有効な端末がある・HTTPS がない・申請がないなど）。
  first_device_refused: 7,
} as const;

// 鍵保護・データ鍵の照合による拒否（終了コード 5）。それ以外の起動の拒否は 4。
const KEY_REFUSALS: ReadonlySet<string> = new Set([
  'preflight_failed',
  'data_key_unavailable',
  'data_key_mismatch',
  // TLS の秘密鍵を鍵保護から取得できない（HTTPS を開かない）。
  'tls_unavailable',
]);

const USAGE = `使い方: buddy-core <start|status|stop> [--data-dir <path>]
  start  フォアグラウンドで起動する
         （既定では実行中の OS の鍵保護を確かめ、使えなければ起動しない）
         --mock-key-protection              模擬の鍵保護で起動する（試験・模擬起動）
         --mock-key-protection-unavailable  模擬の鍵保護が使えない状態を再現する
         --https-host <ip>                  HTTPS を待ち受ける IP アドレス（製品は Tailscale のアドレス）。
                                            省略すれば HTTPS を開かない
         --https-port <port>                HTTPS のポート（既定 ${DEFAULT_HTTPS_PORT}。0 は OS が選ぶ）
  status 状態を JSON で表示する（動いていなければ終了コード 3）
  stop   停止を要求し、解放まで待つ
  autostart <enable|disable|status>
         ログイン後の自動起動（macOS の LaunchAgent）。enable は次のログインから有効で、すぐには起動しない
  first-device start
         登録済みの端末が 0 台のときだけ、最初の端末のペアリングを始める（動いている Core に頼む）。
         ワンタイムコード（有効 5 分）と証明書の指紋を表示する。端末で指紋を確かめてからコードを入力する
  first-device approve --pairing-id <id>
         start で始めたペアリングの、同じマシンからの申請を承認する（登録済みの端末があれば拒否）`;

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
        'https-host': { type: 'string' },
        'https-port': { type: 'string' },
        'pairing-id': { type: 'string' },
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
  const action = positionals[1];
  const autostartCommand =
    command === 'autostart' &&
    positionals.length === 2 &&
    ['enable', 'disable', 'status'].includes(action ?? '');
  const firstDeviceCommand =
    command === 'first-device' &&
    positionals.length === 2 &&
    ['start', 'approve'].includes(action ?? '');
  if (
    !autostartCommand &&
    !firstDeviceCommand &&
    (positionals.length !== 1 ||
      !['start', 'status', 'stop'].includes(command ?? ''))
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
  if (
    command !== 'start' &&
    (values['https-host'] !== undefined || values['https-port'] !== undefined)
  ) {
    log('HTTPS の指定は start だけで使えます。');
    return EXIT.usage;
  }
  if (
    (values['pairing-id'] !== undefined) !==
    (firstDeviceCommand && action === 'approve')
  ) {
    log(
      '--pairing-id は first-device approve で必ず指定し、他では使えません。',
    );
    return EXIT.usage;
  }
  let httpsPort = DEFAULT_HTTPS_PORT;
  if (values['https-port'] !== undefined) {
    if (values['https-host'] === undefined) {
      log('--https-port には --https-host が必要です。');
      return EXIT.usage;
    }
    if (!/^(?:0|[1-9][0-9]{0,4})$/u.test(values['https-port'])) {
      log('--https-port は 0 から 65535 までの整数です。');
      return EXIT.usage;
    }
    httpsPort = Number(values['https-port']);
    if (httpsPort > 65_535) {
      log('--https-port は 0 から 65535 までの整数です。');
      return EXIT.usage;
    }
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
    const https =
      values['https-host'] === undefined
        ? null
        : { host: values['https-host'], port: httpsPort };
    return start(dataDir, mode, https);
  }
  if (autostartCommand) return autostart(action as AutostartAction, dataDir);
  if (firstDeviceCommand)
    return firstDevice(dataDir, values['pairing-id'] ?? null);
  return command === 'status' ? status(dataDir) : stop(dataDir);
}

async function autostart(
  action: AutostartAction,
  dataDir: string,
): Promise<number> {
  const outcome = await runAutostart(action, dataDir, {
    nodePlatform: process.platform,
    runner: createNodeCommandRunner(),
    homeDir: homedir(),
    uid: process.getuid?.(),
    nodePath: process.execPath,
    coreCliPath: fileURLToPath(import.meta.url),
  });
  out(outcome.output);
  return outcome.ok ? EXIT.ok : EXIT.autostart_failed;
}

// 起動の種類に合う TLS の秘密鍵の KeyStore。模擬は実機の保護領域に触れない（メモリ上で、起動ごとに作り直す）。
function createCoreTlsKeyStore(mode: KeyProtectionMode): TlsKeyStore {
  if (mode === 'mock') return createMockTlsKeyStore();
  if (mode === 'mock_unavailable')
    return createMockTlsKeyStore({ available: false });
  return createTlsKeyStore(process.platform);
}

async function start(
  dataDir: string,
  mode: KeyProtectionMode,
  https: { readonly host: string; readonly port: number } | null,
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
    if (mode !== 'os')
      log(
        '模擬の鍵保護で起動します（試験・模擬起動。模擬の鍵は公開の値で、DB は保護されません）。',
      );
    // 起動前の検査とロックの後の読み直しに同じ KeyStore を使う（ADR 0019）。
    const keyStore = createCoreKeyStore(mode);
    const httpsOptions: CoreHttpsOptions | undefined =
      https === null
        ? undefined
        : { ...https, tlsKeyStore: createCoreTlsKeyStore(mode) };
    try {
      handle = await startCore({
        dataDir,
        preflight: [keyProtectionCheck(mode, { keyStore })],
        keyStore,
        log,
        ...(httpsOptions === undefined ? {} : { https: httpsOptions }),
      });
    } catch (error) {
      if (!(error instanceof CoreStartError)) throw error;
      log(`起動を拒否しました: ${error.reasons.join(', ')}`);
      out({ event: 'refused', code: error.code, reasons: error.reasons });
      return KEY_REFUSALS.has(error.code)
        ? EXIT.preflight_failed
        : EXIT.refused;
    }
    // DB の状態（機械向け）。操作 ID は個人情報ではない。鍵の値・照合値・パスは出さない。
    out({
      event: 'store_opened',
      schema_version: handle.schemaVersion,
      store_generation: handle.storeGeneration,
      store_generation_source: handle.storeGenerationSource,
      data_key_check: handle.dataKeyCheck,
      held_after_restart: handle.recovery.held,
      resumable_preparing: handle.recovery.resumable,
    });
    if (handle.https !== null)
      // 証明書の指紋は秘密ではない（端末が中枢の画面の表示と比べる値）。
      out({
        event: 'https_listening',
        host: handle.https.host,
        port: handle.https.port,
        certificate_fingerprint: handle.https.certificateFingerprint,
        certificate_creation: handle.https.certificateCreation,
      });
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

// 最初の端末のペアリング（ADR 0021）。動いている Core の制御チャネルへ頼む（DB を直接開かない）。
// 開始の応答のワンタイムコードは、本人が端末に入力するために標準出力へ出す（Core のログには出さない）。
async function firstDevice(
  dataDir: string,
  pairingId: string | null,
): Promise<number> {
  const endpoint = await endpointFor(dataDir);
  const result = endpoint
    ? pairingId === null
      ? await callControl(endpoint, 'pairing_first_start', 5000)
      : await callControl(endpoint, 'pairing_first_approve', 5000, {
          pairing_id: pairingId,
        })
    : { kind: 'absent' as const };
  if (result.kind !== 'response') {
    out({ ok: false, state: 'not_running' });
    return EXIT.not_running;
  }
  out(result.body);
  if (result.body['ok'] === true) {
    log(
      pairingId === null
        ? '端末で中枢の証明書の指紋を確かめてから、ワンタイムコードを入力してください（有効 5 分）。'
        : '申請を承認しました。端末がトークンを受け取ると登録が終わります。',
    );
    return EXIT.ok;
  }
  if (result.body['error'] === 'unavailable') return EXIT.not_running;
  if (result.body['error'] === 'invalid_request') return EXIT.usage;
  return EXIT.first_device_refused;
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
