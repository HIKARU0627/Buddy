// 気づきの画面と preload の限定 API をつなぐフック（B11-05、ADR 0132）。
// 状態の持ち方（表示の権限の世代・応答の破棄）は React に依存しない CandidateStore（candidate-state.ts）にあり、node:test で
// 試験する。出してよい間（ロック解除済みで、中枢に接続している間）になったら一覧を読み、出せなくなったら内容を捨てる。
// 一覧は開いたとき（出せるようになったとき）と本人の「読み直す」・状態の変更の後に読む（中枢は一覧の前に時間による遷移と
// 保持の掃除を回す）。
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { BuddyDesktopApi } from '../desktop-api.js';
import { CandidateStore } from './candidate-state.js';
import type {
  CandidateActions,
  CandidateViewState,
} from './candidate-state.js';

export interface CandidateStateHandle {
  readonly state: CandidateViewState;
  readonly actions: CandidateActions;
}

export function useCandidateState(
  api: BuddyDesktopApi,
  shown: boolean,
): CandidateStateHandle {
  const store = useMemo(() => new CandidateStore(api), [api]);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => {
    if (shown) store.actions.refresh();
    else store.hide();
  }, [store, shown]);
  return { state, actions: store.actions };
}
