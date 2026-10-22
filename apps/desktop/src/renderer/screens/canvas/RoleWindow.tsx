// 3 つの窓の画面の切り替え（UI-02 の試作、ADR 0032）。preload が渡した窓の役割で、キャンバス・状態の層・入力バーの
// どれを描くかを決める。役割で使えるチャネルは main が決め、画面は役割の表にある要求だけを送る。
import type { BuddyDesktopApi } from '../../desktop-api.js';
import { useRoleWindowState } from '../../state/use-role-window-state.js';
import {
  inputBarEnabled,
  statusTabView,
} from '../../state/window-role-state.js';
import type { RendererWindowRole } from '../../state/window-role-state.js';
import { CanvasGround } from './CanvasGround.js';
import { InputBar } from './InputBar.js';
import { StatusTab } from './StatusTab.js';

export function RoleWindow({
  api,
  role,
}: {
  readonly api: BuddyDesktopApi;
  readonly role: Exclude<RendererWindowRole, 'legacy'>;
}) {
  const state = useRoleWindowState(api, role);
  if (role === 'canvas') return <CanvasGround />;
  const view = statusTabView(state.status, state.connection);
  if (role === 'status') return <StatusTab view={view} />;
  return <InputBar line={view.line} enabled={inputBarEnabled(state.status)} />;
}
