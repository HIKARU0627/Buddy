// macOS の起動・監督アダプター: ログイン後の LaunchAgent で Core を起動する（設計 02、決定事項 J01、ADR 0013）。
// サインイン前に動く LaunchDaemon は使わない。FileVault 有効の中枢は、停電などの後は本人のログインまで止まり、
// ログイン後に LaunchAgent で再開する。
// KeepAlive は付けない。異常終了後に launchd が自動で再起動すると、旧担当の終了確認なしに Core が並行実行し得るため。
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { CommandRunner } from './runner.js';
import type {
  CoreLaunchSpec,
  FailedResult,
  LoadState,
  RegisterRequest,
  RegisterResult,
  StartupSupervisor,
  SupervisorStatus,
  UnregisterRequest,
  UnregisterResult,
} from './supervisor.js';

/** 個人情報を含まない固定の汎用名。 */
export const LAUNCH_AGENT_LABEL = 'dev.buddy.core';
export const LAUNCHCTL_PATH = '/bin/launchctl';
/** `launchctl print` が対象のサービスを見つけられなかったときの終了コード。 */
export const LAUNCHCTL_SERVICE_NOT_FOUND = 113;

const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/u;
// XML 1.0 で使えない文字と、パスに入れない制御文字（タブ・改行を含む）。
// 対になっていないサロゲート（\p{Cs}）と U+FFFE・U+FFFF も拒否する。
function hasInvalidPathCharacter(value: string): boolean {
  if (/\p{Cs}/u.test(value)) return true;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || code === 0xfffe || code === 0xffff)
      return true;
  }
  return false;
}

export interface LaunchAgentDefinition extends CoreLaunchSpec {
  readonly label?: string;
}

export interface LaunchAgentLogPaths {
  readonly stdout: string;
  readonly stderr: string;
}

/** ログの出力先。データディレクトリ内の logs/ に置く。 */
export function launchAgentLogPaths(dataDir: string): LaunchAgentLogPaths {
  return {
    stdout: posix.join(dataDir, 'logs', 'core.out.log'),
    stderr: posix.join(dataDir, 'logs', 'core.err.log'),
  };
}

function pathReasons(field: string, value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0)
    return [`${field}_empty`];
  if (hasInvalidPathCharacter(value)) return [`${field}_invalid_character`];
  if (!posix.isAbsolute(value)) return [`${field}_not_absolute`];
  const normalized = posix.normalize(value);
  const trimmed =
    normalized.length > 1 && normalized.endsWith('/')
      ? normalized.slice(0, -1)
      : normalized;
  if (trimmed !== value) return [`${field}_not_normalized`];
  return [];
}

