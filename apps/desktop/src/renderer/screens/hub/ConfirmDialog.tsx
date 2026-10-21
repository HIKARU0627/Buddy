// 重い操作（申請の承認・拒否、端末の失効）の前の確認（ADR 0024・0026）。HeroUI の AlertDialog を開閉を外から決める形で使う。
// 確定のボタンを押したときだけ onConfirm を呼び、やめる・Esc・背景のクリックでは何も送らない。
import type { ReactNode } from 'react';
import { AlertDialog, Button } from '@heroui/react';

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
                <AlertDialog.Icon
                  status={request.tone === 'danger' ? 'danger' : 'accent'}
                />
                <AlertDialog.Heading>{request.title}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body className="text-foreground">
                {request.body}
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="tertiary" onPress={onClose}>
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
