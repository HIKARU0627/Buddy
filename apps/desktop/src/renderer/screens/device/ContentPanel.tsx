// 内容の欄（会話・候補は B02 以降）。停止中は「この端末で再開する」まで受付・表示を再開しない旨を出す。
import { Card } from '@heroui/react';
import { PanelTitle } from '../../components/PanelTitle.js';

export function ContentPanel({
  inputPermitted,
}: {
  readonly inputPermitted: boolean;
}) {
  return (
    <section aria-label="内容">
      <Card>
        <Card.Header>
          <PanelTitle>内容</PanelTitle>
        </Card.Header>
        <Card.Content>
          {inputPermitted ? (
            <p className="text-sm">会話・候補の表示は B02 以降で追加します。</p>
          ) : (
            <p className="text-sm">
              「この端末で再開する」を押すまで、内容の受付と表示を再開しません。
            </p>
          )}
        </Card.Content>
      </Card>
    </section>
  );
}
