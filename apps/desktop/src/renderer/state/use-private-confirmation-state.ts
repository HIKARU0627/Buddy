// 記録しない会話の独立した確認と preload の限定 API をつなぐフック（ADR 0197、U503）。
// 状態の持ち方は React に依存しない PrivateConfirmationStore（private-confirmation-state.ts）にあり、node:test で試験する。
// 確認の一覧は main が参照つきで通知する値（connection.private_confirmations）で、このフックは持たない。
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { StorageMode } from '@buddy/contracts';
import type { BuddyDesktopApi } from '../desktop-api.js';
import { PrivateConfirmationStore } from './private-confirmation-state.js';
import type {
  PrivateConfirmationActions,
  PrivateConfirmationViewState,
} from './private-confirmation-state.js';

export interface PrivateConfirmationStateHandle {
  readonly state: PrivateConfirmationViewState;
  readonly actions: PrivateConfirmationActions;
}

// shown: 出してよいか（ロック解除済みで、中枢に接続している間）。storageMode: 状態欄の保存モード（中枢の値）。
// 出せない間と、記録しない会話の外（保存モードが private でない・不明）は、送っている印と結果の文言を捨てる（通常の会話の
// 間に記録しない会話の欄を残さない。ADR 0197 の見直し、U612）。
export function usePrivateConfirmationState(
  api: BuddyDesktopApi,
  shown: boolean,
  storageMode: StorageMode | null,
): PrivateConfirmationStateHandle {
  const store = useMemo(() => new PrivateConfirmationStore(api), [api]);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const live = shown && storageMode === 'private';
  useEffect(() => {
    if (!live) store.hide();
  }, [store, live]);
  return { state, actions: store.actions };
}
