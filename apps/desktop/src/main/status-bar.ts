// 端末状態から上部の状態欄の値を作る（設計 01 いつも見える状態、07 §2、ADR 0014）。
// B01 は中枢に接続しない（ADR 0012）ので、中枢が正本の値は null（不明）、音声状態は null（B05 まで音声機能がない）。
import type { DesktopStatusBar } from '@buddy/contracts';
import { desktopInputPermitted, type DesktopIoState } from '@buddy/domain';

export function buildStatusBar(state: DesktopIoState): DesktopStatusBar {
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
    hub_connection: 'not_connected',
    hub_last_confirmed_at: null,
    display_target: null,
    storage_mode: null,
    budget_held: null,
    safety_stopped: null,
  };
}
