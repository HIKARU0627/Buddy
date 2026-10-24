// 状態の層のパネルと端のつまみの表示の判定（UI-04、ADR 0032・0014・0024）。React と DOM に依存しない純粋な関数だけを置き、
// node:test で試験する。受付の規則（役割ごとのチャネル・停止と再開の条件）と、パネルを出す・しまうの正本は main が持つ。
// - パネルを出しているかは、main が決めた窓の幅で判断する（panelShownFor）。画面は別に状態を持たない。
// - 状態の項目（ADR 0014 の 8 項目）は、記号と決まった位置で示し、名前と値はフォーカス・ポインターで出す。
// - プライバシーと権限に関わる状態（音声を外部へ送っている・記録しないモード・安全停止中）は、つまみの専用の記号で
//   いつも見せる。値がまだない（音声は B05、記録しないモードは UI-05、安全停止は中枢が配るまで）ときは枠だけを出す。
import type {
  DesktopConnectionView,
  DesktopStatusBar,
  DesktopVoiceView,
} from '@buddy/contracts';
import { clockOf } from '../format.js';
import {
  DISPLAY_TARGET_LABELS,
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

// 項目の形（色だけに頼らない。UI-04 のレビュー P2-4）。
// - value: 値がある（実線の枠・項目の記号・状態の記号）。
// - missing: まだ受け取っていない（点線の枠・薄い記号・状態の記号なし。読み上げは「未受信」）。点線の枠の意味は
//   つまみの専用の記号と同じ「未受信」だけにする（ロック中は別の形。ItemShape は使わず、パネルが別に描く）。
// - alert: 本人が気にかけるべき状態（警告・危険）。面を塗り、状態の記号を ⚠ にする。
// - notice: 権限・プライバシーに関わるが警告ではない状態（記録しないモード）。面を塗る。
export type ItemShape = 'value' | 'missing' | 'alert' | 'notice';

export interface StatusItem {
  readonly key: StatusItemKey;
  readonly label: string;
  // 記号と値（値は名前と一緒にフォーカス・ポインターで出す。読み上げは label と value）。
  readonly line: StatusLine;
  readonly shape: ItemShape;
}

// 受け取っていない値の文言（読み上げ・ツールチップ）。画面の「—」の代わり。
export const NOT_RECEIVED_TEXT = '未受信';

// 中枢の最終確認がこれより古ければ警告の形にする（購読の生存の時間切れ 45 秒と同じ。packages/client の
// DEFAULT_ALIVE_TIMEOUT_MS。中枢は 15 秒ごとに ping を送る）。
export const STALE_CONFIRM_MS = 45_000;

const missingLine: StatusLine = {
  tone: 'neutral',
  mark: 'none',
  text: NOT_RECEIVED_TEXT,
};

function item(
  key: StatusItemKey,
  line: StatusLine | null,
  shape?: ItemShape,
): StatusItem {
  if (line === null)
    return {
      key,
      label: STATUS_ITEM_LABELS[key],
      line: missingLine,
      shape: 'missing',
    };
  // 警告・危険の色の値は、面を塗り、記号を ⚠ にする（色だけで区別しない）。
  const alert = line.tone === 'warning' || line.tone === 'danger';
  return {
    key,
    label: STATUS_ITEM_LABELS[key],
    line: alert ? { ...line, mark: 'warning' } : line,
    shape: shape ?? (alert ? 'alert' : 'value'),
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
  const confirmedMs = confirmedAt === null ? null : Date.parse(confirmedAt);
  const stale =
    confirmedMs !== null &&
    !Number.isNaN(confirmedMs) &&
    now - confirmedMs > STALE_CONFIRM_MS;
  return [
    item('io', ioLine(status)),
    item('hub', hub),
    item(
      'last_confirmed',
      confirmedAt === null
        ? null
        : stale
          ? {
              tone: 'warning',
              mark: 'warning',
              text: `${clockOf(confirmedAt, now)}（古い）`,
            }
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
            tone: 'neutral',
            mark: status.storage_mode === 'private' ? 'square' : 'dot',
            text:
              STORAGE_MODE_LABELS[status.storage_mode] ?? status.storage_mode,
          },
      // 記録しないモードは警告ではないが、権限・プライバシーに関わるので面を塗る（つまみの専用の記号と同じ）。
      status.storage_mode === 'private' ? 'notice' : undefined,
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
  // 文言のない状態は、列挙の値をそのまま出さず「不明」にする（PR #160 のレビュー P3-6）。
  const text = VOICE_STATE_LABELS[status.voice_state] ?? UNKNOWN_VOICE_TEXT;
  // 停止中は入出力の記号と同じ ■（B05-06。音声の段と同じ形）。
  return voiceSendsExternally(status.voice_state)
    ? { tone: 'warning', mark: 'warning', text }
    : status.voice_state === 'device_stopped' ||
        status.voice_state === 'global_stopped'
      ? { tone: 'neutral', mark: 'square', text }
      : { tone: 'neutral', mark: 'circle', text };
}

// 音声を外部へ送っている状態（UI-04 の読み取り・B05-06、ADR 0050 の U93）。会話中・読み上げ中（音声の通知も Live の接続を
// 開く。設計 10 §7）と、聞き取り中（文字で返す）を「外部へ送っている」とみなす。聞き取り中は設計 10 §6A の③では端末の中で
// 文字にするが、③と KWS が実際につながって確かめられるまでは、外し方を誤ったときに「送っていない」側へ倒れないよう、
// 送っている側に数える（司令塔の判断。PR #160 のレビュー）。
export function voiceSendsExternally(
  voice: NonNullable<Shown['voice_state']>,
): boolean {
  return (
    voice === 'conversation_live' ||
    voice === 'reading_aloud' ||
    voice === 'listening_text_reply'
  );
}

// 文言のない音声の状態の表示（列挙の値を画面に出さない）。
export const UNKNOWN_VOICE_TEXT = '不明';

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

// voice は main の音声の状態（desktop.voice_changed）。あれば「音声を外部へ送っている」は、その external_send（送っている
// かもしれない間を含む）で決める。なければ状態欄の音声の状態から決める（音声を使わない組み立て・受け取る前）。
export function privacyMarks(
  status: DesktopStatusBar | null,
  voice: DesktopVoiceView | null = null,
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
            voice?.visibility === 'shown'
              ? voice.external_send
                ? 'on'
                : voice.voice_state === null
                  ? 'unknown'
                  : 'off'
              : status.voice_state === null
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

// 全体の停止のショートカット（UI-04）の印。preload が渡す値（登録できたか）から決める。値がなければ印を出さない。
export type StopShortcutMark = 'registered' | 'unavailable' | null;

export function stopShortcutMark(value: unknown): StopShortcutMark {
  return value === 'registered' || value === 'unavailable' ? value : null;
}

// 停止のショートカットのキーの表し方（main の STOP_ACCELERATOR と同じ組み合わせ）。
export function stopShortcutKeys(userAgent: string): string {
  return /Mac OS X|Macintosh/u.test(userAgent) ? '⌘⌥⇧X' : 'Ctrl+Alt+Shift+X';
}

// 状態の層のパネルの音声の段（B05-06、ADR 0050）。音声の状態の記号と文言・「音声を外部へ送っている」の印・「続ける」・
// 同意の取り消し・知らせを、main の音声の状態（DesktopVoiceView）から決める。受付の規則と同意の確認は main が持つ。
export interface VoiceStripView {
  readonly kind: 'hidden' | 'shown';
  // 音声の状態の記号と文言（停止中・会話中・呼びかけ待ちなど）。
  readonly line: StatusLine;
  // 音声を外部へ送っている印（送っているかもしれない間も on）。値がなければ unknown。
  readonly external: 'on' | 'off' | 'unknown';
  // 「続ける」: 押せる・始めている途中・押せない。
  readonly continueState: 'ready' | 'starting' | 'unavailable';
  // 外部への送信の同意を取り消せる（同意している、または取り消しを保存できなかったのでやり直せる）。
  readonly revocable: boolean;
  // 状態の文言を画面に出すか（停止中は ■ だけで、文言は読み上げの名前だけ）。
  readonly showText: boolean;
  // 知らせ（入力の中断・始められなかった）。理由のコード・送り先の名前は出さない。
  readonly notice: string | null;
}

export const VOICE_NOTICE_TEXT: Readonly<
  Record<'input_interrupted' | 'not_started' | 'consent_not_saved', string>
> = {
  input_interrupted: '入力を中断しました。',
  not_started: '声の会話を始められませんでした。',
  consent_not_saved:
    '同意の取り消しを保存できませんでした。もう一度「同意を取り消す」を押してください。',
};

// 隠しているときの文言（読み上げ）。
const VOICE_HIDDEN_TEXT = '隠しています';

export function voiceStripView(voice: DesktopVoiceView | null): VoiceStripView {
  if (voice === null || voice.visibility !== 'shown')
    return {
      kind: 'hidden',
      line: { tone: 'muted', mark: 'none', text: VOICE_HIDDEN_TEXT },
      external: 'unknown',
      continueState: 'unavailable',
      revocable: false,
      showText: false,
      notice: null,
    };
  const state = voice.voice_state;
  const text =
    state === null
      ? NOT_RECEIVED_TEXT
      : (VOICE_STATE_LABELS[state] ?? UNKNOWN_VOICE_TEXT);
  const stopped = state === 'device_stopped' || state === 'global_stopped';
  // 外部へ送っている間は、段の面の色と印で示すので、文言の前に ⚠ を重ねない（見た目のレビュー）。
  // 停止中は ■（停止の ACK を待つ間に外部へ送っているかもしれなければ警告の色）。
  const external =
    voice.external_send || (state !== null && voiceSendsExternally(state));
  const line: StatusLine =
    state === null
      ? { tone: 'neutral', mark: 'none', text }
      : stopped
        ? { tone: external ? 'warning' : 'neutral', mark: 'square', text }
        : external
          ? { tone: 'warning', mark: 'none', text }
          : { tone: 'neutral', mark: 'circle', text };
  return {
    kind: 'shown',
    line,
    external: voice.external_send ? 'on' : state === null ? 'unknown' : 'off',
    continueState: voice.can_continue
      ? 'ready'
      : state === 'waiting_wake_word' && !voice.external_send
        ? 'starting'
        : 'unavailable',
    revocable:
      voice.consent === 'granted' || voice.notice === 'consent_not_saved',
    // 停止中は入出力の段と同じ「停止中」を重ねず、■ だけを出す（見た目のレビュー）。
    showText: !stopped,
    notice: voice.notice === null ? null : VOICE_NOTICE_TEXT[voice.notice],
  };
}
