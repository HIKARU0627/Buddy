// キャンバスの物の中身（本文）を main に求めて、画面のメモリーだけに持つフック（UI-07、ADR 0032）。限定 API は直接呼ばず、
// 渡された ContentLoader（use-role-window-state の canvasContent）だけを使う。中身は React の状態にだけ置き、
// Web の保存の API（ブラウザーの保存領域・cookie）に書かない。ロック・停止・切断（記述を捨てた）・物が閉じられた・物のデータが
// 変わったときに捨てる（canvas-content-state.ts の syncContents）。
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { CanvasContent, DesktopCanvasView } from '@buddy/contracts';
import {
  EMPTY_STORE,
  contentArrived,
  contentFailed,
  mailClosed,
  mailOpened,
  mailOpening,
  syncContents,
} from './canvas-content-state.js';
import type {
  ContentRequest,
  ContentStore,
  ItemContent,
} from './canvas-content-state.js';

// 物の中身を求める（main へ）。取れたら中身と開いた行の位置、取れなかったら null（自動では送り直さない）。
export type ContentLoader = (
  itemId: string,
  expectedRevision: string,
  openRef: string | null,
) => Promise<{
  readonly content: CanvasContent;
  readonly open_index: number | null;
} | null>;

type Action =
  | { readonly type: 'sync'; readonly store: ContentStore }
  | {
      readonly type: 'arrived';
      readonly request: ContentRequest;
      readonly content: CanvasContent;
    }
  | { readonly type: 'failed'; readonly request: ContentRequest }
  | {
      readonly type: 'opening';
      readonly itemId: string;
      readonly index: number;
    }
  | {
      readonly type: 'opened';
      readonly itemId: string;
      readonly signature: string;
      readonly epoch: number;
      readonly mail: { readonly index: number; readonly body: string } | null;
    }
  | { readonly type: 'closed'; readonly itemId: string };

function reduce(store: ContentStore, action: Action): ContentStore {
  switch (action.type) {
    case 'sync':
      return action.store;
    case 'arrived':
      return contentArrived(store, action.request, action.content);
    case 'failed':
      return contentFailed(store, action.request);
    case 'opening':
      return mailOpening(store, action.itemId, action.index);
    case 'opened':
      return mailOpened(
        store,
        action.itemId,
        action.signature,
        action.epoch,
        action.mail,
      );
    case 'closed':
      return mailClosed(store, action.itemId);
  }
}

export interface CanvasContents {
  readonly of: (itemId: string) => ItemContent | undefined;
  // メールの本文を開く（開いている別の 1 通は閉じる）・閉じる（本文を捨てる）。
  readonly openMail: (itemId: string, index: number) => void;
  readonly closeMail: (itemId: string) => void;
}

const NONE: CanvasContents = {
  of: () => undefined,
  openMail: () => undefined,
  closeMail: () => undefined,
};

// loader が undefined なら何も取らない（中身は loading のまま。試験・中身の経路がない窓）。enabled が false（ロック中・停止中・
// 記述がない）ならすべて捨てる。
export function useCanvasContents(
  view: DesktopCanvasView | null,
  enabled: boolean,
  loader: ContentLoader | undefined,
): CanvasContents {
  const [store, dispatch] = useReducer(reduce, EMPTY_STORE);
  // 取れなかった答えが、取り始めた版より新しい版が届いた後に着いたとき、整え直す（その版で 1 度だけ取り直す）ための合図。
  const [recheck, requestRecheck] = useReducer((count: number) => count + 1, 0);
  const storeRef = useRef(store);
  storeRef.current = store;
  const viewRef = useRef(view);
  viewRef.current = view;
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  // 記述・描く条件が変わるたびに、中身を整えて足りない物を取りに行く。
  useEffect(() => {
    if (loader === undefined) return;
    const { store: next, requests } = syncContents(
      storeRef.current,
      view,
      enabled,
    );
    if (next !== storeRef.current) dispatch({ type: 'sync', store: next });
    // 失敗したとき、すでに新しい版が届いていたら（古い版を取っている間に記述が進み、main が古い取得を拒否した）、その版で取り直す。
    // 同じ版のままなら取り直さない（次の版が届くまで失敗の印のまま）。
    const failed = (request: ContentRequest) => {
      dispatch({ type: 'failed', request });
      if (viewRef.current?.canvas_revision !== request.revision)
        requestRecheck();
    };
    for (const request of requests)
      loader(request.item_id, request.revision, null)
        .then((result) =>
          result === null
            ? failed(request)
            : dispatch({ type: 'arrived', request, content: result.content }),
        )
        .catch(() => failed(request));
  }, [view, enabled, loader, recheck]);

  const openMail = useCallback((itemId: string, index: number) => {
    const current = viewRef.current;
    const load = loaderRef.current;
    const entry = storeRef.current.items[itemId];
    const item = current?.items.find(
      (candidate) => candidate.item_id === itemId,
    );
    const ref = item?.data.item_refs[index]?.ref;
    if (
      current === null ||
      load === undefined ||
      entry === undefined ||
      entry.status !== 'ready' ||
      ref === undefined ||
      entry.opening !== null
    )
      return;
    const { signature } = entry;
    const { epoch } = storeRef.current;
    dispatch({ type: 'opening', itemId, index });
    load(itemId, current.canvas_revision, ref)
      .then((result) => {
        const content = result?.content;
        const mail =
          content?.component === 'mail_card' && result?.open_index === index
            ? content.mails[index]
            : undefined;
        dispatch({
          type: 'opened',
          itemId,
          signature,
          epoch,
          mail:
            mail === undefined || mail.body === null
              ? null
              : { index, body: mail.body },
        });
      })
      .catch(() =>
        dispatch({ type: 'opened', itemId, signature, epoch, mail: null }),
      );
  }, []);

  const closeMail = useCallback(
    (itemId: string) => dispatch({ type: 'closed', itemId }),
    [],
  );

  const of = useCallback((itemId: string) => store.items[itemId], [store]);
  if (loader === undefined) return NONE;
  return { of, openMail, closeMail };
}
