// 自動実行の画面と preload の限定 API をつなぐフック（B13-05、ADR 0154）。
// 状態の持ち方（表示の権限の世代・応答の破棄）は React に依存しない AutoActionStore（auto-action-state.ts）にあり、
// node:test で試験する。出してよい間（ロック解除済みで、中枢に接続している間）になったら一覧を読み、出せなくなったら
// 内容を捨てる。一覧は開いたとき（出せるようになったとき）と本人の「読み直す」・取り消し・解除の後に読む。
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { BuddyDesktopApi } from '../desktop-api.js';
import { AutoActionStore } from './auto-action-state.js';
import type {
  AutoActionActions,
  AutoActionViewState,
} from './auto-action-state.js';

export interface AutoActionStateHandle {
  readonly state: AutoActionViewState;
  readonly actions: AutoActionActions;
}

// changed は取り消し・本人の読み直しの後に呼ぶ（気づきの欄を読み直させる。ADR 0199）。
export function useAutoActionState(
  api: BuddyDesktopApi,
  shown: boolean,
  changed?: () => void,
): AutoActionStateHandle {
  const store = useMemo(
    () => new AutoActionStore(api, changed),
    [api, changed],
  );
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => {
    // 開いたときの読み取りは気づきの欄へ知らせない（気づきの欄も同時に開いて読む）。
    if (shown) store.actions.reload();
    else store.hide();
  }, [store, shown]);
  return { state, actions: store.actions };
}
