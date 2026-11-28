// Windows の起動・監督アダプター: 本人のログオン時に動くタスク（Task Scheduler）で Core を起動する（ADR 0203）。
//
// macOS の LaunchAgent（ADR 0013）にそろえる:
// - 本人のアカウントで、本人のログオンのときだけ動く（LogonTrigger の UserId と Principal の UserId を本人の SID にする）。
//   ログオンの前に動く形（S4U・パスワードの保存・SYSTEM）は使わない。S4U では DPAPI の鍵（ADR 0202）を読めないため。
// - 最小の権限（RunLevel は LeastPrivilege、LogonType は InteractiveToken）。管理者の権限を求めない。
// - 失敗時に再起動しない（RestartOnFailure を付けない）。KeepAlive を付けない macOS と同じ理由で、旧担当の終了確認なしに
//   Core が並行実行し得るため。実行の時間の上限は付けない（既定の 72 時間で止めない。ExecutionTimeLimit は PT0S）。
// - タスクは Core の CLI の `autostart launch --data-dir <path>` を呼ぶ。launch は Core（start）を窓のない別のプロセスとして
//   起動し、標準出力・標準エラーをデータディレクトリの logs/ に書かせてすぐに終わる（node.exe はコンソールのプログラムで、
//   直接起動するとログオンのたびにコンソールの窓が開き、ログもファイルに残らないため）。
// コマンドは %SystemRoot%\System32 の絶対パスで、shell を通さずに CommandRunner で呼ぶ。schtasks の出力は利用者の言語に
// 訳されるので読まず、終了コードだけを使う。状態は固定の PowerShell のスクリプト（値を埋め込まない）で JSON として読む。
// 本人の SID・パス・コマンドの出力はログ・理由に入れない。
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import type { CommandRunner } from './runner.js';
import type {
  CoreLaunchSpec,
  FailedResult,
  LoadState,
  RegisterRequest,
  RegisterResult,
  StartupSupervisor,
  SupervisorStatus,
  UnregisterResult,
} from './supervisor.js';
import {
  isWindowsDriveAbsolute,
  powerShellArgs,
  windowsPowerShellPath,
  windowsSystem32,
} from './windows-paths.js';

/** 個人情報を含まない固定の汎用名。タスクはルートのフォルダー（`\`）に置く。 */
export const WINDOWS_TASK_NAME = 'BuddyCore';

const TASK_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const SID_PATTERN = /^S-1-[0-9]{1,14}(?:-[0-9]{1,10}){1,15}$/u;

export interface WindowsTaskDefinition extends CoreLaunchSpec {
  /** 本人の SID（`whoami /user` で読む）。 */
  readonly userSid: string;
  readonly taskName?: string;
}

/** ログの出力先。macOS の LaunchAgent と同じくデータディレクトリ内の logs/ に置く。 */
export function windowsLogPaths(dataDir: string): {
  readonly stdout: string;
  readonly stderr: string;
} {
  return {
    stdout: win32.join(dataDir, 'logs', 'core.out.log'),
    stderr: win32.join(dataDir, 'logs', 'core.err.log'),
  };
}

function windowsPathReasons(field: string, value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0)
    return [`${field}_empty`];
  // `"`（引数の区切りを壊す）・`%`（Task Scheduler が環境変数として展開する）・制御文字を含むパスは使わない。
  if (/["%\p{Cc}]/u.test(value) || /\p{Cs}/u.test(value))
    return [`${field}_invalid_character`];
  if (!/^[A-Za-z]:\\/u.test(value) || !isWindowsDriveAbsolute(value))
    return [`${field}_not_absolute`];
  // 末尾の \ は引数の閉じの `"` をエスケープしてしまうので、正規化した形（ドライブの直下を除き末尾の \ なし）だけ。
  if (win32.normalize(value) !== value || value.endsWith('\\'))
    return [`${field}_not_normalized`];
  return [];
}

/** タスクの定義に使えない値の理由。空なら生成できる。 */
export function windowsTaskDefinitionReasons(
  definition: WindowsTaskDefinition,
): string[] {
  const taskName = definition.taskName ?? WINDOWS_TASK_NAME;
  return [
    ...(TASK_NAME_PATTERN.test(taskName) ? [] : ['task_name_invalid']),
    ...(typeof definition.userSid === 'string' &&
    SID_PATTERN.test(definition.userSid)
      ? []
      : ['user_sid_invalid']),
    ...windowsPathReasons('node_path', definition.nodePath),
    ...windowsPathReasons('core_cli_path', definition.coreCliPath),
    ...windowsPathReasons('data_dir', definition.dataDir),
  ];
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** タスクが実行する引数（node.exe の後ろ）。各値は検査済みで `"` と末尾の \ を含まない。 */
export function windowsTaskArguments(definition: CoreLaunchSpec): string {
  return `"${definition.coreCliPath}" autostart launch --data-dir "${definition.dataDir}"`;
}

/**
 * タスクの定義（Task Scheduler の XML、スキーマの版 1.2）を生成する純粋関数。
 * 使えない値は例外にする（register は事前に windowsTaskDefinitionReasons で失敗の結果へ変える）。
 */
export function renderWindowsTaskXml(
  definition: WindowsTaskDefinition,
): string {
  const reasons = windowsTaskDefinitionReasons(definition);
  if (reasons.length > 0)
    throw new TypeError(`タスクの定義が不正です: ${reasons.join(', ')}`);
  const sid = escapeXml(definition.userSid);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>Buddy Core</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${sid}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${sid}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>5</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${escapeXml(`"${definition.nodePath}"`)}</Command>`,
    `      <Arguments>${escapeXml(windowsTaskArguments(definition))}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/** schtasks の /XML が読む形（UTF-16LE、BOM つき）。 */
export function encodeWindowsTaskXml(xml: string): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(xml, 'utf16le'),
  ]);
}

