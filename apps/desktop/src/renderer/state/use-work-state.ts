// 会話・変更の確認・処理状況と preload の限定 API をつなぐフック（B04-05、ADR 0024・0031）。
// 表示の権限の世代（ロック・接続待ちで進める）をまたいだ応答は捨てる（ADR 0026 と同じ形）。ロック中は会話と確認の
// 内容を捨てて隠す。操作の一覧は main が参照つきで通知する値（connection.operations）で、このフックは持たない。
// 画面の部品はこのフックが返す値と操作だけを使い、限定 API を直接呼ばない。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopOperationEntry } from '@buddy/contracts';
import type { BuddyDesktopApi } from '../desktop-api.js';
import {
  INITIAL_WORK_STATE,
  forgetWork,
  syncOperations,
  workActions,
} from './work-state.js';
import type { WorkActions, WorkViewState } from './work-state.js';

export interface WorkStateHandle {
  readonly state: WorkViewState;
  readonly actions: WorkActions;
}

// shown: 会話を出してよいか（ロック解除済みで、中枢に接続している間）。出せない間は、内容を持たない。
export function useWorkState(
  api: BuddyDesktopApi,
  shown: boolean,
  operations: readonly DesktopOperationEntry[],
): WorkStateHandle {
  const [state, setState] = useState<WorkViewState>(INITIAL_WORK_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const epochRef = useRef(0);

  const actions = useMemo(
    () =>
      workActions({
        state: () => stateRef.current,
        update: (change) => {
          // 同じ描画の間に続けて呼ばれても、最新の状態に重ねる。
          stateRef.current = change(stateRef.current);
          setState(stateRef.current);
        },
        send: (built, onResponse, onFailure, before) => {
          const epoch = epochRef.current;
          stateRef.current = before(stateRef.current);
          setState(stateRef.current);
          const apply = (change: (prev: WorkViewState) => WorkViewState) => {
            // ロック・接続待ちをまたいだ応答は捨てる（内容を戻さない）。
            if (epoch !== epochRef.current) return;
            stateRef.current = change(stateRef.current);
            setState(stateRef.current);
          };
          api
            .invoke(built)
            .then((response) => apply((prev) => onResponse(prev, response)))
            .catch(() => apply(onFailure));
        },
      }),
    [api],
  );

  useEffect(() => {
    if (shown) return;
    epochRef.current += 1;
    stateRef.current = forgetWork();
    setState(stateRef.current);
  }, [shown]);

  useEffect(() => {
    const next = syncOperations(stateRef.current, operations);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
  }, [operations]);

  return { state, actions };
}
