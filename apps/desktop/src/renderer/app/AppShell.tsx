// 画面の共通の枠（ADR 0024 の骨格）。上から次の順に並べる。
//   上端の帯（Buddy と画面の役割）→ 1. 状態帯 → 2. 今やること → 3. 本体 → 4. 詳細 → 5. フッター（閉じる・終了）
// 色は HeroUI のテーマの変数（bg-background・text-foreground など）だけを使う。
import type { ReactNode } from 'react';

export function AppShell({
  role,
  band,
  todo,
  children,
  details,
  footer,
}: {
  // 画面の役割（「この端末」「中枢の画面」など）。
  readonly role: string;
  readonly band?: ReactNode;
  readonly todo?: ReactNode;
  readonly children?: ReactNode;
  readonly details?: ReactNode;
  readonly footer?: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <div className="border-b border-separator">
        <div className="mx-auto flex w-full max-w-3xl items-baseline gap-2 px-4 py-2 sm:px-6">
          <h1 className="text-sm font-semibold">Buddy</h1>
          <p className="text-xs text-muted">{role}</p>
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5 sm:px-6">
        {band}
        {todo}
        {children === undefined ? null : (
          <main className="flex flex-col gap-6">{children}</main>
        )}
        {details}
        {footer}
      </div>
    </div>
  );
}
