// 閉じる・終了（ADR 0024 の骨格の 5、ADR 0204）。ウィンドウを閉じる・Buddy を終了は、軽い操作（ghost・sm）として置く。
// ナビゲーションのある画面ではサイドバーの下（縦に並べる。細い列では記号だけ）、1 列の画面では下端（横に並べる）。
import { Button } from '@heroui/react';
import { HideIcon, QuitIcon } from './NavIcons.js';

export const FOOTER_LABELS = {
  hide: 'ウィンドウを閉じる',
  quit: 'Buddy を終了',
  note: '閉じてもトレイに残ります。終了しても中枢は止まりません。',
} as const;

export function AppFooter({
  onHide,
  onQuit,
  layout = 'bottom',
}: {
  readonly onHide: () => void;
  readonly onQuit: () => void;
  readonly layout?: 'side' | 'bottom';
}) {
  if (layout === 'side')
    return (
      <footer className="flex flex-col gap-0.5">
        <Button
          variant="ghost"
          size="sm"
          onPress={onHide}
          aria-label={FOOTER_LABELS.hide}
          className="h-8 w-full justify-start gap-2.5 px-3 max-md:justify-center max-md:px-0"
        >
          <HideIcon />
          <span className="max-md:sr-only">{FOOTER_LABELS.hide}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onPress={onQuit}
          aria-label={FOOTER_LABELS.quit}
          className="h-8 w-full justify-start gap-2.5 px-3 max-md:justify-center max-md:px-0"
        >
          <QuitIcon />
          <span className="max-md:sr-only">{FOOTER_LABELS.quit}</span>
        </Button>
        <p className="px-3 pt-1.5 text-xs leading-4 text-muted max-md:sr-only">
          {FOOTER_LABELS.note}
        </p>
      </footer>
    );
  return (
    <footer className="flex flex-col items-end gap-1 pt-2">
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onPress={onHide}>
          {FOOTER_LABELS.hide}
        </Button>
        <Button variant="ghost" size="sm" onPress={onQuit}>
          {FOOTER_LABELS.quit}
        </Button>
      </div>
      <p className="text-xs text-muted">{FOOTER_LABELS.note}</p>
    </footer>
  );
}
