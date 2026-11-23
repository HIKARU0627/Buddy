// ブリッジの CLI（ADR 0143）。
//
//   buddy-bridge init                 設定を作り、Muse 向けの認証トークンを 1 回だけ表示する
//   buddy-bridge pair --code <8桁>    中枢の画面で始めたペアリングへ申請し、承認されたら端末トークンを保存する
//   buddy-bridge serve                Muse 向けの窓口を開く
//   buddy-bridge status               設定の状態と中枢への到達性を出す（トークンは出さない）
//
// トークン類は、init が表示する Muse 向けトークンだけを例外として、画面・ログに出さない。

import { appendFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import {
  createHomeFingerprintCollector,
  createNodeCommandRunner,
} from '@buddy/platform/home-fingerprint';
import type { BridgeConfig } from './config.js';
import {
  bridgeTokenHash,
  defaultConfigPath,
  emptyConfig,
  generateBridgeToken,
  loadConfig,
  saveConfig,
} from './config.js';
import { createCoreClient } from './core-client.js';
import type { CoreClient } from './core-client.js';
import { createHttpsCoreTransport } from './core-transport.js';
import type { CoreTransport } from './core-transport.js';
import { pairBridge } from './pairing.js';
import type { HomeFingerprint } from './pairing.js';
import { createBridgeServer } from './server.js';
import type { AuditEntry } from './server.js';

const USAGE = `使い方:
  buddy-bridge init                 設定を作り、Muse 向けの認証トークンを 1 回だけ表示する
  buddy-bridge pair --code <8桁>    中枢へ端末として登録する（中枢の画面で開始と承認が要る）
  buddy-bridge serve                Muse 向けの窓口を開く
  buddy-bridge status               設定と中枢への到達性を出す
環境変数: BUDDY_BRIDGE_CONFIG（設定ファイルの場所）`;

const devicePlatform = (
  platform: NodeJS.Platform,
): 'windows' | 'macos' | 'linux' =>
  platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';

async function collectHomeFingerprint(): Promise<HomeFingerprint> {
  const collector = createHomeFingerprintCollector({
    platform: process.platform,
    runner: createNodeCommandRunner(),
    networkInterfaces: () => networkInterfaces(),
  });
  const observation = await collector.collect();
  return {
    gateway_mac: observation.gateway_mac,
    subnet: observation.subnet,
    ssid: observation.ssid,
  };
}

function transportFor(
  config: BridgeConfig,
  pinned?: { certificatePem: string; fingerprint: string },
): CoreTransport {
  return createHttpsCoreTransport({
    host: config.hub.host,
    port: config.hub.port,
    certificatePem: pinned?.certificatePem ?? config.hubCertificatePem,
    fingerprint: pinned?.fingerprint ?? config.hubFingerprint,
  });
}

function clientFor(config: BridgeConfig): CoreClient {
  return createCoreClient({
    transport: transportFor(config),
    deviceToken: config.deviceToken,
  });
}

async function init(path: string): Promise<number> {
  const existing = await loadConfig(path);
  if (existing !== null && existing.bridgeTokenHash !== null) {
    console.error(
      '設定は既にあります。作り直すと Muse 向けのトークンが変わります。先に設定ファイルを消してください。',
    );
    return 1;
  }
  const token = generateBridgeToken();
  const config: BridgeConfig = {
    ...(existing ?? emptyConfig()),
    bridgeTokenHash: bridgeTokenHash(token),
  };
  await saveConfig(path, config);
  console.log(`設定を書きました: ${path}`);
  console.log(
    'Muse 向けの認証トークン（この 1 回だけ表示します。Muse のコネクタ登録で使います）:',
  );
  console.log(token);
  console.log(
    'listen.host は既定で 127.0.0.1 です。Muse から届くようにするには、設定ファイルの listen.host をこのマシンの Tailscale のアドレス（100.x.x.x）に変えてください。',
  );
  return 0;
}

async function pair(path: string, code: string): Promise<number> {
  const config = (await loadConfig(path)) ?? emptyConfig();
  if (!/^[0-9]{8}$/u.test(code)) {
    console.error('--code は中枢の画面に出た 8 桁の数字です。');
    return 1;
  }
  let result;
  try {
    result = await pairBridge(
      {
        transport: transportFor(config),
        pinnedClient: (certificatePem, fingerprint) =>
          createCoreClient({
            transport: transportFor(config, { certificatePem, fingerprint }),
            deviceToken: null,
          }),
        collectFingerprint: collectHomeFingerprint,
        deviceName: 'Buddy Bridge (Muse)',
        platform: devicePlatform(process.platform),
        onPeerCertificate: async (fingerprint) => {
          console.log('中枢の証明書の指紋:');
          console.log(fingerprint);
          console.log(
            '中枢の画面に出ている指紋と一致するか確かめてください。一致したら Enter、違えば Ctrl+C で止めてください。',
          );
          // 一致の確認が済むまで申請しない。入力が閉じたら（Enter が来ないまま）中止する。
          let confirmed = false;
          for await (const line of createInterface({
            input: process.stdin,
          })) {
            void line;
            confirmed = true;
            break;
          }
          if (!confirmed)
            throw new Error('指紋の確認が済まないため、申請を中止しました。');
        },
        onClaimCreated: () => {
          console.log(
            '申請しました。中枢の画面で承認してください（申請の期限は 5 分です）。',
          );
        },
      },
      code,
    );
  } catch (error) {
    console.error(
      `ペアリングできませんでした（${error instanceof Error ? error.message : 'unknown'}）。`,
    );
    return 1;
  }
  if (result.kind !== 'paired') {
    console.error(`ペアリングできませんでした（${result.reason}）。`);
    return 1;
  }
  await saveConfig(path, {
    ...config,
    hubCertificatePem: result.certificatePem,
    hubFingerprint: result.fingerprint,
    deviceId: result.deviceId,
    deviceToken: result.deviceToken,
  });
  console.log(
    'ペアリングできました。端末トークンを設定へ保存しました（値は表示しません）。',
  );
  return 0;
}

async function serve(path: string): Promise<number> {
  const config = await loadConfig(path);
  if (config === null) {
    console.error('設定がありません。先に init を実行してください。');
    return 1;
  }
  if (config.deviceToken === null || config.hubCertificatePem === null) {
    console.error('ペアリングが済んでいません。先に pair を実行してください。');
    return 1;
  }
  if (config.bridgeTokenHash === null) {
    console.error(
      'Muse 向けのトークンが未設定です。先に init を実行してください。',
    );
    return 1;
  }
  if (
    config.listen.host === '0.0.0.0' ||
    config.listen.host === '::' ||
    config.listen.host === ''
  ) {
    console.error(
      'listen.host がワイルドカードです。Tailscale のアドレスを明示してください（LAN 全体へ開かないため）。',
    );
    return 1;
  }
  const auditPath = join(dirname(path), 'audit.log');
  const server = createBridgeServer({
    config,
    client: clientFor(config),
    audit: (entry: AuditEntry) => {
      void appendFile(auditPath, `${JSON.stringify(entry)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      }).catch(() => undefined);
    },
  });
  await server.listen();
  console.log(
    `ブリッジを開きました: http://${config.listen.host}:${server.port}/bridge/v1（認証トークン必須）`,
  );
  await new Promise<void>((resolve) => {
    const stop = () => {
      void server.close().then(() => resolve());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

async function status(path: string): Promise<number> {
  const config = await loadConfig(path);
  if (config === null) {
    console.log('設定はまだありません。');
    return 0;
  }
  console.log(`設定: ${path}`);
  console.log(`中枢: https://${config.hub.host}:${config.hub.port}`);
  console.log(
    `ペアリング: ${config.deviceToken === null ? '未実施' : `済み（device_id ${config.deviceId ?? '不明'}）`}`,
  );
  console.log(
    `Muse 向けトークン: ${config.bridgeTokenHash === null ? '未設定' : '設定済み（値は出さない）'}`,
  );
  console.log(
    `待ち受け: http://${config.listen.host}:${config.listen.port}/bridge/v1`,
  );
  if (config.deviceToken !== null) {
    const outcome = await clientFor(config).read('/v1/bootstrap');
    console.log(
      `中枢への到達: ${
        outcome.kind === 'response'
          ? `応答あり（状態 ${outcome.status}）`
          : outcome.kind === 'certificate_mismatch'
            ? '証明書がピン留めと違う'
            : `接続できない（${outcome.reason}）`
      }`,
    );
  }
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const configPath = defaultConfigPath();
  switch (command) {
    case 'init':
      return init(configPath);
    case 'pair': {
      const { values } = parseArgs({
        args: [...rest],
        options: { code: { type: 'string' } },
        allowPositionals: false,
      });
      if (values.code === undefined) {
        console.error('--code <8桁> が必要です。');
        return 1;
      }
      return pair(configPath, values.code);
    }
    case 'serve':
      return serve(configPath);
    case 'status':
      return status(configPath);
    default:
      console.error(USAGE);
      return command === undefined || command === '--help' || command === '-h'
        ? 0
        : 1;
  }
}

// bin（dist/cli.js）として直接実行されたときだけ走らせる（試験から import しても走らない）。
if (process.argv[1]?.endsWith('cli.js') === true) {
  process.exitCode = await main(process.argv.slice(2));
}
