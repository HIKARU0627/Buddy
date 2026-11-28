// HTTPS の待ち受けの設定ファイル（https.json、ADR 0203 の U723）。
//
// ログイン後に自動で起動した Core（macOS の LaunchAgent・Windows のタスク）は `--https-host` を受け取らないので、
// 待ち受けのアドレスとポートをデータディレクトリのこのファイルに置き、start がコマンドラインの指定のないときに読む
// （コマンドラインを優先）。LaunchAgent の plist・タスクの定義にはアドレスを入れない。
// - 書くのは `autostart enable --https-host <ip>` と `start --https-host <ip> --save`。本人だけの権限（0600）で、
//   一時ファイル → rename で原子的に書く。
// - 保存できるのは Tailscale のアドレス（100.64.0.0/10・fd7a:115c:a1e0::/48）だけ。全アドレス・LAN・ループバックは
//   拒否する（端末が中枢へつなぐのは Tailscale の上だけ。ADR 0020・0025）。ポートは 1〜65535（0 は試験用で保存しない）。
// - 読むときも同じ検査をする。本人以外が書けるファイル（POSIX）・形の違うファイルは使わない（起動を拒否する）。
// - アドレスの値はログ・例外の文言に出さない（理由のコードだけ）。
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listenAddressDecision } from '@buddy/domain';
import { writeFileAtomic } from './data-dir.js';
import { isJsonObject, parseStrictJson } from './strict-json.js';
import type { JsonValue } from './strict-json.js';

export const HTTPS_CONFIG_FILE = 'https.json';
const MAX_HTTPS_CONFIG_BYTES = 1024;

export interface HttpsListenConfig {
  // 正規化した Tailscale のアドレス。
  readonly host: string;
  readonly port: number;
}

export type HttpsConfigCheck =
  | { readonly ok: true; readonly config: HttpsListenConfig }
  | { readonly ok: false; readonly reason: string };

// 保存してよい待ち受けの設定か（Tailscale のアドレスと 1〜65535 のポート）。
export function checkHttpsListenConfig(
  host: unknown,
  port: unknown,
): HttpsConfigCheck {
  if (typeof host !== 'string')
    return { ok: false, reason: 'https_host_not_ip_address' };
  const decision = listenAddressDecision(host);
  if (!decision.ok)
    return { ok: false, reason: `https_host_${decision.reason}` };
  const loopback =
    decision.address === '::1' || decision.address.startsWith('127.');
  if (loopback) return { ok: false, reason: 'https_host_not_tailscale' };
  if (
    typeof port !== 'number' ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  )
    return { ok: false, reason: 'https_port_invalid' };
  return { ok: true, config: { host: decision.address, port } };
}

export type LoadedHttpsConfig =
  | { readonly kind: 'missing' }
  | { readonly kind: 'ok'; readonly config: HttpsListenConfig }
  | { readonly kind: 'invalid'; readonly reason: string };

export interface HttpsConfigFileOptions {
  readonly platform?: NodeJS.Platform;
}

// データディレクトリの https.json を読む。ないときは missing。
export async function loadHttpsConfig(
  dataDir: string,
  options: HttpsConfigFileOptions = {},
): Promise<LoadedHttpsConfig> {
  const platform = options.platform ?? process.platform;
  const path = join(dataDir, HTTPS_CONFIG_FILE);
  const invalid = (reason: string): LoadedHttpsConfig => ({
    kind: 'invalid',
    reason,
  });
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : invalid('https_config_unreadable');
  }
  if (!stat.isFile()) return invalid('https_config_not_regular_file');
  if (stat.size > MAX_HTTPS_CONFIG_BYTES)
    return invalid('https_config_too_large');
  // 本人以外が書ける設定は、待ち受けのアドレスを他人が変えられるので使わない（POSIX のみ）。
  if (platform !== 'win32' && (stat.mode & 0o022) !== 0)
    return invalid('https_config_writable_by_others');
  let value: JsonValue;
  try {
    value = parseStrictJson(await readFile(path, 'utf8'), 2);
  } catch {
    return invalid('https_config_unreadable');
  }
  if (
    !isJsonObject(value) ||
    Object.keys(value).sort().join(',') !== 'host,port'
  )
    return invalid('https_config_invalid');
  const checked = checkHttpsListenConfig(value['host'], value['port']);
  if (!checked.ok) return invalid(`https_config_invalid:${checked.reason}`);
  // 正規化した形で保存しているので、読んだ値と同じでなければ書き換えられたとみなす。
  if (checked.config.host !== value['host'])
    return invalid('https_config_invalid:https_host_not_normalized');
  return { kind: 'ok', config: checked.config };
}

// 検査した設定を、本人だけの権限で原子的に書く。
export async function saveHttpsConfig(
  dataDir: string,
  config: HttpsListenConfig,
): Promise<void> {
  const checked = checkHttpsListenConfig(config.host, config.port);
  if (!checked.ok) throw new TypeError(checked.reason);
  // Core を一度も起動していない（データディレクトリがない）ときの自動起動の設定に備えて作る（本人だけ）。
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    dataDir,
    HTTPS_CONFIG_FILE,
    `${JSON.stringify({ host: checked.config.host, port: checked.config.port })}\n`,
  );
}
