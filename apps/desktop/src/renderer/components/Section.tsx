// 欄（ADR 0024・0204）。見出し（h2）と、その下の面（地より 1 段明るい面。角は箱の丸み）で 1 つのまとまりにする。
// 区切り線を並べる代わりに、面の明るさの差でまとまりを示す（ADR 0024 の「見出しと区切り線」を ADR 0204 で改めた）。
// section は aria-labelledby で見出しと結ぶ。
import type { ReactNode } from 'react';

export function Section({
  id,
  title,
  action,
  focusable = false,
  children,
}: {
  readonly id: string;
  readonly title: string;
  // 見出しの右に置く小さな操作（一覧を取り直す など）。
  readonly action?: ReactNode;
  // 画面の操作でフォーカスを移す見出し（確認を開いたとき・閉じたとき。Tab の順には入れない）。
  readonly focusable?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2 px-1">
        <h2
          id={id}
          tabIndex={focusable ? -1 : undefined}
          className="rounded-part text-sm font-semibold"
        >
          {title}
        </h2>
        {action}
      </div>
      <div className="flex flex-col gap-4 rounded-box border border-separator bg-surface p-4 sm:p-5">
        {children}
      </div>
    </section>
  );
}
