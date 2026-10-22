// 状態帯と停止の帯に出す行を、状態欄・接続の状態から作る（ADR 0024 の対応表・ADR 0025）。
// React と DOM に依存しない純粋な関数で、node:test で試験する。色と記号は tones.ts の対応表に従う。
import type { DesktopConnectionView, DesktopStatusBar } from '@buddy/contracts';
import { afterOf, clockOf } from '../format.js';
import {
  DISPLAY_TARGET_LABELS,
  IO_STATE_LABELS,
  NOT_RECEIVED,
  POWER_EVENT_LABELS,
  STORAGE_MODE_LABELS,
  VOICE_STATE_LABELS,
} from '../labels.js';
import type { StatusLine } from '../tones.js';
import type { StopCause } from './desktop-state.js';

type Shown = Extract<DesktopStatusBar, { visibility: 'shown' }>;
type ShownConnection = Extract<DesktopConnectionView, { visibility: 'shown' }>;

// 入出力の主状態。受付中は success、本人が意図した停止は中立、来客モード・全体停止は要対応（warning）。
export function ioLine(status: Shown): StatusLine {
  switch (status.stop_scope) {
    case 'none':
      return { tone: 'success', mark: 'dot', text: IO_STATE_LABELS.none };
    case 'local':
      return { tone: 'neutral', mark: 'square', text: IO_STATE_LABELS.local };
    case 'guest':
      return { tone: 'warning', mark: 'square', text: IO_STATE_LABELS.guest };
    case 'global':
      return { tone: 'warning', mark: 'square', text: IO_STATE_LABELS.global };
  }
}

// 中枢との接続の 1 行。接続の状態（登録・ペアリング）があればそれを使い、なければ状態欄の値を使う。
export function hubLine(
  status: Shown,
  connection: DesktopConnectionView | null,
  now: number,
): StatusLine {
  const shown: ShownConnection | null =
    connection?.visibility === 'shown' ? connection : null;
  if (shown !== null) {
    if (shown.registration === 'secure_storage_unavailable')
      return { tone: 'danger', mark: 'warning', text: '登録できません' };
    if (shown.registration === 'reregistration_required')
      return { tone: 'warning', mark: 'warning', text: '再登録が必要です' };
    if (shown.registration === 'unregistered')
      return { tone: 'neutral', mark: 'none', text: '未登録' };
    switch (shown.link) {
      case 'connected':
        return {
          tone: 'success',
          mark: 'dot',
          text:
            shown.last_confirmed_at === null
              ? '接続中'
              : `接続中（${clockOf(shown.last_confirmed_at, now)} 確認）`,
        };
      case 'connecting':
        return { tone: 'neutral', mark: 'spinner', text: '接続しています' };
      case 'waiting_retry':
        return {
          tone: 'warning',
          mark: 'circle',
          text:
            shown.retry_at === null
              ? '接続し直しを待っています'
              : `接続し直しを待っています。次は ${clockOf(shown.retry_at, now)}（${afterOf(shown.retry_at, now)}）`,
        };
      case 'upgrade_required':
        return {
          tone: 'danger',
          mark: 'warning',
          text: '中枢の版が違うため使えません',
        };
      case 'reregistration_required':
        return { tone: 'warning', mark: 'warning', text: '再登録が必要です' };
      case 'not_connected':
        return { tone: 'neutral', mark: 'none', text: '未接続' };
    }
  }
  if (status.hub_connection === 'connected')
    return {
      tone: 'success',
      mark: 'dot',
      text:
        status.hub_last_confirmed_at === null
          ? '接続中'
          : `接続中（${clockOf(status.hub_last_confirmed_at, now)} 確認）`,
    };
  if (status.hub_connection === 'unreachable')
    return { tone: 'warning', mark: 'circle', text: '接続できません' };
  return { tone: 'neutral', mark: 'none', text: '未接続' };
}

export interface DetailItem {
  readonly label: string;
  readonly value: string;
  // 中枢から受け取っていない（—）。
  readonly missing: boolean;
}

const item = (label: string, value: string | null): DetailItem => ({
  label,
  value: value ?? NOT_RECEIVED,
  missing: value === null,
});

// 状態帯の下の詳細（設計 01「いつも見える状態」の項目。値のないものは —）。
export function detailItems(status: Shown): DetailItem[] {
  const yesNo = (value: boolean | null, yes: string, no: string) =>
    value === null ? null : value ? yes : no;
  return [
    item(
      '表示先',
      status.display_target === null
        ? null
        : (DISPLAY_TARGET_LABELS[status.display_target] ?? null),
    ),
    item(
      '音声',
      status.voice_state === null
        ? null
        : (VOICE_STATE_LABELS[status.voice_state] ?? null),
    ),
    item(
      '保存モード',
      status.storage_mode === null
        ? null
        : (STORAGE_MODE_LABELS[status.storage_mode] ?? null),
    ),
    item('予算保留', yesNo(status.budget_held, '保留あり', 'なし')),
    item('安全停止', yesNo(status.safety_stopped, '安全停止中', 'なし')),
  ];
}

// 停止の帯の「止まった理由と時刻」。
export function stopReasonText(
  status: Shown,
  cause: StopCause | null,
  now: number,
): string | null {
  if (status.stop_scope === 'guest')
    return '来客モードのため止まっています。解除は中枢で行います。';
  if (status.stop_scope === 'global')
    return '全体停止のため止まっています。解除は中枢で行います。';
  if (cause === null) return null;
  const at = clockOf(cause.at, now);
  if (cause.kind === 'button') return `${at} に停止ボタンで止めました。`;
  return `${at} に${POWER_EVENT_LABELS[cause.event]}で止まりました。`;
}
