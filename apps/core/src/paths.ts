// データディレクトリと制御チャネルの場所（ADR 0012）。
// OS・環境変数・ホームを引数で受け取る純粋な関数にし、どの OS でも試験できるようにする。

import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { isWindowsDriveAbsolutePath } from '@buddy/platform';

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
  // Windows は %LOCALAPPDATA%（移動プロファイルで同期しない、この PC だけの場所）。DB と WAL を同期の対象にせず、
  // DPAPI で保護した鍵（%LOCALAPPDATA%\Buddy\key-store）と同じ PC・同じ利用者の場所にそろえる（ADR 0202）。
  // LOCALAPPDATA の検査は鍵の置き場所と同じ（ドライブ文字で始まる絶対パスだけ。共有・相対パスは使わない）。
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'];
    const base = isWindowsDriveAbsolutePath(localAppData)
      ? (localAppData as string)
      : win32.join(homedir, 'AppData', 'Local');
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

// ADR 0202 より前の Windows の既定のデータディレクトリ（%APPDATA%\Buddy\core、Roaming）。
export function legacyWindowsDataDir({
  env,
  homedir,
}: PlatformContext): string {
  const appData = env['APPDATA'];
  const base = isWindowsDriveAbsolutePath(appData)
    ? (appData as string)
    : win32.join(homedir, 'AppData', 'Roaming');
  return win32.join(base, 'Buddy', 'core');
}

export const LEGACY_DATA_DIR_PRESENT = 'legacy_data_dir_present';

// Windows で既定のデータディレクトリを使う起動のとき、旧い既定（%APPDATA%\Buddy\core）があり新しい既定がなければ
// 理由のコードを返す（起動のログで一度だけ知らせる。自動では移さない。ADR 0202・U705）。
// 旧い場所のデータは鍵保護を断っていた頃の模擬の鍵で作ったもので、本物の鍵では開けない。
export function legacyDataDirNotice(
  context: PlatformContext & {
    readonly dataDirGiven: boolean;
    readonly exists: (path: string) => boolean;
  },
): typeof LEGACY_DATA_DIR_PRESENT | null {
  if (context.platform !== 'win32' || context.dataDirGiven) return null;
  return context.exists(legacyWindowsDataDir(context)) &&
    !context.exists(defaultDataDir(context))
    ? LEGACY_DATA_DIR_PRESENT
    : null;
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
// 時計の最終確認時刻と epoch の小さなファイル（ADR 0058 の U136。台帳のファイルと同じ書き方）。
export const CLOCK_STATE_FILE = 'clock-state.json';
