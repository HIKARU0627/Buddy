// Windows の中枢の鍵の保護（DPAPI、CurrentUser のスコープ。ADR 0202）。
// 鍵・トークンの値を Windows の DPAPI（System.Security.Cryptography.ProtectedData）で保護し、保護した blob を
// %LOCALAPPDATA%\Buddy\key-store の下の 1 項目 1 ファイルに置く。ネイティブのモジュールを使わず、
// PowerShell（powershell.exe -NoProfile -NonInteractive）を子プロセスで呼ぶ。
// 秘密の値はコマンドラインの引数に載せず、標準入力で渡す。ログ・例外の文・ファイル名に値を入れない。
// 項目の読み書きの形（SecretSlot）は macOS のキーチェーンと同じで、鍵の作成・形式の検査・読み戻しは
// key-store.ts などの上の層が行う。平文の保存へ切り替える経路は作らない。
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import type { CommandResult } from './runner.js';
import type { SecretSlot } from './key-store.js';

/**
 * 保護領域を開けない・使えない（PowerShell を起動できない、DPAPI の型を読み込めない、置き場所がない）。
 * 上の層はこの例外を「使えない」（unavailableReason）として扱い、読み出し・書込みの失敗と分ける。
 * メッセージには理由のコードだけを入れる（パス・コマンドの出力・値を入れない）。
 */
export class KeyStoreUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`key store unavailable: ${reason}`);
    this.name = 'KeyStoreUnavailableError';
    this.reason = reason;
  }
}

/** 標準入力に文字列を渡して実行する runner。DPAPI の子プロセスはこの境界でだけ実行する。 */
export interface StdinCommandRunner {
  run(
    command: string,
    args: readonly string[],
    stdin: string,
  ): Promise<CommandResult>;
}

export interface RecordedStdinCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** 試験で、秘密が引数ではなく標準入力に載ったことを確かめるために記録する。 */
  readonly stdin: string;
}

export interface MockStdinCommandRunner extends StdinCommandRunner {
  readonly kind: 'mock';
  readonly calls: readonly RecordedStdinCommand[];
}

/** 試験用の模擬 runner。実行せずに呼び出しを記録し、respond の結果を返す。 */
export function createMockStdinCommandRunner(
  respond: (
    command: string,
    args: readonly string[],
    stdin: string,
  ) => CommandResult,
): MockStdinCommandRunner {
  const calls: RecordedStdinCommand[] = [];
  return {
    kind: 'mock',
    calls,
    run(command, args, stdin) {
      calls.push({ command, args: [...args], stdin });
      return Promise.resolve(respond(command, args, stdin));
    },
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * 実機用の runner。shell を経由せず execFile で実行し、標準入力に書いて閉じる。
 * 例外は投げず、起動の失敗・時間切れ・シグナルによる終了は exitCode: null の結果として返す。
 */
export function createNodeStdinCommandRunner(
  options: { readonly timeoutMs?: number } = {},
): StdinCommandRunner {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    run(command, args, stdin) {
      return new Promise((resolve) => {
        const child = execFile(
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
        // 起動できなかったときの EPIPE などは、上の callback の結果（exitCode: null）で扱う。
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(stdin, 'utf8');
      });
    },
  };
}

/**
 * PowerShell で実行する固定のスクリプト。標準入力の 3 行（操作・entropy の base64・データの base64）を読み、
 * CurrentUser のスコープで Protect / Unprotect した結果を base64 で標準出力に書く。
 * 秘密の値はスクリプトに入れない（スクリプトは定数で、-EncodedCommand で渡す）。
 * 終了コード: 0 成功、10 DPAPI の型を読み込めない、11 入力の形式が不正、12 Protect の失敗、13 Unprotect の失敗。
 * 例外の文（ユーザー名・パスを含み得る）は出さない。
 */
export const DPAPI_POWERSHELL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'try {',
  '  Add-Type -AssemblyName System.Security',
  '  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
  '} catch { [Environment]::Exit(10) }',
  '$lines = [Console]::In.ReadToEnd().Split([char]10)',
  'if ($lines.Length -lt 3) { [Environment]::Exit(11) }',
  '$op = $lines[0].Trim()',
  'try {',
  '  $entropy = [Convert]::FromBase64String($lines[1].Trim())',
  '  $data = [Convert]::FromBase64String($lines[2].Trim())',
  '} catch { [Environment]::Exit(11) }',
  "if ($op -ne 'protect' -and $op -ne 'unprotect') { [Environment]::Exit(11) }",
  'try {',
  "  if ($op -eq 'protect') {",
  '    $out = [System.Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope)',
  '  } else {',
  '    $out = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope)',
  '  }',
  '} catch {',
  '  [Array]::Clear($data, 0, $data.Length)',
  "  if ($op -eq 'protect') { [Environment]::Exit(12) }",
  '  [Environment]::Exit(13)',
  '}',
  '[Array]::Clear($data, 0, $data.Length)',
  '[Console]::Out.Write([Convert]::ToBase64String($out))',
  '[Array]::Clear($out, 0, $out.Length)',
  '[Environment]::Exit(0)',
].join('\n');

/** PowerShell の引数。スクリプトは UTF-16LE の base64（-EncodedCommand）で渡し、秘密を含めない。 */
export const DPAPI_POWERSHELL_ARGS: readonly string[] = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  Buffer.from(DPAPI_POWERSHELL_SCRIPT, 'utf16le').toString('base64'),
];

