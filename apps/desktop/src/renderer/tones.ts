// 状態の色と記号の対応表（ADR 0024 の約束。全画面で共有する。labels.ts の文言と組で使う）。
// 状態は必ず「記号＋文言」で示し、色だけに頼らない。色絵文字は使わない（⚠ は WarningIcon の単色 SVG）。
//
// | 色の意味 | 使う場面                                           | 記号             |
// | -------- | -------------------------------------------------- | ---------------- |
// | success  | 受付中・接続中                                     | ●                |
// | warning  | 要対応（再登録・前面に出す・接続し直し待ち）       | ⚠（WarningIcon）・○ |
// | danger   | 失敗・取り消せない操作                             | ⚠（WarningIcon） |
// | neutral  | 未登録・未受信・本人が意図した停止                 | ■・—             |
// | muted    | 終わった状態（失効済み）                           | ○                |
// | 進行中   | 接続している・受け取っている・待っている           | Spinner          |

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'muted';
export type Mark = 'dot' | 'square' | 'circle' | 'warning' | 'spinner' | 'none';

// 記号の色（文字色）。soft-foreground はライト・ダークとも面に対して 4.5:1 以上（ADR 0024 の表）。
export const TONE_TEXT_CLASS: Readonly<Record<Tone, string>> = {
  success: 'text-success-soft-foreground',
  warning: 'text-warning-soft-foreground',
  danger: 'text-danger-soft-foreground',
  neutral: 'text-foreground',
  muted: 'text-muted',
};

export const MARK_TEXT: Readonly<Record<Mark, string>> = {
  dot: '●',
  square: '■',
  circle: '○',
  warning: '',
  spinner: '',
  none: '',
};

export interface StatusLine {
  readonly tone: Tone;
  readonly mark: Mark;
  readonly text: string;
}
