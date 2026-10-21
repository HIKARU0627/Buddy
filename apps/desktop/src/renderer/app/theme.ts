// ライト・ダークの切り替え（ADR 0024）。HeroUI の配色は html の class="dark" と data-theme で切り替わるため、
// OS の設定（prefers-color-scheme）を読み、変わったら追従する。style 属性・style 要素は使わない（CSP の style-src 'self'）。

export type ColorScheme = 'light' | 'dark';

// 対象の要素へ配色を反映する。HeroUI の既定のテーマは .dark と [data-theme="dark"] の両方を見る。
export function applyColorScheme(root: Element, scheme: ColorScheme): void {
  root.classList.toggle('dark', scheme === 'dark');
  root.classList.toggle('light', scheme === 'light');
  root.setAttribute('data-theme', scheme);
}

interface ColorSchemeQuery {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

// OS の配色に追従する。戻り値で追従をやめる。
export function followSystemColorScheme(
  root: Element,
  query: ColorSchemeQuery,
): () => void {
  const update = () => applyColorScheme(root, query.matches ? 'dark' : 'light');
  update();
  query.addEventListener('change', update);
  return () => query.removeEventListener('change', update);
}
