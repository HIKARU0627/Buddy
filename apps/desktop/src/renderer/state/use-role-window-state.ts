// 3 つの窓（UI-02 の試作）の画面と限定 API をつなぐフック。窓の役割の表にあるチャネルだけを送る（ADR 0032）。
// 画面の部品はこのフックが返す値と操作だけを使い、限定 API を直接呼ばない。
import { useCallback, useEffect, useState } from 'react';
import type { BuddyDesktopApi } from '../desktop-api.js';
import { request } from '../desktop-api.js';
import {
  INITIAL_VIEW_STATE,
  applyIpcFailure,
  applyNotification,
  applyResponse,
} from './desktop-state.js';
import type { DesktopViewState } from './desktop-state.js';
import { initialChannelsFor } from './window-role-state.js';
import type { RendererWindowRole } from './window-role-state.js';

export interface RoleWindowHandle {
  readonly state: DesktopViewState;
  // キャンバスを前に出す（状態の層と入力バー。受け付けるかは main が決める）。
  readonly summonCanvas: () => void;
}

export function useRoleWindowState(
  api: BuddyDesktopApi,
  role: Exclude<RendererWindowRole, 'legacy'>,
): RoleWindowHandle {
  const [state, setState] = useState<DesktopViewState>(INITIAL_VIEW_STATE);
  useEffect(() => {
    const unsubscribe = api.onNotification((notification) =>
      setState((prev) => applyNotification(prev, notification)),
    );
    // 購読を始めてから状態を取る。main はキャンバスの窓の状態の取得を「通知を受け取る準備ができた」合図にして、今のキャンバスの
    // 記述を送り直す（UI-03。順序を入れ替えない）。
    for (const channel of initialChannelsFor(role))
      api
        .invoke(request(channel, null))
        .then((response) =>
          setState((prev) => applyResponse(prev, response, channel)),
        )
        .catch(() => setState((prev) => applyIpcFailure(prev, channel)));
    return unsubscribe;
  }, [api, role]);
  const summonCanvas = useCallback(() => {
    // 拒否（ロック中・前面でない）のときは何も変えない。画面の状態は main の通知で変わる。
    api.invoke(request('desktop.canvas_summon', null)).catch(() => undefined);
  }, [api]);
  return { state, summonCanvas };
}

// 窓が前面にある（キー入力を受ける）か。キャンバスが前に出たことを、窓の枠で示すために使う。
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  return focused;
}
