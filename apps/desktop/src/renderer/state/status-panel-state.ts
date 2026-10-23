// 状態の層のパネルと端のつまみの表示の判定（UI-04、ADR 0032・0014・0024）。React と DOM に依存しない純粋な関数だけを置き、
// node:test で試験する。受付の規則（役割ごとのチャネル・停止と再開の条件）と、パネルを出す・しまうの正本は main が持つ。
// - パネルを出しているかは、main が決めた窓の幅で判断する（panelShownFor）。画面は別に状態を持たない。
// - 状態の項目（ADR 0014 の 8 項目）は、記号と決まった位置で示し、名前と値はフォーカス・ポインターで出す。
// - プライバシーと権限に関わる状態（音声を外部へ送っている・記録しないモード・安全停止中）は、つまみの専用の記号で
//   いつも見せる。値がまだない（音声は B05、記録しないモードは UI-05、安全停止は中枢が配るまで）ときは枠だけを出す。
import type { DesktopConnectionView, DesktopStatusBar } from '@buddy/contracts';
import { clockOf } from '../format.js';
import {
  DISPLAY_TARGET_LABELS,
  NOT_RECEIVED,
  STORAGE_MODE_LABELS,
  VOICE_STATE_LABELS,
} from '../labels.js';
import type { StatusLine } from '../tones.js';
import { hubLine, ioLine } from './status-lines.js';

type Shown = Extract<DesktopStatusBar, { visibility: 'shown' }>;

// 窓の幅がこれ以上ならパネルを描く（つまみだけの窓は 56、パネルは 440。main の status-panel.ts）。
export const STATUS_PANEL_MIN_WIDTH = 200;

export function panelShownFor(width: number): boolean {
  return width >= STATUS_PANEL_MIN_WIDTH;
}

// ADR 0014 の常に見せる項目（設計 01 いつも見える状態）。並びは固定（位置で覚えられるように）。
export type StatusItemKey =
  | 'io'
  | 'hub'
  | 'last_confirmed'
  | 'display_target'
  | 'voice'
  | 'storage_mode'
  | 'budget'
  | 'safety';

export const STATUS_ITEM_KEYS: readonly StatusItemKey[] = [
  'io',
  'hub',
  'last_confirmed',
  'display_target',
  'voice',
  'storage_mode',
  'budget',
  'safety',
];

export const STATUS_ITEM_LABELS: Readonly<Record<StatusItemKey, string>> = {
  io: '入出力',
  hub: '中枢',
  last_confirmed: '最終確認',
  display_target: '表示先',
  voice: '音声',
  storage_mode: '保存モード',
  budget: '予算の保留',
  safety: '安全停止',
};

export interface StatusItem {
  readonly key: StatusItemKey;
  readonly label: string;
  // 記号と値（値は名前と一緒にフォーカス・ポインターで出す。読み上げは label と value）。
  readonly line: StatusLine;
  // 値を受け取っていない（—）。
  readonly missing: boolean;
}

const missingLine: StatusLine = {
  tone: 'neutral',
  mark: 'none',
  text: NOT_RECEIVED,
};

function item(key: StatusItemKey, line: StatusLine | null): StatusItem {
  return {
    key,
    label: STATUS_ITEM_LABELS[key],
    line: line ?? missingLine,
    missing: line === null,
  };
}

// パネルに出す 8 項目。ロック中・不明・受け取る前は null（内容を出さない。ADR 0014）。
export function statusItems(
  status: DesktopStatusBar | null,
  connection: DesktopConnectionView | null,
  now: number,
): readonly StatusItem[] | null {
  if (status === null || status.visibility !== 'shown') return null;
  const shownConnection =
    connection?.visibility === 'shown' ? connection : null;
  // 中枢の項目は接続の状態だけにする（最終確認の時刻は別の項目）。
  const hub = hubLine(
    { ...status, hub_last_confirmed_at: null },
    shownConnection === null
      ? null
      : { ...shownConnection, last_confirmed_at: null },
    now,
  );
  const confirmedAt =
    shownConnection?.last_confirmed_at ?? status.hub_last_confirmed_at;
  return [
    item('io', ioLine(status)),
    item('hub', hub),
    item(
      'last_confirmed',
      confirmedAt === null
        ? null
        : { tone: 'neutral', mark: 'dot', text: clockOf(confirmedAt, now) },
    ),
    item(
      'display_target',
      status.display_target === null
        ? null
        : {
            tone: 'neutral',
            mark: 'dot',
            text:
              DISPLAY_TARGET_LABELS[status.display_target] ??
              status.display_target,
          },
    ),
    item('voice', voiceLine(status)),
    item(
      'storage_mode',
      status.storage_mode === null
        ? null
        : {
            tone: status.storage_mode === 'private' ? 'warning' : 'neutral',
            mark: status.storage_mode === 'private' ? 'square' : 'dot',
            text:
              STORAGE_MODE_LABELS[status.storage_mode] ?? status.storage_mode,
          },
    ),
    item(
      'budget',
      status.budget_held === null
        ? null
        : status.budget_held
          ? { tone: 'warning', mark: 'warning', text: '保留あり' }
          : { tone: 'success', mark: 'dot', text: 'なし' },
    ),
    item(
      'safety',
      status.safety_stopped === null
        ? null
        : status.safety_stopped
          ? { tone: 'danger', mark: 'warning', text: '安全停止中' }
          : { tone: 'success', mark: 'dot', text: 'なし' },
    ),
  ];
}