/** `whoami /user /fo csv /nh` の出力（`"<名前>","<SID>"`）から SID を読む。読めなければ null。 */
export function parseWhoamiUserSid(output: string): string | null {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length !== 1) return null;
  const match = /,"(S-1-[0-9-]+)"$/u.exec(lines[0] as string);
  const sid = match?.[1];
  return sid !== undefined && SID_PATTERN.test(sid) ? sid : null;
}

/**
 * タスクの状態を JSON で出す固定の PowerShell のスクリプト。タスク名は検査した固定の形だけを入れる。
 * 見つからない（ObjectNotFound）は `{"found":false}`、ほかの失敗は終了コード 3。
 */
export function windowsTaskQueryScript(taskName: string): string {
  if (!TASK_NAME_PATTERN.test(taskName))
    throw new TypeError('タスク名が不正です。');
  return [
    "$ErrorActionPreference = 'Stop'",
    `try { $t = Get-ScheduledTask -TaskPath '\\' -TaskName '${taskName}' } catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { '{"found":false}'; exit 0 }; exit 3 }`,
    '[pscustomobject]@{ found = $true; enabled = [bool]$t.Settings.Enabled; state = [string]$t.State } | ConvertTo-Json -Compress',
  ].join('; ');
}

export type WindowsTaskQuery =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly enabled: boolean;
      /** Ready・Running・Disabled・Queued・Unknown。 */
      readonly state: string;
    };

/** windowsTaskQueryScript の出力を読む。形が違えば null。 */
export function parseWindowsTaskQuery(output: string): WindowsTaskQuery | null {
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  if (record['found'] === false && Object.keys(record).length === 1)
    return { found: false };
  if (
    record['found'] !== true ||
    typeof record['enabled'] !== 'boolean' ||
    typeof record['state'] !== 'string' ||
    !/^[A-Za-z]{1,32}$/u.test(record['state'])
  )
    return null;
  return { found: true, enabled: record['enabled'], state: record['state'] };
}

export interface WindowsCoreCommandPaths {
  readonly schtasks: string;
  readonly whoami: string;
  readonly powershell: string;
}

export function windowsCoreCommandPaths(
  systemRoot: string | undefined,
): WindowsCoreCommandPaths | null {
  const system32 = windowsSystem32(systemRoot);
  if (system32 === null) return null;
  return {
    schtasks: win32.join(system32, 'schtasks.exe'),
    whoami: win32.join(system32, 'whoami.exe'),
    powershell: windowsPowerShellPath(system32),
  };
}

/** 一時の定義ファイルとログのディレクトリの書き込み（試験では差し替える）。 */
export interface WindowsTaskFiles {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: Buffer): Promise<void>;
  rm(path: string): Promise<void>;
}

const NODE_FILES: WindowsTaskFiles = {
  async mkdir(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  async writeFile(path, data) {
    await writeFile(path, data, { flag: 'wx', mode: 0o600 });
  },
  async rm(path) {
    await rm(path, { force: true });
  },
};

export interface WindowsScheduledTaskOptions {
  readonly runner: CommandRunner;
  /** Core では process.env.SystemRoot。コマンドの絶対パスに使う。 */
  readonly systemRoot: string | undefined;
  readonly taskName?: string;
  readonly files?: WindowsTaskFiles;
}

function failed(step: string, reasons: readonly string[]): FailedResult {
  return { status: 'failed', step, reasons };
}

function fsReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return `fs_error:${typeof code === 'string' ? code : 'unknown'}`;
}

const exitOf = (code: number | null) => code ?? 'none';

