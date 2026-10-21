// 端末状態から上部の状態欄の値を作る（設計 01 いつも見える状態、07 §2、ADR 0014・0025）。
// 中枢との接続（connected・unreachable・not_connected）と最終確認時刻は core-link から受け取る（B03-05）。
// 中枢が正本の値（表示先・保存モード・予算保留・安全停止）は中枢がまだ配っていないので、接続中でも null（不明）。
// 音声状態は null（B05 まで音声機能がない）。
import type { DesktopStatusBar } from '@buddy/contracts';
import { desktopInputPermitted, type DesktopIoState } from '@buddy/domain';

export interface StatusBarHub {
  readonly connection: 'not_connected' | 'connected' | 'unreachable';
  // UTC の RFC 3339。接続していないときは null。
  readonly lastConfirmedAt: string | null;
}

export const NOT_CONNECTED_HUB: StatusBarHub = {
  connection: 'not_connected',
  lastConfirmedAt: null,
};

export function buildStatusBar(
  state: DesktopIoState,
  hub: StatusBarHub = NOT_CONNECTED_HUB,
): DesktopStatusBar {
  // ロック中・ロック状態不明では内容を出さない。
  if (state.lockState !== 'unlocked')
    return { visibility: 'hidden', lock_state: state.lockState };
  return {
    visibility: 'shown',
    lock_state: 'unlocked',
    stop_scope: state.stopScope,
    input_permitted: desktopInputPermitted(state),
    io_epoch: state.ioEpoch,
    voice_state: null,
    hub_connection: hub.connection,
    hub_last_confirmed_at:
      hub.connection === 'not_connected' ? null : hub.lastConfirmedAt,
    display_target: null,
    storage_mode: null,
    budget_held: null,
    safety_stopped: null,
  };
}
