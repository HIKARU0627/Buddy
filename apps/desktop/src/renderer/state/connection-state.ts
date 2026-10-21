// 中枢との接続・ペアリングの画面の状態と、操作から送る要求（ADR 0024・0025）。
// React と DOM に依存しない純粋な関数だけを置き、node:test で試験する。手順の順序・受付の規則は main が持ち、
// ここは表示の判定と要求の組み立て（入力の形の確認）だけ。端末トークン・申請用の秘密は画面に来ない。
import type {
  DesktopConnectionView,
  DesktopIpcRequest,
} from '@buddy/contracts';
import { request } from '../desktop-api.js';

export type ShownConnection = Extract<
  DesktopConnectionView,
  { visibility: 'shown' }
>;
export type PairingView = NonNullable<ShownConnection['pairing']>;

// 中枢の既定のポート（ADR 0020）。
export const DEFAULT_HUB_PORT = 47443;

export function shownConnection(
  connection: DesktopConnectionView | null,
): ShownConnection | null {
  return connection?.visibility === 'shown' ? connection : null;
}

// ペアリングの画面を出すか（未登録・再登録が必要、またはペアリングの途中）。
export function needsPairing(connection: ShownConnection): boolean {
  return (
    connection.pairing !== null ||
    connection.registration === 'unregistered' ||
    connection.registration === 'reregistration_required'
  );
}

// 入力の形の確認（最終の検査は main の契約の検査）。
export function parsePort(text: string): number | null {
  if (!/^[0-9]{1,5}$/u.test(text.trim())) return null;
  const port = Number(text.trim());
  return port >= 1 && port <= 65535 ? port : null;
}

export function normalizeHost(text: string): string | null {
  const host = text.trim();
  if (host.length === 0 || host.length > 253) return null;
  // URL・パス・ポートを含めない（宛先だけ）。
  if (/[/\s@]|^\[|\]$/u.test(host)) return null;
  return /^[A-Za-z0-9.:-]+$/u.test(host) ? host : null;
}

// 指紋の最後の 4 桁の入力（空白を除き、4 桁の 16 進だけ。照合は main が行う）。
export function normalizeTail(text: string): string | null {
  const tail = text.replace(/\s/gu, '').toLowerCase();
  return /^[0-9a-f]{4}$/u.test(tail) ? tail : null;
}

export function normalizeCode(text: string): string | null {
  const code = text.replace(/[\s-]/gu, '');
  return /^[0-9]{8}$/u.test(code) ? code : null;
}

export function normalizeDeviceName(text: string): string | null {
  const name = text.trim();
  return name.length >= 1 && [...name].length <= 40 ? name : null;
}

export interface PairingActions {
  readonly begin: (host: string, port: number) => void;
  // 画面に表示している指紋と、本人が中枢の画面から入力した最後の 4 桁を送る
  // （main が受け取った証明書の指紋と比べ、4 桁が合うときだけ進む。ADR 0025）。
  readonly confirm: (fingerprint: string, tail: string) => void;
  readonly submit: (code: string, deviceName: string) => void;
  readonly cancel: () => void;
}

export function pairingActions(
  send: (built: DesktopIpcRequest) => void,
): PairingActions {
  return {
    begin: (host, port) =>
      send(request('desktop.pairing_begin', { host, port })),
    confirm: (fingerprint, tail) =>
      send(
        request('desktop.pairing_confirm', {
          fingerprint,
          fingerprint_tail: tail,
        }),
      ),
    submit: (code, deviceName) =>
      send(
        request('desktop.pairing_submit', {
          pairing_code: code,
          device_name: deviceName,
        }),
      ),
    cancel: () => send(request('desktop.pairing_cancel', null)),
  };
}
