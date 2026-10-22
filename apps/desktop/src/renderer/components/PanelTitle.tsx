// 画面の各欄の見出し。HeroUI の Card.Title の見た目のまま、文書の構造では h2 にする（読み上げの見出しの順を保つ）。
import type { ReactNode } from 'react';
import { Card } from '@heroui/react';

export function PanelTitle({ children }: { readonly children: ReactNode }) {
  return (
    <Card.Title
      className="text-base font-semibold"
      render={(props) => <h2 {...props} />}
    >
      {children}
    </Card.Title>
  );
}