/** 保護した blob のファイルの拡張子。 */
export const DPAPI_FILE_EXTENSION = '.dpapi';
/** entropy（DPAPI の追加の値）の前置き。項目名と結び付け、別の項目のファイルへの差し替えを復号の失敗にする。 */
export const DPAPI_ENTROPY_PREFIX = 'dev.buddy.core/';
/** 保護する値の上限（UTF-8 のバイト数）。鍵・トークンはこれより十分小さい。 */
export const DPAPI_MAX_VALUE_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 256 * 1024;

const DRIVE_PATH = /^[A-Za-z]:\\/u;

/**
 * 既定の置き場所 %LOCALAPPDATA%\Buddy\key-store。LOCALAPPDATA がドライブ文字で始まる絶対パスでなければ null
 * （ネットワークの共有・相対パスには置かない。推測で別の場所へ切り替えない）。
 */
export function defaultWindowsKeyStoreDir(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const local = env['LOCALAPPDATA'];
  if (local === undefined || !DRIVE_PATH.test(local)) return null;
  return win32.join(local, 'Buddy', 'key-store');
}

/**
 * Windows PowerShell 5.1 の絶対パス（%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe）。
 * PATH から探さない（PATH の前の方に置かれた別の実行ファイルを呼ばないため）。SystemRoot がなければ null。
 */
export function windowsPowerShellPath(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const root = env['SystemRoot'] ?? env['SYSTEMROOT'];
  if (root === undefined || !DRIVE_PATH.test(root)) return null;
  return win32.join(
    root,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

/** 項目名からファイル名を作る。項目名は大文字・小文字を区別するが Windows のファイル名は区別しないため、SHA-256 の 16 進にする。 */
export function dpapiFileName(account: string): string {
  return `${createHash('sha256').update(account, 'utf8').digest('hex')}${DPAPI_FILE_EXTENSION}`;
}

export interface WindowsDpapiOptions {
  /**
   * 保護した blob の置き場所（絶対パス）。省略時は %LOCALAPPDATA%\Buddy\key-store。
   * 試験では一時ディレクトリを渡し、本人の置き場所に触れない。
   */
  readonly directory?: string;
  /** 既定の置き場所と PowerShell のパスを求める環境変数。省略時は process.env。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** DPAPI の子プロセスの runner。省略時は実機の runner。試験では模擬を渡す。 */
  readonly runner?: StdinCommandRunner;
  /** PowerShell の絶対パス。省略時は %SystemRoot% から求める。 */
  readonly powershellPath?: string;
}

function canonicalBase64(value: string): Buffer | null {
  if (value.length === 0) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

const STORED_KEYS = ['account', 'blob', 'scope', 'v'];

/** 保存ファイル（JSON）を読む。形が違えば null。blob の中身（保護された値）はここでは解かない。 */
function parseStored(text: string, account: string): Buffer | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== STORED_KEYS.length ||
    keys.some((key, index) => key !== STORED_KEYS[index])
  )
    return null;
  if (record['v'] !== 1 || record['scope'] !== 'current_user') return null;
  // ファイルを別の項目の名前へ移しても使えないように、項目名を照合する（entropy でも結び付けている）。
  if (record['account'] !== account) return null;
  const blob = record['blob'];
  return typeof blob === 'string' ? canonicalBase64(blob) : null;
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows ではディレクトリを開いて fsync できない（apps/core の data-dir.ts と同じ扱い）。
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readSmallFile(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES)
      throw new Error('dpapi stored file invalid');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

interface DpapiContext {
  readonly directory: string;
  readonly powershell: string;
  readonly runner: StdinCommandRunner;
}

function resolveContext(options: WindowsDpapiOptions): DpapiContext {
  const env = options.env ?? process.env;
  const directory = options.directory ?? defaultWindowsKeyStoreDir(env);
  if (directory === null) throw new KeyStoreUnavailableError('directory');
  const powershell = options.powershellPath ?? windowsPowerShellPath(env);
  if (powershell === null) throw new KeyStoreUnavailableError('powershell');
  return {
    directory,
    powershell,
    runner: options.runner ?? createNodeStdinCommandRunner(),
  };
}

/** 置き場所を用意する。作れない・ディレクトリでない・リンク（ジャンクションを含む）なら使えない。 */
async function prepareDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('not a directory');
  } catch {
    throw new KeyStoreUnavailableError('directory');
  }
}

