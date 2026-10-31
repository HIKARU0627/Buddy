// データディレクトリと制御チャネルの場所（ADR 0012）。
// OS・環境変数・ホームを引数で受け取る純粋な関数にし、どの OS でも試験できるようにする。

import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

export interface PlatformContext {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}

// 既定のデータディレクトリ。個人の値はリポジトリへ書かず、実行時に OS から求める。
export function defaultDataDir({
  platform,
  env,
  homedir,
}: PlatformContext): string {
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    const base =
      appData && win32.isAbsolute(appData)
        ? appData
        : win32.join(homedir, 'AppData', 'Roaming');
    return win32.join(base, 'Buddy', 'core');
  }
  if (platform === 'darwin')
    return posix.join(
      homedir,
      'Library',
      'Application Support',
      'Buddy',
      'core',
    );
  // XDG Base Directory: 相対パスの XDG_DATA_HOME は無効として扱う。
  const xdg = env['XDG_DATA_HOME'];
  const base =
    xdg && posix.isAbsolute(xdg) ? xdg : posix.join(homedir, '.local', 'share');
  return posix.join(base, 'buddy', 'core');
}

export const LOCK_FILE = 'core.lock';
// B01 の状態ファイル。B02-04 から DB（schema_meta）へ移して消す（ADR 0019）。新しくは作らない。
export const STATE_FILE = 'core-state.json';
// 中枢の DB（SQLite。-wal・-shm が並ぶ）。ADR 0016・0019。
export const DB_FILE = 'buddy.sqlite';
export const SOCKET_FILE = 'control.sock';
// 忘却台帳の別ファイル（本文なし。DB の台帳から作り直せる写し。ADR 0040・0054）。
export const FORGET_LEDGER_FILE = 'forget-ledger.json';
// sockaddr_un の sun_path は macOS で 104 バイト・Linux で 108 バイト（終端を含む）。
// 小さい方に合わせて 103 バイトまでを許す。
export const MAX_UNIX_SOCKET_PATH_BYTES = 103;

// 制御チャネルの接続先。macOS / Linux はデータディレクトリ内の Unix domain socket、
// Windows はデータディレクトリの絶対パスから求めた名前付きパイプ。
export function controlEndpoint(
  dataDir: string,
  platform: NodeJS.Platform,
): string {
  if (platform === 'win32') {
    const digest = createHash('sha256').update(dataDir, 'utf8').digest('hex');
    return `\\\\.\\pipe\\buddy-core-${digest.slice(0, 16)}`;
  }
  return posix.join(dataDir, SOCKET_FILE);
}

export function socketPathTooLong(
  endpoint: string,
  platform: NodeJS.Platform,
): boolean {
  return (
    platform !== 'win32' &&
    Buffer.byteLength(endpoint, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES
  );
}
