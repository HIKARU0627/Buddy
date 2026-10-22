// フッター（ADR 0024 の骨格の 5）。ウィンドウを閉じる・Buddy を終了は、軽い操作（ghost・sm）として下端に置く。
import { Button } from '@heroui/react';

export const FOOTER_LABELS = {
  hide: 'ウィンドウを閉じる',
  quit: 'Buddy を終了',
  note: '閉じてもトレイに残ります。終了しても中枢は止まりません。',
} as const;

export function AppFooter({
  onHide,
  onQuit,
}: {
  readonly onHide: () => void;
  readonly onQuit: () => void;
}) {
  return (
    <footer className="flex flex-col items-end gap-1 border-t border-separator pt-4">
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