async function runDpapi(
  context: DpapiContext,
  op: 'protect' | 'unprotect',
  entropy: Buffer,
  data: Buffer,
): Promise<Buffer> {
  const result = await context.runner.run(
    context.powershell,
    DPAPI_POWERSHELL_ARGS,
    `${op}\n${entropy.toString('base64')}\n${data.toString('base64')}\n`,
  );
  // 標準エラー・標準出力の文はユーザー名・パスを含み得るので、例外の文に入れない。
  if (result.exitCode === null) throw new KeyStoreUnavailableError('process');
  if (result.exitCode === 10) throw new KeyStoreUnavailableError('dpapi');
  if (result.exitCode !== 0) throw new Error(`dpapi ${op} failed`);
  const bytes = canonicalBase64(result.stdout.trim());
  if (bytes === null) throw new Error(`dpapi ${op} output invalid`);
  return bytes;
}

/**
 * DPAPI の 1 項目を開く関数を作る。項目は置き場所の `<SHA-256(項目名)>.dpapi` で、中身は
 * `{"v":1,"scope":"current_user","account":<項目名>,"blob":<保護した値の base64>}`。
 * 開けない（置き場所・PowerShell がない）ときは KeyStoreUnavailableError を投げる。
 */
export function windowsDpapiSlotOpener(
  account: string,
  options: WindowsDpapiOptions = {},
): () => Promise<SecretSlot> {
  return async () => {
    const context = resolveContext(options);
    await prepareDirectory(context.directory);
    const name = dpapiFileName(account);
    const path = join(context.directory, name);
    const entropy = Buffer.from(`${DPAPI_ENTROPY_PREFIX}${account}`, 'utf8');
    return {
      async read() {
        const text = await readSmallFile(path);
        if (text === null) return null;
        const blob = parseStored(text, account);
        if (blob === null) throw new Error('dpapi stored file invalid');
        const plain = await runDpapi(context, 'unprotect', entropy, blob);
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(plain);
        } catch {
          throw new Error('dpapi value is not utf-8');
        } finally {
          plain.fill(0);
        }
      },
      async write(value) {
        if (typeof value !== 'string') throw new TypeError('value invalid');
        const plain = Buffer.from(value, 'utf8');
        if (plain.length === 0 || plain.length > DPAPI_MAX_VALUE_BYTES)
          throw new RangeError('value size invalid');
        let blob: Buffer;
        try {
          blob = await runDpapi(context, 'protect', entropy, plain);
        } finally {
          plain.fill(0);
        }
        const content = `${JSON.stringify({
          v: 1,
          scope: 'current_user',
          account,
          blob: blob.toString('base64'),
        })}\n`;
        // 同じディレクトリの一時ファイルに書いて fsync し、置き換える（途中で止まっても古い値か新しい値のどちらか）。
        const temp = join(context.directory, `.${name}.${randomUUID()}.tmp`);
        const handle = await open(temp, 'wx', 0o600);
        try {
          await handle.writeFile(content, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await rename(temp, path);
        } catch (error) {
          await rm(temp, { force: true });
          throw error;
        }
        await syncDirectory(context.directory);
      },
      async remove() {
        // 項目が無ければ何もしない（OAuth トークンの削除は、無ければ成功として扱う）。
        await rm(path, { force: true });
        await syncDirectory(context.directory);
      },
    };
  };
}
