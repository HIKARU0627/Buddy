// 中枢の画面の端末の「申請の承認」「端末の管理」と preload の限定 API をつなぐフック（ADR 0024・0026）。
// mode が live（main が中枢の画面の端末と認めた hub_screen）のときだけ一覧を取り、承認待ちの申請は一定の間隔で
// 取り直す。paused（前に中枢の画面と確かめたが、今は中枢との接続を待っている）のときは、最後の一覧を残したまま
// 取り直さない（操作は画面が止める）。off のときは捨てる。画面のロックでは、コードの表示を消す。
// 画面の部品はこのフックが返す値と操作だけを使い、限定 API を直接呼ばない。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BuddyDesktopApi } from '../desktop-api.js';
import {
  CLAIMS_REFRESH_MS,
  INITIAL_HUB_STATE,
  applyHubFailure,
  applyHubResponse,
  dropStaleResponse,
  forgetSession,
  hubActions,
  markSending,
} from './hub-state.js';
import type { HubActions, HubViewState } from './hub-state.js';

export type HubMode = 'live' | 'paused' | 'off';

export interface HubStateHandle {
  readonly state: HubViewState;
  readonly actions: HubActions;
}

export function useHubState(
  api: BuddyDesktopApi,
  mode: HubMode,
  locked: boolean,
): HubStateHandle {
  const [state, setState] = useState<HubViewState>(INITIAL_HUB_STATE);
  // 要求の通し番号（一覧の順）と、表示の権限の世代（ロック・捨てたときに進め、またいだ応答は捨てる）。
  const seqRef = useRef(0);
  const epochRef = useRef(0);

  const actions = useMemo(
    () =>
      hubActions({
        request: (built, operation) => {
          seqRef.current += 1;
          const seq = seqRef.current;
          const epoch = epochRef.current;
          setState((prev) => markSending(prev, built, operation, seq));
          api
            .invoke(built)
            .then((response) => {
              // 応答が届いた時点の通し番号（これより前に始めた一覧は、変更の操作の結果を知らない）。
              seqRef.current += 1;
              const doneSeq = seqRef.current;
              setState((prev) =>
                epoch === epochRef.current
                  ? applyHubResponse(
                      prev,
                      built.channel,
                      response,
                      Date.now(),
                      seq,
                      doneSeq,
                    )
                  : dropStaleResponse(prev, built.channel),
              );
            })
            .catch(() =>
              setState((prev) =>
                epoch === epochRef.current
                  ? applyHubFailure(prev, built.channel)
                  : dropStaleResponse(prev, built.channel),
              ),
            );
        },
        update: (change) => setState(change),
      }),
    [api],
  );

  useEffect(() => {
    if (mode === 'off') {
      epochRef.current += 1;
      setState(INITIAL_HUB_STATE);
      return undefined;
    }
    // paused（中枢との接続を待っている）に移るときも世代を進め、接続をまたいだ応答を捨てる。
    if (mode === 'paused') {
      epochRef.current += 1;
      return undefined;
    }
    actions.pollClaims();
    actions.refresh('devices');
    const timer = window.setInterval(actions.pollClaims, CLAIMS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [mode, actions]);

  useEffect(() => {
    if (!locked) return;
    epochRef.current += 1;
    setState(forgetSession);
  }, [locked]);

  return { state, actions };
}
