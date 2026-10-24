// 3 つの窓（キャンバス・状態の層・入力バー）の画面の状態（UI-02 の試作、ADR 0032）。
// React と DOM に依存しない純粋な関数だけを置き、node:test で試験する。受付の規則（役割ごとのチャネル）は main が持ち、
// ここは画面の切り替え・最初に送る要求・表示の判定だけ。
import type {
  DesktopConnectionView,
  DesktopIpcRequest,
  DesktopStatusBar,
} from '@buddy/contracts';
import { IO_STATE_LABELS } from '../labels.js';
import type { StatusLine } from '../tones.js';
import { ioLine } from './status-lines.js';
import { groupOperations } from './work-state.js';

export type RendererWindowRole = 'legacy' | 'canvas' | 'status' | 'input';

const ROLES: readonly RendererWindowRole[] = [
  'legacy',
  'canvas',
  'status',
  'input',
];

// preload が渡した窓の役割。値がない（古い preload）なら従来の窓、知らない値なら null（何も描かない）。
export function rendererWindowRole(value: unknown): RendererWindowRole | null {
  if (value === undefined) return 'legacy';
  return ROLES.find((role) => role === value) ?? null;
}

// 窓を開いたときに送る要求。役割の表（DESKTOP_ROLE_CHANNELS）にあるチャネルだけ（ほかは main が拒否する）。
export function initialChannelsFor(
  role: Exclude<RendererWindowRole, 'legacy'>,
): readonly DesktopIpcRequest['channel'][] {
  return role === 'status'
    ? ['desktop.get_state', 'desktop.get_connection', 'desktop.get_voice']
    : ['desktop.get_state'];
}

// 端のつまみに出す記号と数。記号は入出力の状態（tones.ts の対応表）。数は確認が必要な操作（承認待ちと結果不明。
// 今の画面の「確認が必要な操作」と同じ数え方）。ロック中・不明・受け取る前は数を出さない。
export interface StatusTabView {
  readonly line: StatusLine;
  readonly pending: number | null;
  // 読み上げの名前（画面には出さない）。
  readonly label: string;
}

export function statusTabView(
  status: DesktopStatusBar | null,
  connection: DesktopConnectionView | null,
): StatusTabView {
  if (status === null)
    return {
      line: { tone: 'neutral', mark: 'spinner', text: '確認中' },
      pending: null,
      label: 'Buddy の状態: 確認中',
    };
  if (status.visibility !== 'shown')
    return {
      line: { tone: 'muted', mark: 'circle', text: 'ロック中' },
      pending: null,
      label:
        status.lock_state === 'locked'
          ? 'Buddy の状態: ロック中'
          : 'Buddy の状態: ロック状態を確認中',
    };
  const line = ioLine(status);
  const pending =
    connection?.visibility === 'shown' &&
    connection.registration === 'registered'
      ? groupOperations(connection.operations).attention.length
      : null;
  return {
    line,
    pending,
    label:
      pending === null
        ? `Buddy の状態: ${IO_STATE_LABELS[status.stop_scope]}`
        : `Buddy の状態: ${IO_STATE_LABELS[status.stop_scope]}、確認が必要な操作 ${pending}` +
          ' 件',
  };
}

// 入力バーで文字を打てるか（ロック解除済みで、入出力が止まっていない）。
export function inputBarEnabled(status: DesktopStatusBar | null): boolean {
  return status?.visibility === 'shown' && status.input_permitted;
}

// 内容を出してよいか（ロック解除済み）。「打てるか」とは別。止まっている間は打てないが、打った文字は出してよい。
// ロック中・状態が不明・受け取る前は内容を出さない（ADR 0024・0032）。
export function contentShown(status: DesktopStatusBar | null): boolean {
  return status?.visibility === 'shown';
}

// キャンバスの記述を描いてよいか（ロック解除済みで、入出力が止まっていない）。入力バーの下書きと違い、停止中も描かない
// （ADR 0032 の「停止で隠す」。再開したら main が取り直して送る）。
export function canvasContentShown(status: DesktopStatusBar | null): boolean {
  return status?.visibility === 'shown' && status.stop_scope === 'none';
}

// 状態が変わった後の入力バーの下書き。内容を出せないとき（ロック中・不明）は捨てる（解除しても戻さない）。
// 描画にもこの値を使い、捨てる前の一瞬にも下書きを描かない。
export function inputDraftAfter(
  draft: string,
  status: DesktopStatusBar | null,
): string {
  return contentShown(status) ? draft : '';
}

// キャンバスを前に出す操作を出せるか（ロック解除済み。受付の正本は main）。
export function canSummonCanvas(status: DesktopStatusBar | null): boolean {
  return contentShown(status);
}
