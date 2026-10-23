// キャンバスの部品の記号（UI-07、ADR 0032）。説明文の代わりに形で伝える: 用事の状態（未了は線の円、済みは塗った円とチェック、
// 気づきは三角と！）、出典の外部リンク（四角から出る矢印）、グラフの系列の印（丸・四角・三角）。色は状態の色（tones.ts）と
// 文字色に従い、色だけで区別しない（形が違う）。読み上げは呼び出し側が role="img" と名前で伝える。
import { TONE_TEXT_CLASS } from '../tones.js';
import type { Tone } from '../tones.js';

const base = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export type ListState = 'open' | 'done' | 'attention';

// 用事の状態の名前（読み上げ）と色。形が違うので、色が見えなくても分かる。
export const LIST_STATE: Readonly<
  Record<ListState, { readonly label: string; readonly tone: Tone }>
> = {
  open: { label: '未了', tone: 'neutral' },
  done: { label: '済み', tone: 'success' },
  attention: { label: '気づき', tone: 'warning' },
};

export function StateMark({
  state,
  className = 'size-5',
}: {
  readonly state: ListState;
  readonly className?: string;
}) {
  const { label, tone } = LIST_STATE[state];
  const color = `${TONE_TEXT_CLASS[tone]} ${className} shrink-0`;
  if (state === 'done')
    return (
      <svg
        {...base}
        role="img"
        aria-label={label}
        data-mark="done"
        className={color}
      >
        <circle cx="8" cy="8" r="6.2" fill="currentColor" stroke="none" />
        <path
          d="M5.2 8.2l2 2 3.6-4"
          strokeWidth={1.8}
          className="stroke-surface"
        />
      </svg>
    );
  if (state === 'attention')
    return (
      <svg
        {...base}
        role="img"
        aria-label={label}
        data-mark="attention"
        className={color}
      >
        <path d="M8 2.2L14.2 13H1.8L8 2.2z" />
        <path d="M8 6.6v3M8 11.4v.2" />
      </svg>
    );
  return (
    <svg
      {...base}
      role="img"
      aria-label={label}
      data-mark="open"
      className={color}
    >
      <circle cx="8" cy="8" r="5.6" />
    </svg>
  );
}

// 済みの印（進み具合が終わった）。
export function CheckMark({
  className = 'size-4',
}: {
  readonly className?: string;
}) {
  return (
    <svg
      {...base}
      aria-hidden="true"
      data-mark="check"
      className={`${TONE_TEXT_CLASS.success} ${className} shrink-0`}
    >
      <path d="M3 8.4l3.2 3.2L13 4.6" />
    </svg>
  );
}

// 外部のブラウザーで開くリンクの印（四角から出る矢印）。
export function ExternalMark({
  className = 'size-4',
}: {
  readonly className?: string;
}) {
  return (
    <svg
      {...base}
      aria-hidden="true"
      data-mark="external"
      className={`${className} shrink-0`}
    >
      <path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M12 9.5v3.2a.8.8 0 01-.8.8H3.3a.8.8 0 01-.8-.8V4.8a.8.8 0 01.8-.8h3.2" />
    </svg>
  );
}

// グラフの系列の印。折れ線の点の形（丸・四角・三角）と、凡例で同じ形を使う。
export type SeriesShape = 'circle' | 'square' | 'triangle';

export function SeriesMark({
  shape,
  cx,
  cy,
  r = 4,
  className = '',
}: {
  readonly shape: SeriesShape;
  readonly cx: number;
  readonly cy: number;
  readonly r?: number;
  readonly className?: string;
}) {
  if (shape === 'square')
    return (
      <rect
        x={cx - r}
        y={cy - r}
        width={2 * r}
        height={2 * r}
        data-shape="square"
        className={className}
      />
    );
  if (shape === 'triangle')
    return (
      <path
        d={`M${cx} ${cy - r - 0.5}L${cx + r + 0.5} ${cy + r}H${cx - r - 0.5}z`}
        data-shape="triangle"
        className={className}
      />
    );
  return (
    <circle cx={cx} cy={cy} r={r} data-shape="circle" className={className} />
  );
}
