// キャンバスの窓（UI-02 の試作、ADR 0032）。今は空の地だけ。AI が置くカード・フローティングウィンドウと下の棚は
// UI-03 以降。色は HeroUI のテーマの変数だけを使う。説明文は置かない。
// 前に出ている（キー入力を受ける）間は、画面の縁に accent の枠を出して操作できることを示し、枠の右上に
// Esc のキーの形（⎋ esc）を置いて戻し方を示す（文字の説明ではなく、キーの形と枠で伝える。PR #104 の再確認 P3）。
// ロック中・状態が不明のときは中身を描かない（今は中身がないので地だけ。UI-03 以降の部品もこの条件で隠す）。
import type { ReactNode } from 'react';
import { Kbd } from '@heroui/react';

export function CanvasGround({
  front,
  shown,
  children,
}: {
  readonly front: boolean;
  readonly shown: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <main
      aria-label="Buddy のキャンバス"
      data-front={front ? 'true' : 'false'}
      className={`relative h-screen w-screen select-none bg-background text-foreground ${
        front ? 'ring-4 ring-inset ring-accent' : ''
      }`}
    >
      {front ? (
        <Kbd aria-hidden="true" className="absolute top-3 right-3">
          <Kbd.Abbr keyValue="escape" />
          <Kbd.Content>esc</Kbd.Content>
        </Kbd>
      ) : null}
      {shown ? children : null}
    </main>
  );
}
