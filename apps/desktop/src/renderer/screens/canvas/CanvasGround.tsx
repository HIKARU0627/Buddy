// キャンバスの窓（UI-02 の試作、ADR 0032）。今は空の地だけ。AI が置くカード・フローティングウィンドウと下の棚は
// UI-03 以降。色は HeroUI のテーマの変数（bg-background）だけを使う。説明文は置かない。
export function CanvasGround() {
  return (
    <main
      aria-label="Buddy のキャンバス"
      className="h-screen w-screen select-none bg-background text-foreground"
    />
  );
}