/** LaunchAgent の定義に使えない値の理由。空なら生成できる。 */
export function launchAgentDefinitionReasons(
  definition: LaunchAgentDefinition,
): string[] {
  const label = definition.label ?? LAUNCH_AGENT_LABEL;
  return [
    ...(LABEL_PATTERN.test(label) ? [] : ['label_invalid']),
    ...pathReasons('node_path', definition.nodePath),
    ...pathReasons('core_cli_path', definition.coreCliPath),
    ...pathReasons('data_dir', definition.dataDir),
  ];
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * LaunchAgent の plist を生成する純粋関数。
 * ProgramArguments は node・Core の CLI・`start --data-dir <path>`。RunAtLoad は true、KeepAlive は付けない。
 * 使えない値は例外にする（register は事前に launchAgentDefinitionReasons で失敗の結果へ変える）。
 */
export function renderLaunchAgentPlist(
  definition: LaunchAgentDefinition,
): string {
  const reasons = launchAgentDefinitionReasons(definition);
  if (reasons.length > 0)
    throw new TypeError(`LaunchAgent の定義が不正です: ${reasons.join(', ')}`);
  const label = definition.label ?? LAUNCH_AGENT_LABEL;
  const logs = launchAgentLogPaths(definition.dataDir);
  const string = (value: string) => `<string>${escapeXml(value)}</string>`;
  const args = [
    definition.nodePath,
    definition.coreCliPath,
    'start',
    '--data-dir',
    definition.dataDir,
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${string(label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((arg) => `    ${string(arg)}`),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  ${string(logs.stdout)}`,
    '  <key>StandardErrorPath</key>',
    `  ${string(logs.stderr)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export interface MacLaunchAgentOptions {
  readonly runner: CommandRunner;
  /** 本人のホームディレクトリ（Core では os.homedir()、試験では一時ディレクトリ）。 */
  readonly homeDir: string;
  /** 本人の uid（Core では process.getuid()）。`gui/<uid>` の対象に使う。 */
  readonly uid: number;
  readonly label?: string;
}

/** `~/Library/LaunchAgents/<label>.plist` */
export function launchAgentPlistPath(homeDir: string, label: string): string {
  return posix.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
}

function fsReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return `fs_error:${typeof code === 'string' ? code : 'unknown'}`;
}

function failed(step: string, reasons: readonly string[]): FailedResult {
  return { status: 'failed', step, reasons };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return false;
    throw error;
  }
}

export function createMacLaunchAgentSupervisor(
  options: MacLaunchAgentOptions,
): StartupSupervisor {
  const label = options.label ?? LAUNCH_AGENT_LABEL;
  if (!LABEL_PATTERN.test(label))
    throw new TypeError('LaunchAgent の label が不正です。');
  if (pathReasons('home_dir', options.homeDir).length > 0)
    throw new TypeError('homeDir は正規化した絶対パスにしてください。');
  if (!Number.isSafeInteger(options.uid) || options.uid < 0)
    throw new TypeError('uid は 0 以上の整数にしてください。');
  const { runner } = options;
  const domain = `gui/${options.uid}`;
  const service = `${domain}/${label}`;
  const plistPath = launchAgentPlistPath(options.homeDir, label);

  async function loadState(): Promise<LoadState> {
    const result = await runner.run(LAUNCHCTL_PATH, ['print', service]);
    if (result.exitCode === 0) return 'loaded';
    if (result.exitCode === LAUNCHCTL_SERVICE_NOT_FOUND) return 'not_loaded';
    return 'unknown';
  }

  async function writeDefinition(content: string, dataDir: string) {
    await mkdir(posix.dirname(plistPath), { recursive: true, mode: 0o755 });
    // launchd は StandardOutPath の親ディレクトリを作らないため、先に作る。
    await mkdir(posix.join(dataDir, 'logs'), { recursive: true, mode: 0o700 });
    const temporary = `${plistPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o644 });
      await chmod(temporary, 0o644);
      await rename(temporary, plistPath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async function register(request: RegisterRequest): Promise<RegisterResult> {
    // 本人が有効にしたことを明示的に受け取らない限り、ファイルもコマンドも触らない。
    if (request?.enabled !== true) return { status: 'not_enabled' };
    const definition: LaunchAgentDefinition = { ...request.launch, label };
    const reasons = launchAgentDefinitionReasons(definition);
    if (reasons.length > 0) return failed('invalid_spec', reasons);
    try {
      await writeDefinition(
        renderLaunchAgentPlist(definition),
        definition.dataDir,
      );
    } catch (error) {
      return failed('write_definition', [fsReason(error)]);
    }
    const state = await loadState();
    if (state === 'loaded')
      // 読み込み直すと実行中の Core を止めるため、定義の更新は次のログインから有効にする。
      return {
        status: 'registered',
        definitionPath: plistPath,
        loaded: true,
        alreadyLoaded: true,
      };
    if (request.loadNow !== true)
      return {
        status: 'registered',
        definitionPath: plistPath,
        loaded: false,
        alreadyLoaded: false,
      };
    if (state === 'unknown')
      return failed('query_load_state', ['launchctl_print_unexpected_result']);
    const result = await runner.run(LAUNCHCTL_PATH, [
      'bootstrap',
      domain,
      plistPath,
    ]);
    if (result.exitCode !== 0)
      return failed('bootstrap', [
        `launchctl_bootstrap_exit:${result.exitCode ?? 'none'}`,
      ]);
    return {
      status: 'registered',
      definitionPath: plistPath,
      loaded: true,
      alreadyLoaded: false,
    };
  }

  async function unregister(
    request: UnregisterRequest,
  ): Promise<UnregisterResult> {
    // 先に定義を消し、次のログインで起動しないことを優先する。
    let removedDefinition: boolean;
    try {
      removedDefinition = await exists(plistPath);
      await rm(plistPath, { force: true });
    } catch (error) {
      return failed('remove_definition', [fsReason(error)]);
    }
    if (request?.unloadNow !== true)
      return { status: 'unregistered', removedDefinition, bootedOut: false };
    if ((await loadState()) === 'not_loaded')
      return { status: 'unregistered', removedDefinition, bootedOut: false };
    const result = await runner.run(LAUNCHCTL_PATH, ['bootout', service]);
    if (result.exitCode === 0)
      return { status: 'unregistered', removedDefinition, bootedOut: true };
    if ((await loadState()) === 'not_loaded')
      return { status: 'unregistered', removedDefinition, bootedOut: false };
    return failed('bootout', [
      `launchctl_bootout_exit:${result.exitCode ?? 'none'}`,
    ]);
  }

  async function status(): Promise<SupervisorStatus> {
    return {
      status: 'ok',
      platform: 'macos',
      definitionPath: plistPath,
      installed: await exists(plistPath),
      load: await loadState(),
    };
  }

  return { platform: 'macos', register, unregister, status };
}
