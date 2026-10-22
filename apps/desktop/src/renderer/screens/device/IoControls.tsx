// 操作（設計 01 停止・終了、ADR 0014・0015）。この端末の入出力の停止と「この端末で再開する」、
// ウィンドウを閉じる（トレイに残る）・クライアントの終了。再開は画面のボタンだけで行い、出せるときだけ描画する。
// ボタンは HeroUI（React Aria）の Button で、キーボード（Tab で移動、Enter・Space で押す）でも操作できる。
import { Button, Card, Separator } from '@heroui/react';
import type { DeviceActions } from '../../state/desktop-state.js';

export const IO_CONTROL_LABELS = {
  stop: '■ この端末の入出力を停止',
  resume: '▶ この端末で再開する',
  hideWindow: 'ウィンドウを閉じる（トレイに残ります）',
  quit: 'クライアントを終了（中枢は止めません）',
} as const;

export function IoControls({ actions }: { readonly actions: DeviceActions }) {
  return (
    <section aria-label="操作">
      <Card>
        <Card.Content className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" onPress={actions.stop}>
              {IO_CONTROL_LABELS.stop}
            </Button>
            {actions.resume !== null ? (
              <Button variant="primary" onPress={actions.resume}>
                {IO_CONTROL_LABELS.resume}
              </Button>
            ) : null}
          </div>
          <Separator />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onPress={actions.hideWindow}>
              {IO_CONTROL_LABELS.hideWindow}
            </Button>
            <Button variant="tertiary" onPress={actions.quit}>
              {IO_CONTROL_LABELS.quit}
            </Button>
          </div>
        </Card.Content>
      </Card>
    </section>
  );
}
