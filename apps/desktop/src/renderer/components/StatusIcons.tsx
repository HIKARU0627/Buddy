// 状態の層の記号（UI-04、ADR 0032）。状態の項目（ADR 0014 の 8 項目）と、プライバシーと権限の専用の記号 3 つ。
// どれも単色の線の SVG で、色は文字色に従う（色だけで区別しない。値は記号と位置、名前はフォーカス・ポインターで出す）。
// 読み上げは呼び出し側の名前で伝える（記号そのものは読み上げない）。
import type { ReactNode } from 'react';
import type {
  PrivacyMarkKey,
  StatusItemKey,
} from '../state/status-panel-state.js';

function Svg({
  className,
  children,
}: {
  readonly className: string;
  readonly children: ReactNode;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const ITEM_PATHS: Readonly<Record<StatusItemKey, ReactNode>> = {
  // 入出力: 入る矢印と出る矢印。
  io: (
    <>
      <path d="M2 5.5h9M8.5 3l2.5 2.5L8.5 8" />
      <path d="M14 10.5H5M7.5 8 5 10.5 7.5 13" />
    </>
  ),
  // 中枢: 重ねた箱。
  hub: (
    <>
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="11" height="4.5" rx="1" />
      <path d="M5 4.75h.01M5 11.25h.01" />
    </>
  ),
  // 最終確認: 時計。
  last_confirmed: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
  // 表示先: 画面。
  display_target: (
    <>
      <rect x="2" y="3" width="12" height="8" rx="1" />
      <path d="M6 13.5h4M8 11v2.5" />
    </>
  ),
  // 音声: マイク。
  voice: (
    <>
      <rect x="6" y="2" width="4" height="7.5" rx="2" />
      <path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14" />
    </>
  ),
  // 保存モード: 書類の箱。
  storage_mode: (
    <>
      <rect x="2" y="3" width="12" height="3" rx="0.75" />
      <path d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 8.5h3" />
    </>
  ),
  // 予算の保留: 硬貨。
  budget: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.75v6.5M10 6.25c0-.8-.9-1.25-2-1.25s-2 .5-2 1.4c0 1.9 4 1 4 2.9 0 .9-.9 1.45-2 1.45s-2-.45-2-1.25" />
    </>
  ),
  // 安全停止: 盾。
  safety: (
    <>
      <path d="M8 1.75 13 3.5v4c0 3-2.2 5.3-5 6.75C5.2 12.8 3 10.5 3 7.5v-4z" />
    </>
  ),
};

export function StatusItemIcon({
  item,
  className = 'size-4',
}: {
  readonly item: StatusItemKey;
  readonly className?: string;
}) {
  return <Svg className={className}>{ITEM_PATHS[item]}</Svg>;
}

const PRIVACY_PATHS: Readonly<Record<PrivacyMarkKey, ReactNode>> = {
  // 音声を外部へ送っている: マイクと、外へ出る波。
  voice_external: (
    <>
      <rect x="3" y="2" width="4" height="7.5" rx="2" />
      <path d="M1 8a4 4 0 0 0 8 0M5 12v2" />
      <path d="M11 5.5c.8.7.8 2.3 0 3M13 4c1.6 1.4 1.6 4.6 0 6" />
    </>
  ),
  // 記録しないモード: 記録の丸に斜めの線。
  private_mode: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
      <path d="M3 13 13 3" />
    </>
  ),
  // 安全停止中: 八角形と横の線。
  safety_stop: (
    <>
      <path d="M5.5 1.75h5l3.75 3.75v5l-3.75 3.75h-5L1.75 10.5v-5z" />
      <path d="M5 8h6" />
    </>
  ),
};

export function PrivacyIcon({
  mark,
  className = 'size-4',
}: {
  readonly mark: PrivacyMarkKey;
  readonly className?: string;
}) {
  return <Svg className={className}>{PRIVACY_PATHS[mark]}</Svg>;
}