function voiceLine(status: Shown): StatusLine | null {
  if (status.voice_state === null) return null;
  const text = VOICE_STATE_LABELS[status.voice_state] ?? status.voice_state;
  return voiceSendsExternally(status.voice_state)
    ? { tone: 'warning', mark: 'dot', text }
    : { tone: 'neutral', mark: 'circle', text };
}

// 音声を外部へ送っている状態（読み取り: 会話中と聞き取り中は Live の接続へ音声を送る。B05 で確かめ直す。ADR 0032）。
export function voiceSendsExternally(
  voice: NonNullable<Shown['voice_state']>,
): boolean {
  return voice === 'conversation_live' || voice === 'listening_text_reply';
}

// つまみの専用の記号（プライバシーと権限）。並びは固定。
export type PrivacyMarkKey = 'voice_external' | 'private_mode' | 'safety_stop';

export const PRIVACY_MARK_KEYS: readonly PrivacyMarkKey[] = [
  'voice_external',
  'private_mode',
  'safety_stop',
];

export const PRIVACY_MARK_LABELS: Readonly<Record<PrivacyMarkKey, string>> = {
  voice_external: '音声を外部へ送っている',
  private_mode: '記録しないモード',
  safety_stop: '安全停止中',
};

// on: その状態にある。off: その状態にない。unknown: 値がない（枠だけを出す）。hidden: ロック中・不明・受け取る前。
export type PrivacyMarkState = 'on' | 'off' | 'unknown' | 'hidden';

export interface PrivacyMark {
  readonly key: PrivacyMarkKey;
  readonly state: PrivacyMarkState;
  // 読み上げの名前（画面には出さない）。
  readonly label: string;
}

const STATE_SUFFIX: Readonly<Record<PrivacyMarkState, string>> = {
  on: '',
  off: 'ではない',
  unknown: 'かは未受信',
  hidden: 'かは隠しています',
};

export function privacyMarks(
  status: DesktopStatusBar | null,
): readonly PrivacyMark[] {
  const states: Record<PrivacyMarkKey, PrivacyMarkState> =
    status === null || status.visibility !== 'shown'
      ? {
          voice_external: 'hidden',
          private_mode: 'hidden',
          safety_stop: 'hidden',
        }
      : {
          voice_external:
            status.voice_state === null
              ? 'unknown'
              : voiceSendsExternally(status.voice_state)
                ? 'on'
                : 'off',
          private_mode:
            status.storage_mode === null
              ? 'unknown'
              : status.storage_mode === 'private'
                ? 'on'
                : 'off',
          safety_stop:
            status.safety_stopped === null
              ? 'unknown'
              : status.safety_stopped
                ? 'on'
                : 'off',
        };
  return PRIVACY_MARK_KEYS.map((key) => ({
    key,
    state: states[key],
    label: `${PRIVACY_MARK_LABELS[key]}${STATE_SUFFIX[states[key]]}`,
  }));
}

// パネルの先頭の、この端末の停止と再開。止めるは確認を挟まずいつでも（ロック中・不明でも）。再開はロック解除済みで、
// この端末の停止のときだけ（来客モード・全体停止の解除は中枢の操作。受付の正本は main）。
export type StopControl =
  | { readonly kind: 'stop' }
  | { readonly kind: 'resume'; readonly expectedIoEpoch: string }
  | { readonly kind: 'none' };

export function stopControl(status: DesktopStatusBar | null): StopControl {
  if (status === null || status.visibility !== 'shown') return { kind: 'stop' };
  if (status.stop_scope === 'none') return { kind: 'stop' };
  if (status.stop_scope === 'local')
    return { kind: 'resume', expectedIoEpoch: status.io_epoch };
  return { kind: 'none' };
}

// 確認が必要な操作の一覧を出してよいか（ロック解除済みで、登録済みで、中枢に接続している間。WorkPanel と同じ条件）。
export function operationsShown(
  status: DesktopStatusBar | null,
  connection: DesktopConnectionView | null,
): boolean {
  return (
    status?.visibility === 'shown' &&
    connection?.visibility === 'shown' &&
    connection.registration === 'registered' &&
    connection.link === 'connected'
  );
}
