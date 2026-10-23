// キャンバスの記号（4 つの四角）。キャンバスを前に出すボタン（端のつまみ・入力バー）で同じ記号を使い、
// 同じ操作だと形で伝える（UI-02、ADR 0032）。色は文字色に従う。読み上げはボタンの名前で伝える。
export function CanvasIcon({
  className = 'size-4',
}: {
  readonly className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={className}
      fill="currentColor"
    >
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1" />
    </svg>
  );
}
