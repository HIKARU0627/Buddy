// preload が公開する限定 API（ADR 0014・0015）。画面は要求を作って送り、main が返した値を表示するだけ。
// 形式・送信元・受付の規則は main が検査する。画面は端末トークン・中枢・OS の API を持たない。
import type {
  DesktopIpcNotification,
  DesktopIpcRequest,
  DesktopIpcResponse,
} from '@buddy/contracts';

export interface BuddyDesktopApi {
  invoke(request: DesktopIpcRequest): Promise<DesktopIpcResponse>;
  onNotification(
    listener: (notification: DesktopIpcNotification) => void,
  ): () => void;
}

declare global {
  interface Window {
    readonly buddyDesktop?: BuddyDesktopApi;
  }
}

export function desktopApi(): BuddyDesktopApi | null {
  return window.buddyDesktop ?? null;
}

type RequestOf<C extends DesktopIpcRequest['channel']> = Extract<
  DesktopIpcRequest,
  { channel: C }
>;

export function request<C extends DesktopIpcRequest['channel']>(
  channel: C,
  payload: RequestOf<C>['payload'],
): DesktopIpcRequest {
  return {
    channel,
    request_id: crypto.randomUUID(),
    payload,
  } as DesktopIpcRequest;
}
