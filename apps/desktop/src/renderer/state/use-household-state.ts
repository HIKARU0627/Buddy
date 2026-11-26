// 家計簿の画面と preload の限定 API をつなぐフック（ADR 0162）。
// 状態の持ち方（表示の権限の世代・応答の破棄）は React に依存しない HouseholdStore（household-state.ts）にあり、
// node:test で試験する。出してよい間（ロック解除済みで、中枢に接続している間）になったら今月を読み、出せなくなったら
// 内容を捨てる。
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { BuddyDesktopApi } from '../desktop-api.js';
import { HouseholdStore } from './household-state.js';
import type {
  HouseholdActions,
  HouseholdViewState,
} from './household-state.js';

export interface HouseholdStateHandle {
  readonly state: HouseholdViewState;
  readonly actions: HouseholdActions;
}

export function useHouseholdState(
  api: BuddyDesktopApi,
  shown: boolean,
): HouseholdStateHandle {
  const store = useMemo(() => new HouseholdStore(api), [api]);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => {
    if (shown) store.actions.refresh();
    else store.hide();
  }, [store, shown]);
  return { state, actions: store.actions };
}
