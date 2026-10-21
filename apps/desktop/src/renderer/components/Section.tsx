// カードを使わない欄（ADR 0024 の約束: Card は状態帯と入力フォームだけ）。見出し（h2）と区切り線で分け、
// section は aria-labelledby で見出しと結ぶ。
import type { ReactNode } from 'react';

export function Section({
  id,
  title,
  action,
  children,
}: {
  readonly id: string;
  readonly title: string;
  // 見出しの右に置く小さな操作（一覧を取り直す など）。
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-4 border-t border-separator pt-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
