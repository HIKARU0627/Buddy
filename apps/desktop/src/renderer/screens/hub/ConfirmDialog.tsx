// 重い操作（申請の承認・拒否、端末の失効）の前の確認（ADR 0024・0026）。HeroUI の AlertDialog を開閉を外から決める形で使う。
// 確定のボタンを押したときだけ onConfirm を呼び、やめる・Esc・背景のクリックでは何も送らない。
import type { ReactNode } from 'react';
import { AlertDialog, Button, WarningIcon } from '@heroui/react';

export interface ConfirmRequest {
  readonly title: string;
  readonly body: ReactNode;
  readonly confirmLabel: string;
  // 失効・拒否は danger、承認は accent。
  readonly tone: 'danger' | 'accent';
  readonly onConfirm: () => void;
}

export function ConfirmDialog({
  request,
  onClose,
}: {
  readonly request: ConfirmRequest | null;
  readonly onClose: () => void;
}) {
  return (
    <AlertDialog.Backdrop
      isOpen={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialog.Container>
        <AlertDialog.Dialog>
          {request === null ? null : (
            <>
              <AlertDialog.Header>
                {/* 色の面に載せた記号はやめる。取り消せない操作（拒否・失効）だけ、題の左に ⚠ を置く（R1-L2）。 */}
                <AlertDialog.Heading className="flex items-start gap-2">
                  {request.tone === 'danger' ? (
                    <WarningIcon
                      aria-hidden="true"
                      className="mt-1 size-4 shrink-0 text-danger-soft-foreground"
                    />
                  ) : null}
                  <span>{request.title}</span>
                </AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body className="text-foreground">
                {request.body}
              </AlertDialog.Body>
              <AlertDialog.Footer>
                {/* 開いた直後のフォーカスは「やめる」（Enter ですぐに承認・失効しない）。 */}
                <Button variant="tertiary" autoFocus onPress={onClose}>
                  やめる
                </Button>
                <Button
                  variant={request.tone === 'danger' ? 'danger' : 'primary'}
                  onPress={() => {
                    request.onConfirm();
                    onClose();
                  }}
                >
                  {request.confirmLabel}
                </Button>
              </AlertDialog.Footer>
            </>
          )}
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
