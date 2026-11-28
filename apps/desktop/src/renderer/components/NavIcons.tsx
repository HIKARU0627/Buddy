// ナビゲーションとフッターの記号（ADR 0204）。16px・線の太さ 1.5・色は文字の色（currentColor）。飾りなので読み上げない
// （名前は隣の文言か、ボタンの aria-label が持つ）。
import type { ReactNode } from 'react';

function Icon({ children }: { readonly children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4 shrink-0"
    >
      {children}
    </svg>
  );
}

// 会話（吹き出し）。
export function TalkIcon() {
  return (
    <Icon>
      <path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2H7.2L4.5 13.5V11a2 2 0 0 1-2-2z" />
    </Icon>
  );
}

// 気づき（電球）。
export function InsightIcon() {
  return (
    <Icon>
      <path d="M8 1.75a4.25 4.25 0 0 0-2.4 7.76c.4.3.65.75.65 1.24h3.5c0-.49.25-.94.65-1.24A4.25 4.25 0 0 0 8 1.75z" />
      <path d="M6.5 13.25h3" />
    </Icon>
  );
}

// 自動実行（稲妻）。
export function AutoIcon() {
  return (
    <Icon>
      <path d="M8.75 1.75 3.5 9h4l-.75 5.25L12.5 7h-4z" />
    </Icon>
  );
}

// 家計簿（帳面）。
export function LedgerIcon() {
  return (
    <Icon>
      <rect x="3" y="1.75" width="10" height="12.5" rx="1.75" />
      <path d="M5.75 5h4.5M5.75 8h4.5M5.75 11h2.5" />
    </Icon>
  );
}

// 記憶（しおり）。
export function MemoryIcon() {
  return (
    <Icon>
      <path d="M4 2.25h8a.75.75 0 0 1 .75.75v10.75L8 10.75l-4.75 3V3A.75.75 0 0 1 4 2.25z" />
    </Icon>
  );
}

// 端末と接続（画面）。
export function DeviceIcon() {
  return (
    <Icon>
      <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.5" />
      <path d="M5.75 13.75h4.5M8 11v2.75" />
    </Icon>
  );
}

// ウィンドウを閉じる（下向きにしまう）。
export function HideIcon() {
  return (
    <Icon>
      <rect x="1.75" y="2.5" width="12.5" height="11" rx="1.75" />
      <path d="M5.5 10.5h5" />
    </Icon>
  );
}

// Buddy を終了（電源）。
export function QuitIcon() {
  return (
    <Icon>
      <path d="M8 1.75v5.5" />
      <path d="M4.6 4.1a5.25 5.25 0 1 0 6.8 0" />
    </Icon>
  );
}
