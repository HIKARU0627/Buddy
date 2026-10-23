// 予算の確認と preload の限定 API をつなぐフック（B07-05、ADR 0039）。
// 状態の持ち方（表示の権限の世代・応答の破棄）は React に依存しない BudgetStore（budget-state.ts）にあり、node:test で試験する。
// 世代（ロック・切断・接続待ちで進める）をまたいだ応答は捨てる（WorkStore と同じ形）。出せない間は内容を捨てて隠す。
// 項目の一覧は main が参照つきで通知する値（connection.budget_items）で、このフックは持たない。
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { DesktopBudgetEntry } from '@buddy/contracts';
import type { BuddyDesktopApi } from '../desktop-api.js';
import { BudgetStore } from './budget-state.js';
import type { BudgetActions, BudgetViewState } from './budget-state.js';

export interface BudgetStateHandle {
  readonly state: BudgetViewState;
  readonly actions: BudgetActions;
}

// shown: 出してよいか（ロック解除済みで、中枢に接続している間）。出せない間は、内容を持たない。
export function useBudgetState(
  api: BuddyDesktopApi,
  shown: boolean,
  items: readonly DesktopBudgetEntry[],
): BudgetStateHandle {
  const store = useMemo(() => new BudgetStore(api), [api]);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => {
    if (!shown) store.hide();
  }, [store, shown]);
  useEffect(() => {
    store.sync(items);
  }, [store, items]);
  return { state, actions: store.actions };
}
