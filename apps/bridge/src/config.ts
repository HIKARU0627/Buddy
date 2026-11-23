// ブリッジの設定（1 つの JSON ファイル。ADR 0143）。
//
// - 置き場所は環境変数 BUDDY_BRIDGE_CONFIG か、ホームの下の .buddy-bridge/config.json。
// - ファイルの権限は 0600（端末トークンを含むため）。保存のたびに権限を付け直す。
// - 端末トークンは、他の端末と同じく「端末側が平文で持つ・中枢は hash だけを持つ」扱い（契約の DeviceCredential）。
//   OS のキーチェーンへの移行は将来の課題として ADR に残す。
// - Muse 向けの認証トークンは、設定ファイルには SHA-256 の hash だけを置く。トークンそのものは
//   init のときに 1 回だけ本人の端末に表示し、以後は出さない（照合は hash 同士を定数時間で比べる）。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface BridgeConfig {
  readonly version: 1;
  // 中枢（Core の HTTPS）の接続先。中枢と同じマシンで動く前提なので既定はループバック。
  readonly hub: { readonly host: string; readonly port: number };
  // ペアリングのときにピン留めした中枢の証明書（PEM）と指紋（DER 全体の SHA-256、小文字の 16 進）。
  readonly hubCertificatePem: string | null;
  readonly hubFingerprint: string | null;
  // ペアリングで受け取った端末（1 回だけ返る値）。中枢は hash だけを持つ。
  readonly deviceId: string | null;
  readonly deviceToken: string | null;
  // Muse 向け認証トークンの SHA-256（16 進 64 文字）。トークンそのものは保持しない。
  readonly bridgeTokenHash: string | null;
  // Muse 向けの待ち受け。Tailscale のアドレスを明示する（ワイルドカードは serve が拒否する）。
  readonly listen: { readonly host: string; readonly port: number };
}

// 中枢の HTTPS の既定のポート（apps/core の DEFAULT_HTTPS_PORT と同じ値。値は設定で変えられる）。
export const DEFAULT_HUB_PORT = 47_443;
export const DEFAULT_LISTEN_PORT = 47_444;

export function defaultConfigPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const fromEnv = env['BUDDY_BRIDGE_CONFIG'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return join(homedir(), '.buddy-bridge', 'config.json');
}

export function emptyConfig(): BridgeConfig {
  return {
    version: 1,
    hub: { host: '127.0.0.1', port: DEFAULT_HUB_PORT },
    hubCertificatePem: null,
    hubFingerprint: null,
    deviceId: null,
    deviceToken: null,
    bridgeTokenHash: null,
    listen: { host: '127.0.0.1', port: DEFAULT_LISTEN_PORT },
  };
}

// Muse 向けの認証トークン（256 ビット、base64url の 43 文字。端末トークンと同じ形）。
export function generateBridgeToken(): string {
  return randomBytes(32).toString('base64url');
}

export function bridgeTokenHash(token: string): string {
  return createHash('sha256').update(token, 'ascii').digest('hex');
}

// 提示されたトークンが登録済みのものか。hash 同士を定数時間で比べる（トークンそのものは比べない）。
export function bridgeTokenMatches(
  config: BridgeConfig,
  presented: string | null,
): boolean {
  if (config.bridgeTokenHash === null || presented === null) return false;
  const expected = Buffer.from(config.bridgeTokenHash, 'hex');
  const actual = Buffer.from(bridgeTokenHash(presented), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const portOf = (value: unknown, fallback: number): number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= 65_535
    ? value
    : fallback;

// 設定ファイルを読む。無い・読めない・形が違うときは null（呼び出し側が「未設定」として扱う）。
export async function loadConfig(path: string): Promise<BridgeConfig | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || value['version'] !== 1) return null;
  const base = emptyConfig();
  const hub = isRecord(value['hub']) ? value['hub'] : {};
  const listen = isRecord(value['listen']) ? value['listen'] : {};
  return {
    version: 1,
    hub: {
      host: typeof hub['host'] === 'string' ? hub['host'] : base.hub.host,
      port: portOf(hub['port'], base.hub.port),
    },
    hubCertificatePem: stringOrNull(value['hubCertificatePem']),
    hubFingerprint: stringOrNull(value['hubFingerprint']),
    deviceId: stringOrNull(value['deviceId']),
    deviceToken: stringOrNull(value['deviceToken']),
    bridgeTokenHash: stringOrNull(value['bridgeTokenHash']),
    listen: {
      host:
        typeof listen['host'] === 'string' ? listen['host'] : base.listen.host,
      port: portOf(listen['port'], base.listen.port),
    },
  };
}

// 設定を書く。ディレクトリを作り、権限 0600 で書く（既存のファイルの権限も付け直す）。
export async function saveConfig(
  path: string,
  config: BridgeConfig,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  // 既存のファイルは writeFile の mode が効かないので、権限を付け直す。
  await chmod(path, 0o600);
}
