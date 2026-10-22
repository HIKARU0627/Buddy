// 画面の共通の枠（ADR 0024）。背景・文字色・余白・幅を揃え、上に状態欄（header）、下に本体（main）を置く。
// 以後の画面もこの枠の中に置き、色は HeroUI のテーマの変数（bg-background・text-foreground など）だけを使う。
import type { ReactNode } from 'react';

export function AppShell({
  header,
  children,
}: {
  readonly header?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-5 sm:px-6">
        {header}
        <main className="flex flex-col gap-4">{children}</main>
      </div>
    </div>
  );
}
