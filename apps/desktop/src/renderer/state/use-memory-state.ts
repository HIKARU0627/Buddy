// 忘却の画面と preload の限定 API をつなぐフック（UI-10、ADR 0183）。
// 状態の持ち方（表示の権限の世代・応答の破棄）は React に依存しない MemoryStore（memory-state.ts）にあり、node:test で試験する。
// 出してよい間（ロック解除済みで、中枢に接続している間）になったら一覧を読み、出せなくなったら内容を捨てる。
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { BuddyDesktopApi } from '../desktop-api.js';
import { MemoryStore } from './memory-state.js';
import type { MemoryActions, MemoryViewState } from './memory-state.js';

export interface MemoryStateHandle {
  readonly state: MemoryViewState;
  readonly actions: MemoryActions;
}

export function useMemoryState(
  api: BuddyDesktopApi,
  shown: boolean,
): MemoryStateHandle {
  const store = useMemo(() => new MemoryStore(api), [api]);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => {
    if (shown) store.open();
    else store.hide();
  }, [store, shown]);
  return { state, actions: store.actions };
}
