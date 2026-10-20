// macOS の中枢の診断（設計 02、ADR 0013）。
// Mac mini はシステムをスリープさせない設定にし（スリープ中の動作は保証しない）、FileVault を有効にする。
// 判定できない出力は unknown にし、良好と推測しない。結果は表示用の警告で、起動の可否はここで決めない。
import type { CommandRunner } from './runner.js';

export const PMSET_PATH = '/usr/bin/pmset';
export const FDESETUP_PATH = '/usr/bin/fdesetup';

export type SystemSleepState = 'never' | 'after_idle' | 'unknown';

export interface SystemSleepSetting {
  readonly state: SystemSleepState;
  /** after_idle のときのアイドル分数。それ以外は null。 */
  readonly idleMinutes: number | null;
}

export type FileVaultState =
  'on' | 'off' | 'encrypting' | 'decrypting' | 'unknown';

const UNKNOWN_SLEEP: SystemSleepSetting = {
  state: 'unknown',
  idleMinutes: null,
};

/**
 * `pmset -g` の出力から、システムのスリープ設定（sleep の行）を読み取る。
 * disksleep・displaysleep は対象外。`SleepDisabled 1` があればスリープしない。
 * sleep の行がない・複数の値がある・数値でない場合は unknown。
 */
export function parsePmsetSleep(output: string): SystemSleepSetting {
  const values = new Set<number>();
  let sleepDisabled = false;
  let malformed = false;
  for (const line of output.split(/\r?\n/u)) {
    const disabled = /^\s*SleepDisabled\s+(\S+)\s*$/u.exec(line);
    if (disabled) {
      if (disabled[1] === '1') sleepDisabled = true;
      else if (disabled[1] !== '0') malformed = true;
      continue;
    }
    const match = /^\s*sleep\s+(\S+)(?:\s.*)?$/u.exec(line);
    if (!match) continue;
    const raw = match[1] ?? '';
    if (!/^\d{1,6}$/u.test(raw)) {
      malformed = true;
      continue;
    }
    values.add(Number(raw));
  }
  if (sleepDisabled) return { state: 'never', idleMinutes: null };
  if (malformed || values.size !== 1) return UNKNOWN_SLEEP;
  const [minutes] = [...values];
  if (minutes === undefined) return UNKNOWN_SLEEP;
  return minutes === 0
    ? { state: 'never', idleMinutes: null }
    : { state: 'after_idle', idleMinutes: minutes };
}

/**
 * `fdesetup status` の出力から FileVault の状態を読み取る。
 * 「FileVault is On.」「FileVault is Off.」の行と、暗号化・復号の進行中の行だけを認める。
 */
export function parseFdesetupStatus(output: string): FileVaultState {
  const lines = output.split(/\r?\n/u).map((line) => line.trim());
  const on = lines.includes('FileVault is On.');
  const off = lines.includes('FileVault is Off.');
  const encrypting = lines.some((line) =>
    line.startsWith('Encryption in progress'),
  );
  const decrypting = lines.some((line) =>
    line.startsWith('Decryption in progress'),
  );
  if (encrypting && decrypting) return 'unknown';
  if (encrypting) return 'encrypting';
  if (decrypting) return 'decrypting';
  if (on === off) return 'unknown';
  return on ? 'on' : 'off';
}

export interface MacHostDiagnostics {
  readonly systemSleep: SystemSleepSetting;
  readonly fileVault: FileVaultState;
}

/** runner 経由で pmset と fdesetup を読む。失敗した項目は unknown。 */
export async function readMacHostDiagnostics(
  runner: CommandRunner,
): Promise<MacHostDiagnostics> {
  const [pmset, fdesetup] = await Promise.all([
    runner.run(PMSET_PATH, ['-g']),
    runner.run(FDESETUP_PATH, ['status']),
  ]);
  return {
    systemSleep:
      pmset.exitCode === 0 ? parsePmsetSleep(pmset.stdout) : UNKNOWN_SLEEP,
    fileVault:
      fdesetup.exitCode === 0
        ? parseFdesetupStatus(fdesetup.stdout)
        : 'unknown',
  };
}

/** 本人へ表示する警告の理由コード。空なら推奨の設定。 */
export function macHostDiagnosticWarnings(
  diagnostics: MacHostDiagnostics,
): string[] {
  const warnings: string[] = [];
  if (diagnostics.systemSleep.state === 'after_idle')
    warnings.push('system_sleep_enabled');
  if (diagnostics.systemSleep.state === 'unknown')
    warnings.push('system_sleep_unknown');
  if (diagnostics.fileVault === 'off' || diagnostics.fileVault === 'decrypting')
    warnings.push(`filevault_${diagnostics.fileVault}`);
  if (diagnostics.fileVault === 'unknown') warnings.push('filevault_unknown');
  return warnings;
}
