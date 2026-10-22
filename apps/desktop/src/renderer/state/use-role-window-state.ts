// 3 つの窓（UI-02 の試作）の画面と限定 API をつなぐフック。窓の役割の表にあるチャネルだけを送る（ADR 0032）。
// 画面の部品はこのフックが返す値だけを使い、限定 API を直接呼ばない。
import { useEffect, useState } from 'react';
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

export function useRoleWindowState(
  api: BuddyDesktopApi,
  role: Exclude<RendererWindowRole, 'legacy'>,
): DesktopViewState {
  const [state, setState] = useState<DesktopViewState>(INITIAL_VIEW_STATE);
  useEffect(() => {
    const unsubscribe = api.onNotification((notification) =>
      setState((prev) => applyNotification(prev, notification)),
    );
    for (const channel of initialChannelsFor(role))
      api
        .invoke(request(channel, null))
        .then((response) =>
          setState((prev) => applyResponse(prev, response, channel)),
        )
        .catch(() => setState((prev) => applyIpcFailure(prev, channel)));
    return unsubscribe;
  }, [api, role]);
  return state;
}
