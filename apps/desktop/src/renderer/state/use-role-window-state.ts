// 3 つの窓（UI-02 の試作）の画面と限定 API をつなぐフック。窓の役割の表にあるチャネルだけを送る（ADR 0032）。
// 画面の部品はこのフックが返す値と操作だけを使い、限定 API を直接呼ばない。
import { useCallback, useEffect, useState } from 'react';
import type { CanvasUserOp, DesktopIpcRequest } from '@buddy/contracts';
import type { CanvasInsets } from '@buddy/domain';
import { canvasInsetsFrom } from './canvas-layout-state.js';
import type { BuddyDesktopApi } from '../desktop-api.js';
import { request } from '../desktop-api.js';
import {
  INITIAL_VIEW_STATE,
  applyIpcFailure,
  applyNotification,
  applyResponse,
} from './desktop-state.js';
import type { DesktopViewState } from './desktop-state.js';
import { initialChannelsFor } from './window-role-state.js';
import type { RendererWindowRole } from './window-role-state.js';

export interface RoleWindowHandle {
  readonly state: DesktopViewState;
  // キャンバスを前に出す（状態の層と入力バー。受け付けるかは main が決める）。
  readonly summonCanvas: () => void;
  // 状態の層のパネルを出す・しまう（状態の層だけ。窓の大きさは main が変える。UI-04）。
  readonly setPanel: (open: boolean) => void;
  // この端末の入出力を止める・再開する（状態の層だけ。止めるは確認を挟まずいつでも。再開の条件は main が検査する）。
  readonly stop: () => void;
  readonly resume: (expectedIoEpoch: string) => void;
  // キャンバスの物のユーザーの操作（キャンバスの窓だけ。UI-06）。受け付けたら中枢が当てた後の版、拒否・失敗は null
  // （記述は main が取り直す）。
  readonly canvasUserOp: (
    op: CanvasUserOp,
    expectedRevision: string,
  ) => Promise<string | null>;
}

export function useRoleWindowState(
  api: BuddyDesktopApi,
  role: Exclude<RendererWindowRole, 'legacy'>,
): RoleWindowHandle {
  const [state, setState] = useState<DesktopViewState>(INITIAL_VIEW_STATE);
  useEffect(() => {
    const unsubscribe = api.onNotification((notification) =>
      setState((prev) => applyNotification(prev, notification)),
    );
    // 購読を始めてから状態を取る。main はキャンバスの窓の状態の取得を「通知を受け取る準備ができた」合図にして、今のキャンバスの
    // 記述を送り直す（UI-03。順序を入れ替えない）。
    for (const channel of initialChannelsFor(role))
      api
        .invoke(request(channel, null))
        .then((response) =>
          setState((prev) => applyResponse(prev, response, channel)),
        )
        .catch(() => setState((prev) => applyIpcFailure(prev, channel)));
    return unsubscribe;
  }, [api, role]);
  const summonCanvas = useCallback(() => {
    // 拒否（ロック中・前面でない）のときは何も変えない。画面の状態は main の通知で変わる。
    api.invoke(request('desktop.canvas_summon', null)).catch(() => undefined);
  }, [api]);
  const setPanel = useCallback(
    (open: boolean) => {
      // パネルを出しているかは main が変えた窓の幅で描く（応答では何も変えない）。
      api
        .invoke(request('desktop.status_panel', { open }))
        .catch(() => undefined);
    },
    [api],
  );
  // 停止・再開の応答は状態欄を返す（ほかの窓へは main の通知で届く）。
  const send = useCallback(
    (built: DesktopIpcRequest) => {
      const channel = built.channel;
      api
        .invoke(built)
        .then((response) =>
          setState((prev) => applyResponse(prev, response, channel)),
        )
        .catch(() => setState((prev) => applyIpcFailure(prev, channel)));
    },
    [api],
  );
  const stop = useCallback(
    () => send(request('desktop.io_stop', null)),
    [send],
  );
  const resume = useCallback(
    (expectedIoEpoch: string) =>
      send(
        request('desktop.io_resume', { expected_io_epoch: expectedIoEpoch }),
      ),
    [send],
  );
  const canvasUserOp = useCallback(
    (op: CanvasUserOp, expectedRevision: string) =>
      api
        .invoke(
          request('desktop.canvas_user_op', {
            expected_canvas_revision: expectedRevision,
            op,
          }),
        )
        .then((response) =>
          response.outcome === 'ok' &&
          response.channel === 'desktop.canvas_user_op'
            ? response.canvas_revision
            : null,
        )
        .catch(() => null),
    [api],
  );
  return { state, summonCanvas, setPanel, stop, resume, canvasUserOp };
}

export interface CanvasViewport {
  readonly size: { readonly width: number; readonly height: number };
  readonly insets: CanvasInsets;
}

const viewportNow = (): CanvasViewport => ({
  size: { width: window.innerWidth, height: window.innerHeight },
  insets: canvasInsetsFrom(window.screen, window),
});

// キャンバスの窓の大きさと、作業領域の外の幅（配置のエンジンの入力。UI-06）。窓の大きさが変わったら読み直す。
export function useCanvasViewport(): CanvasViewport {
  const [viewport, setViewport] = useState(viewportNow);
  useEffect(() => {
    const onResize = () => setViewport(viewportNow());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return viewport;
}

// 窓の幅（状態の層は、main が変えた窓の幅でパネルを描くか決める。UI-04）。
export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

// 窓が前面にある（キー入力を受ける）か。キャンバスが前に出たことを、窓の枠で示すために使う。
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  return focused;
}
