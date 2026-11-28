// Windows の中枢の電源の診断（macOS の pmset の診断にあたる。ADR 0013・0203）。
//
// 中枢はスリープ・休止状態にしない設定にする（スリープ中の動作は保証しない）。今の電源プランの、電源に
// つないでいるとき（AC）の「スリープまでの時間」（SUB_SLEEP の STANDBYIDLE）と「休止状態までの時間」
// （HIBERNATEIDLE）を `powercfg /query` で読む。管理者の権限は要らない。
// powercfg の出力の見出しは利用者の言語に訳されるので読まず、16 進の値の行（`: 0x........`）の並びだけを使う。
// 範囲の設定の出力は「最小・最大・増分・AC の現在値・DC の現在値」の 5 つの 16 進の値を持つ。数が違えば unknown。
// プラン名（利用者が付けた名前を含み得る）は読まない・出さない。判定できない出力は unknown にし、良好と推測しない。
// 休止状態そのものが無効（`powercfg /h off`）なら HIBERNATEIDLE の値によらず休止状態にならないので、
// `reg query HKLM\SYSTEM\CurrentControlSet\Control\Power /v HibernateEnabled`（本人の権限で読める）で確かめる。
// 読めなければ「休止状態になるかもしれない」に弱めた警告にする。
// 結果は表示用の警告で、起動の可否はここで決めない。ディスクの暗号化（BitLocker）は管理者の権限が要るので見ない。
// ノートの PC のふたを閉じたときの動作（SUB_BUTTONS の LIDACTION）は診断せず、手順書で確かめる（U725）。
import { win32 } from 'node:path';
import type { SystemSleepSetting } from './macos-diagnostics.js';
import type { CommandRunner } from './runner.js';
import { windowsSystem32 } from './windows-paths.js';

export const POWERCFG_STANDBY_ARGS: readonly string[] = [
  '/query',
  'SCHEME_CURRENT',
  'SUB_SLEEP',
  'STANDBYIDLE',
];
export const POWERCFG_HIBERNATE_ARGS: readonly string[] = [
  '/query',
  'SCHEME_CURRENT',
  'SUB_SLEEP',
  'HIBERNATEIDLE',
];

export const REG_HIBERNATE_ARGS: readonly string[] = [
  'query',
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power',
  '/v',
  'HibernateEnabled',
];

const UNKNOWN: SystemSleepSetting = { state: 'unknown', idleMinutes: null };

/** `reg query ... /v HibernateEnabled` の出力から、休止状態が使えるか（1）・無効か（0）を読む。読めなければ null。 */
export function parseHibernateEnabled(output: string): boolean | null {
  const values = [
    ...output.matchAll(
      /^\s*HibernateEnabled\s+REG_DWORD\s+0x([0-9A-Fa-f]{1,8})\s*$/gmu,
    ),
  ];
  if (values.length !== 1) return null;
  const value = Number.parseInt(
    (values[0] as RegExpMatchArray)[1] as string,
    16,
  );
  if (value === 0) return false;
  if (value === 1) return true;
  return null;
}

export interface PowercfgRangeValues {
  /** 電源につないでいるときの値（秒）。 */
  readonly ac: number;
  /** バッテリーのときの値（秒）。 */
  readonly dc: number;
}

/** 範囲の設定 1 つの `powercfg /query` の出力から AC・DC の現在値（秒）を読む。読めなければ null。 */
export function parsePowercfgRange(output: string): PowercfgRangeValues | null {
  const values: number[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /[:：]\s*0x([0-9A-Fa-f]{8})\s*$/u.exec(line);
    if (match) values.push(Number.parseInt(match[1] as string, 16));
  }
  if (values.length !== 5) return null;
  const [, , , ac, dc] = values as [number, number, number, number, number];
  return { ac, dc };
}

/** 秒の値をスリープの設定にする。0 はしない、それ以外は分（切り上げ）。 */
export function sleepSettingOfSeconds(seconds: number): SystemSleepSetting {
  if (!Number.isSafeInteger(seconds) || seconds < 0) return UNKNOWN;
  if (seconds === 0) return { state: 'never', idleMinutes: null };
  return { state: 'after_idle', idleMinutes: Math.ceil(seconds / 60) };
}

export interface WindowsHostDiagnostics {
  /** 電源につないでいるときのスリープ。 */
  readonly systemSleep: SystemSleepSetting;
  /** 電源につないでいるときの休止状態（休止状態そのものが無効なら never）。 */
  readonly hibernate: SystemSleepSetting;
  /** 休止状態そのものが使えるか（HibernateEnabled）。読めなければ null。 */
  readonly hibernateAvailable: boolean | null;
}

/** runner 経由で powercfg を読む。失敗した項目は unknown。 */
export async function readWindowsHostDiagnostics(
  runner: CommandRunner,
  systemRoot: string | undefined,
): Promise<WindowsHostDiagnostics> {
  const system32 = windowsSystem32(systemRoot);
  if (system32 === null)
    return {
      systemSleep: UNKNOWN,
      hibernate: UNKNOWN,
      hibernateAvailable: null,
    };
  const powercfg = win32.join(system32, 'powercfg.exe');
  const read = async (args: readonly string[]) => {
    try {
      const result = await runner.run(powercfg, args);
      if (result.exitCode !== 0) return UNKNOWN;
      const values = parsePowercfgRange(result.stdout);
      return values === null ? UNKNOWN : sleepSettingOfSeconds(values.ac);
    } catch {
      return UNKNOWN;
    }
  };
  const readHibernateEnabled = async (): Promise<boolean | null> => {
    try {
      const result = await runner.run(
        win32.join(system32, 'reg.exe'),
        REG_HIBERNATE_ARGS,
      );
      return result.exitCode === 0
        ? parseHibernateEnabled(result.stdout)
        : null;
    } catch {
      return null;
    }
  };
  const [systemSleep, hibernateIdle, hibernateAvailable] = await Promise.all([
    read(POWERCFG_STANDBY_ARGS),
    read(POWERCFG_HIBERNATE_ARGS),
    readHibernateEnabled(),
  ]);
  const hibernate: SystemSleepSetting =
    hibernateAvailable === false
      ? { state: 'never', idleMinutes: null }
      : hibernateIdle;
  return { systemSleep, hibernate, hibernateAvailable };
}

/** 本人へ表示する警告の理由コード。空なら推奨の設定。 */
export function windowsHostDiagnosticWarnings(
  diagnostics: WindowsHostDiagnostics,
): string[] {
  const warnings: string[] = [];
  if (diagnostics.systemSleep.state === 'after_idle')
    warnings.push('system_sleep_enabled');
  if (diagnostics.systemSleep.state === 'unknown')
    warnings.push('system_sleep_unknown');
  if (diagnostics.hibernate.state === 'after_idle')
    warnings.push(
      diagnostics.hibernateAvailable === true
        ? 'hibernate_enabled'
        : 'hibernate_maybe_enabled',
    );
  if (diagnostics.hibernate.state === 'unknown')
    warnings.push('hibernate_unknown');
  return warnings;
}
