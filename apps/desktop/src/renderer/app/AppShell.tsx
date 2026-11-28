// 画面の共通の枠（ADR 0024 の骨格を、ADR 0204 でナビゲーションのある形に改めた）。
//
// ページがあるとき（登録済みの端末の画面）:
//   左: サイドバー（Buddy と画面の役割 → ページの一覧 → 閉じる・終了）
//   右: 上に状態帯（上の中央の島と項目の行）と今やること（いつも見える。スクロールしない）→ 選んだページ
//   幅が狭いとき（768px 未満）は、サイドバーを記号だけの細い列にする（名前は読み上げとツールチップの代わりの title が持つ）。
//   選んでいないページも描いたまま隠す（入力の途中の内容・開いている欄を、ページを切り替えても失わない）。
// ページがないとき（登録の画面・ロック中・画面を開けないとき）:
//   上端の帯（Buddy と画面の役割）→ 状態帯 → 今やること → 本体 → 詳細 → フッター を 1 列に並べる。
//
// 上端の帯とサイドバーの上は、窓を動かせる帯にする（枠のない窓。操作の部品は除く）。窓の操作のボタン（macOS の信号機・
// Windows の最小化などのボタン）と重ならないよう、タイトルバーの領域の環境変数（titlebar-area-*）で余白を空ける。
// 色は HeroUI のテーマの変数（bg-background・text-foreground など）だけを使う。
import type { ReactNode } from 'react';
import { Chip, Tabs } from '@heroui/react';

export interface ShellPage {
  readonly id: string;
  // サイドバーの名前（ページの読み上げの名前にもなる）。
  readonly label: string;
  readonly icon: ReactNode;
  // 名前の横の数（確認が必要な操作など）。0・null は出さない。
  readonly badge?: number | null;
  // 数の読み上げ（「確認が必要な操作 2 件」など）。
  readonly badgeLabel?: string;
  readonly content: ReactNode;
}

function Brand({ role }: { readonly role: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <h1 className="text-sm font-semibold tracking-tight">Buddy</h1>
      <p className="truncate text-xs text-muted">{role}</p>
    </div>
  );
}

const TAB_CLASS =
  'h-9 min-w-0! justify-start gap-2.5 px-3 text-left text-sm max-md:justify-center max-md:px-0';

export function AppShell({
  role,
  band,
  todo,
  children,
  details,
  footer,
  pages,
  page,
  onPageChange,
}: {
  // 画面の役割（「この端末」「中枢の画面」など）。
  readonly role: string;
  readonly band?: ReactNode;
  readonly todo?: ReactNode;
  readonly children?: ReactNode;
  readonly details?: ReactNode;
  readonly footer?: ReactNode;
  // ナビゲーションで切り替えるページ。なければ 1 列の画面。
  readonly pages?: readonly ShellPage[];
  // 選んでいるページ（渡さなければ最初のページから始め、部品が覚える）。
  readonly page?: string;
  readonly onPageChange?: (id: string) => void;
}) {
  if (pages === undefined || pages.length === 0)
    return (
      <div className="flex h-screen flex-col bg-background text-foreground antialiased">
        <div className="app-drag ps-titlebar pe-titlebar flex h-12 shrink-0 items-center">
          <Brand role={role} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-5 pt-2 pb-8 sm:px-6">
            {band}
            {todo}
            {children === undefined ? null : (
              <main className="flex flex-col gap-6">{children}</main>
            )}
            {details}
            {footer}
          </div>
        </div>
      </div>
    );
  // ページの一覧は、右の列の上の段（状態帯・今やること）の高さに引かれないよう、左の列の上の 2 段にまたがって置く。
  // 格子: 左の列がサイドバー（上から Buddy と役割・ページの一覧・閉じると終了）、右の列が状態帯と今やること・ページ。
  // Tabs は一覧とページだけを包み、格子の上では箱を持たない（contents）。Tabs の中身は、一覧を組み立てるために
  // 見えない所でもう一度描かれるので、状態帯・今やること・フッターは Tabs の外に置く（同じ物を 2 度描かない）。
  return (
    <div className="grid h-screen grid-cols-[14rem_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] bg-background text-foreground antialiased max-md:grid-cols-[3.5rem_minmax(0,1fr)]">
      <div className="app-drag ps-titlebar z-10 col-start-1 row-start-1 flex h-12 items-center self-start pe-5">
        <div className="max-md:sr-only">
          <Brand role={role} />
        </div>
      </div>
      {/* 状態帯と今やること（いつも見える。スクロールしない）。窓を動かせる帯を兼ねる。 */}
      <div className="app-drag pe-titlebar z-20 col-start-2 row-start-1 flex flex-col items-center gap-3 px-4 pt-3 pb-4">
        {band}
        {todo == null ? null : (
          <div className="app-no-drag flex w-full max-w-3xl flex-col gap-3 empty:hidden">
            {todo}
          </div>
        )}
      </div>
      <Tabs
        orientation="vertical"
        {...(page === undefined ? {} : { selectedKey: page })}
        {...(onPageChange === undefined
          ? {}
          : { onSelectionChange: (key) => onPageChange(String(key)) })}
        className="contents"
      >
        <div className="col-start-1 row-span-2 row-start-1 mt-12 min-h-0 overflow-y-auto px-2 pb-2">
          <Tabs.List aria-label="Buddy の機能" className="w-full gap-0.5 p-0">
            {pages.map((entry) => (
              <Tabs.Tab key={entry.id} id={entry.id} className={TAB_CLASS}>
                {/* 細い列では名前を出さないので、ポインターを載せたときに名前が分かるようにする（title）。 */}
                <span
                  title={entry.label}
                  className="flex h-full min-w-0 flex-1 items-center gap-2.5 max-md:justify-center"
                >
                  {entry.icon}
                  <span className="min-w-0 flex-1 truncate max-md:sr-only">
                    {entry.label}
                  </span>
                </span>
                {entry.badge == null || entry.badge === 0 ? null : (
                  <Chip
                    size="sm"
                    variant="primary"
                    color="warning"
                    aria-label={entry.badgeLabel}
                    className="min-w-6 justify-center tabular-nums max-md:absolute max-md:-top-1 max-md:-right-1"
                  >
                    {entry.badge}
                  </Chip>
                )}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </div>
        <div className="col-start-2 row-span-2 row-start-2 min-h-0 overflow-y-auto px-4">
          <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 pb-10">
            {pages.map((entry) => (
              <Tabs.Panel
                key={entry.id}
                id={entry.id}
                shouldForceMount
                className="m-0 flex flex-col gap-6 p-0 data-[inert]:hidden motion-safe:animate-page-in"
              >
                {entry.content}
              </Tabs.Panel>
            ))}
            {details}
          </main>
        </div>
      </Tabs>
      {footer === undefined ? null : (
        <div className="col-start-1 row-start-3 px-2 pt-2 pb-3">{footer}</div>
      )}
    </div>
  );
}
