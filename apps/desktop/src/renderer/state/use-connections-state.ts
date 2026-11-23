// 連携の接続の画面と preload の限定 API をつなぐフック（B08-02 P3・B09-05、ADR 0142）。
// 状態の持ち方（表示の権限の世代・応答の破棄）は React に依存しない ConnectionsStore（connections-state.ts）にあり、
// node:test で試験する。出してよい間（中枢の画面で、中枢に接続している間）になったら一覧を読み、出せなくなったら
// 内容を捨てる。一覧は開いたとき（出せるようになったとき）と本人の「読み直す」・取得範囲の変更の後に読む。
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { BuddyDesktopApi } from '../desktop-api.js';
import { ConnectionsStore } from './connections-state.js';
import type {
  ConnectionActions,
  ConnectionsViewState,
} from './connections-state.js';

export interface ConnectionsStateHandle {
  readonly state: ConnectionsViewState;
  readonly actions: ConnectionActions;
}

export function useConnectionsState(
  api: BuddyDesktopApi,
  shown: boolean,
): ConnectionsStateHandle {
  const store = useMemo(() => new ConnectionsStore(api), [api]);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => {
    if (shown) store.actions.refresh();
    else store.hide();
  }, [store, shown]);
  return { state, actions: store.actions };
}
