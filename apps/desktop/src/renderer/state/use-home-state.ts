// 中枢の画面の「自宅のネットワーク」と preload の限定 API をつなぐフック（ADR 0024・0026、B03-08）。
// enabled（main が中枢の画面の端末と認めた hub_screen）でなくなったら表示を捨てる。読み取りは画面（タブを開いたとき・
// 「読み取り直す」）から始める。画面の部品はこのフックが返す値と操作だけを使い、限定 API を直接呼ばない。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopIpcRequest } from '@buddy/contracts';
import type { BuddyDesktopApi } from '../desktop-api.js';
import {
  INITIAL_HOME_STATE,
  applyHomeFailure,
  applyHomeResponse,
  homeActions,
  markHomeSending,
} from './home-state.js';
import type { HomeActions, HomeViewState } from './home-state.js';

export interface HomeStateHandle {
  readonly state: HomeViewState;
  readonly actions: HomeActions;
}

export function useHomeState(
  api: BuddyDesktopApi,
  enabled: boolean,
): HomeStateHandle {
  const [state, setState] = useState<HomeViewState>(INITIAL_HOME_STATE);
  // 表示を捨てた（中枢の画面でなくなった）後に届いた応答は使わない（古い表示・参照を戻さない）。
  const generation = useRef(0);

  const send = useCallback(
    (built: DesktopIpcRequest) => {
      const sentIn = generation.current;
      const current = () => generation.current === sentIn;
      setState((prev) => markHomeSending(prev, built));
      api
        .invoke(built)
        .then((response) => {
          if (current())
            setState((prev) =>
              applyHomeResponse(prev, built.channel, response),
            );
        })
        .catch(() => {
          if (current())
            setState((prev) => applyHomeFailure(prev, built.channel));
        });
    },
    [api],
  );
  const dismiss = useCallback(
    () => setState((prev) => ({ ...prev, registered: false })),
    [],
  );
  const actions = useMemo(() => homeActions(send, dismiss), [send, dismiss]);

  useEffect(() => {
    if (enabled) return;
    generation.current += 1;
    setState(INITIAL_HOME_STATE);
  }, [enabled]);

  return { state, actions };
}
