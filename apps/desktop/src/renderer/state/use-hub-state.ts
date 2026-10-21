// 中枢の画面の端末の「申請の承認」「端末の管理」と preload の限定 API をつなぐフック（ADR 0024・0026）。
// enabled（main が中枢の画面の端末と認めた hub_screen）のときだけ一覧を取り、承認待ちの申請は一定の間隔で取り直す。
// 画面の部品はこのフックが返す値と操作だけを使い、限定 API を直接呼ばない。
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DesktopIpcRequest } from '@buddy/contracts';
import type { BuddyDesktopApi } from '../desktop-api.js';
import {
  CLAIMS_REFRESH_MS,
  INITIAL_HUB_STATE,
  applyHubFailure,
  applyHubResponse,
  hubActions,
  markSending,
} from './hub-state.js';
import type { HubActions, HubViewState } from './hub-state.js';

export interface HubStateHandle {
  readonly state: HubViewState;
  readonly actions: HubActions;
}

export function useHubState(
  api: BuddyDesktopApi,
  enabled: boolean,
): HubStateHandle {
  const [state, setState] = useState<HubViewState>(INITIAL_HUB_STATE);

  const send = useCallback(
    (built: DesktopIpcRequest) => {
      setState((prev) => markSending(prev, built));
      api
        .invoke(built)
        .then((response) =>
          setState((prev) => applyHubResponse(prev, built.channel, response)),
        )
        .catch(() => setState(applyHubFailure));
    },
    [api],
  );
  const actions = useMemo(() => hubActions(send), [send]);

  useEffect(() => {
    if (!enabled) {
      setState(INITIAL_HUB_STATE);
      return undefined;
    }
    actions.refreshClaims();
    actions.refreshDevices();
    const timer = window.setInterval(actions.refreshClaims, CLAIMS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [enabled, actions]);

  return { state, actions };
}
