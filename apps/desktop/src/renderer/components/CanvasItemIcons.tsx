// キャンバスの物の操作の記号（UI-06、ADR 0032）。説明文の代わりに形で伝える: 閉じる（×）、棚へ片付ける（下の棚へ向かう
// 矢印）、棚から出す（棚から上へ向かう矢印）、大きさを変える（右下の角の斜線）。色は文字色に従い、読み上げはボタンの名前で伝える。
const base = {
  'aria-hidden': true,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function CloseIcon({
  className = 'size-4',
}: {
  readonly className?: string;
}) {
  return (
    <svg {...base} className={className}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

// 棚（下の横線）へ向かう矢印。
export function ShelveIcon({
  className = 'size-4',
}: {
  readonly className?: string;
}) {
  return (
    <svg {...base} className={className}>
      <path d="M8 2.5v7M5 6.5l3 3 3-3M2.5 13.5h11" />
    </svg>
  );
}

// 棚（下の横線）から上へ向かう矢印。
export function UnshelveIcon({
  className = 'size-4',
}: {
  readonly className?: string;
}) {
  return (
    <svg {...base} className={className}>
      <path d="M8 10V3M5 6l3-3 3 3M2.5 13.5h11" />
    </svg>
  );
}

export function ResizeGrip({
  className = 'size-3',
}: {
  readonly className?: string;
}) {
  return (
    <svg {...base} className={className}>
      <path d="M14 6L6 14M14 10l-4 4" />
    </svg>
  );
}
