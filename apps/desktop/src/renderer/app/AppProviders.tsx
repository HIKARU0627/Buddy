// 画面全体の共通の Provider（ADR 0024）。HeroUI v3 は Provider を要求しないため、ここには React Aria の言語設定だけを置く。
// 以後の画面で共通の Provider（トースト・ルーターなど）が要るときは、画面ごとではなくここへ足す。
import type { ReactNode } from 'react';
import { I18nProvider } from 'react-aria-components';

// 部品が内部で出す読み上げの文言・日付の書式を日本語にする（html の lang="ja" と揃える）。
export const APP_LOCALE = 'ja-JP';

export function AppProviders({ children }: { readonly children: ReactNode }) {
  return <I18nProvider locale={APP_LOCALE}>{children}</I18nProvider>;
}
