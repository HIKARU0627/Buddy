// 会話・変更の確認・処理状況と preload の限定 API をつなぐフック（B04-05、ADR 0024・0031）。
// 状態の持ち方（表示の権限の世代・応答の破棄）は React に依存しない WorkStore（work-state.ts）にあり、node:test で試験する。
// 世代（ロック・切断・接続待ちで進める）をまたいだ応答は捨てる（ADR 0026 と同じ形）。出せない間は会話と確認の内容を
// 捨てて隠す。操作の一覧は main が参照つきで通知する値（connection.operations）で、このフックは持たない。
// 画面の部品はこのフックが返す値と操作だけを使い、限定 API を直接呼ばない。
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { DesktopOperationEntry } from '@buddy/contracts';
import type { BuddyDesktopApi } from '../desktop-api.js';
import { WorkStore } from './work-state.js';
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
  const store = useMemo(() => new WorkStore(api), [api]);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => {
    if (!shown) store.hide();
  }, [store, shown]);
  useEffect(() => {
    store.sync(operations);
  }, [store, operations]);
  return { state, actions: store.actions };
}