export function createWindowsScheduledTaskSupervisor(
  options: WindowsScheduledTaskOptions,
): StartupSupervisor {
  const taskName = options.taskName ?? WINDOWS_TASK_NAME;
  if (!TASK_NAME_PATTERN.test(taskName))
    throw new TypeError('タスク名が不正です。');
  const taskPath = `\\${taskName}`;
  const files = options.files ?? NODE_FILES;
  const { runner } = options;
  const commands = windowsCoreCommandPaths(options.systemRoot);
  const noSystemRoot = failed('system_root', ['system_root_unavailable']);

  async function run(command: string, args: readonly string[]) {
    try {
      return await runner.run(command, args);
    } catch {
      return { exitCode: null, stdout: '', stderr: '' };
    }
  }

  async function query(
    paths: WindowsCoreCommandPaths,
  ): Promise<WindowsTaskQuery | null> {
    const result = await run(
      paths.powershell,
      powerShellArgs(windowsTaskQueryScript(taskName)),
    );
    return result.exitCode === 0 ? parseWindowsTaskQuery(result.stdout) : null;
  }

  async function userSid(paths: WindowsCoreCommandPaths) {
    const result = await run(paths.whoami, ['/user', '/fo', 'csv', '/nh']);
    if (result.exitCode !== 0)
      return failed('query_user', [`whoami_exit:${exitOf(result.exitCode)}`]);
    return (
      parseWhoamiUserSid(result.stdout) ??
      failed('query_user', ['user_sid_unreadable'])
    );
  }

  async function register(request: RegisterRequest): Promise<RegisterResult> {
    // 本人が有効にしたことを明示的に受け取らない限り、ファイルもコマンドも触らない。
    if (request?.enabled !== true) return { status: 'not_enabled' };
    // SID を読む前に、渡されたパスを検査する（仮の SID で検査し、SID は後で検査する）。
    const pathReasons = windowsTaskDefinitionReasons({
      ...request.launch,
      userSid: 'S-1-0-0',
      taskName,
    });
    if (pathReasons.length > 0) return failed('invalid_spec', pathReasons);
    if (commands === null) return noSystemRoot;
    const sid = await userSid(commands);
    if (typeof sid !== 'string') return sid;
    const definition: WindowsTaskDefinition = {
      ...request.launch,
      userSid: sid,
      taskName,
    };
    const xml = encodeWindowsTaskXml(renderWindowsTaskXml(definition));
    const dataDir = definition.dataDir;
    const temporary = win32.join(
      dataDir,
      `.autostart-task.${randomUUID()}.xml`,
    );
    try {
      // launch が書くログのディレクトリも先に作る（macOS の登録と同じ）。
      await files.mkdir(win32.join(dataDir, 'logs'));
      await files.writeFile(temporary, xml);
    } catch (error) {
      await files.rm(temporary).catch(() => undefined);
      return failed('write_definition', [fsReason(error)]);
    }
    let created;
    try {
      // /F: 同じ名前のタスクを置き換える。置き換えても、動いている Core（タスクから切り離して動く）は止まらない。
      created = await run(commands.schtasks, [
        '/Create',
        '/TN',
        taskPath,
        '/XML',
        temporary,
        '/F',
      ]);
    } finally {
      await files.rm(temporary).catch(() => undefined);
    }
    if (created.exitCode !== 0)
      return failed('create_task', [
        `schtasks_create_exit:${exitOf(created.exitCode)}`,
      ]);
    if (request.loadNow !== true)
      return {
        status: 'registered',
        definitionPath: taskPath,
        loaded: false,
        alreadyLoaded: false,
      };
    // 今すぐ一度実行する。Core が動いていれば、起動した start が単一起動のロックで拒否される（二重には動かない）。
    const started = await run(commands.schtasks, ['/Run', '/TN', taskPath]);
    if (started.exitCode !== 0)
      return failed('run_task', [
        `schtasks_run_exit:${exitOf(started.exitCode)}`,
      ]);
    return {
      status: 'registered',
      definitionPath: taskPath,
      loaded: true,
      alreadyLoaded: false,
    };
  }

  // 要求（unloadNow）は見ない。Windows の Core はタスクから切り離して動くので、unloadNow でも止めない
  // （止めるのは buddy-core stop）。bootedOut は常に false。
  async function unregister(): Promise<UnregisterResult> {
    if (commands === null) return noSystemRoot;
    const before = await query(commands);
    if (before !== null && !before.found)
      return {
        status: 'unregistered',
        removedDefinition: false,
        bootedOut: false,
      };
    const deleted = await run(commands.schtasks, [
      '/Delete',
      '/TN',
      taskPath,
      '/F',
    ]);
    if (deleted.exitCode === 0)
      return {
        status: 'unregistered',
        removedDefinition: true,
        bootedOut: false,
      };
    // 問い合わせに失敗していた・消す間に消えた場合は、もう一度確かめてから失敗にする。
    const after = await query(commands);
    if (after !== null && !after.found)
      return {
        status: 'unregistered',
        removedDefinition: false,
        bootedOut: false,
      };
    return failed('delete_task', [
      `schtasks_delete_exit:${exitOf(deleted.exitCode)}`,
    ]);
  }

  async function status(): Promise<SupervisorStatus> {
    if (commands === null) return noSystemRoot;
    const found = await query(commands);
    if (found === null) return failed('query_task', ['task_query_failed']);
    const load: LoadState =
      found.found && found.enabled ? 'loaded' : 'not_loaded';
    return {
      status: 'ok',
      platform: 'windows',
      definitionPath: taskPath,
      installed: found.found,
      load,
    };
  }

  return { platform: 'windows', register, unregister, status };
}
