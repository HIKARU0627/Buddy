// preload の限定 API（invoke・onNotification）と画面の状態をつなぐフック（ADR 0014・0015・0024）。
// 画面の部品はこのフックが返す値と操作だけを使い、限定 API を直接呼ばない。
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DesktopIpcRequest } from '@buddy/contracts';
import type { BuddyDesktopApi } from '../desktop-api.js';
import { request } from '../desktop-api.js';
import {
  INITIAL_VIEW_STATE,
  applyIpcFailure,
  applyNotification,
  applyResponse,
  deviceActions,
} from './desktop-state.js';
import type { DesktopViewState, DeviceActions } from './desktop-state.js';

export interface DesktopStateHandle {
  readonly state: DesktopViewState;
  readonly actions: DeviceActions;
}

export function useDesktopState(api: BuddyDesktopApi): DesktopStateHandle {
  const [state, setState] = useState<DesktopViewState>(INITIAL_VIEW_STATE);

  const send = useCallback(
    (built: DesktopIpcRequest) => {
      api
        .invoke(built)
        .then((response) => setState((prev) => applyResponse(prev, response)))
        .catch(() => setState(applyIpcFailure));
    },
    [api],
  );

  useEffect(() => {
    const unsubscribe = api.onNotification((notification) =>
      setState((prev) => applyNotification(prev, notification)),
    );
    send(request('desktop.get_state', null));
    return unsubscribe;
  }, [api, send]);

  const actions = useMemo(
    () => deviceActions(state.status, send),
    [state.status, send],
  );
  return { state, actions };
}
