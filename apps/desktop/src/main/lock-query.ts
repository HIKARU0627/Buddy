// OS へのロック状態の問い合わせ結果を電源・ロックのイベントに読み替える（07 §2、ADR 0015）。
// Electron の powerMonitor.getSystemIdleState(閾値) の結果を受け取る。locked を返せる OS（macOS・Windows）だけで使い、
// それ以外の OS と unknown（取得できない）は null とし、ロック状態を unknown のままにする（解除済みと扱わない）。

export type SystemIdleState = 'active' | 'idle' | 'locked' | 'unknown';

// Electron の文書で lock-screen / unlock-screen と getSystemIdleState の locked に対応する OS。
export const LOCK_QUERY_PLATFORMS: readonly string[] = ['darwin', 'win32'];

// 問い合わせの閾値（秒）。idle と active はどちらも「ロックしていない」なので、値は判定に影響しない。
export const LOCK_QUERY_IDLE_THRESHOLD_SECONDS = 60;

export function lockQueryEvent(
  platform: string,
  idleState: SystemIdleState,
): 'lock_screen' | 'unlock_screen' | null {
  if (!LOCK_QUERY_PLATFORMS.includes(platform)) return null;
  if (idleState === 'locked') return 'lock_screen';
  if (idleState === 'active' || idleState === 'idle') return 'unlock_screen';
  // unknown と想定外の値は取得できなかったものとして扱う。
  return null;
}
