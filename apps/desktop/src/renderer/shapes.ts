// 形の対応表（ADR 0181 の段階 1。全画面で共有する。色は tones.ts、形はこのファイル）。
// 角の丸みは 4 段だけを使う（値は styles.css の @theme）。画面のソースで使えるクラスは次の 4 つだけで、
// scripts/renderer-shape.test.mjs が確かめる。
//
// | 段         | クラス         | 大きさ | 使う場面                                                         |
// | ---------- | -------------- | ------ | ---------------------------------------------------------------- |
// | 小         | rounded-part   | 6px    | 箱の中の小さな面（記号の枠・予定の帯）                           |
// | 箱         | rounded-box    | 12px   | カード・枠・入力欄・状態のタイル・引用の段                       |
// | 島         | rounded-island | 28px   | 上の中央の島が広がった形・島に準じる大きな浮いた面（段階 2 以降） |
// | 完全な丸   | rounded-full   | —      | ボタン・札・円の印・細い棒（高さの決まった物だけ）               |
//
// HeroUI の部品（Card・Alert・Button・Chip・Tabs・入力欄など）の丸みは styles.css の components 層で 4 段にそろえる。
// 下の定数は、HeroUI の部品を使わずに Tailwind のクラスで描く枠・入力欄・浮いた物の縁取りを、画面ごとにばらばらに
// しないためのもの（独自のカード・ボタンの部品は作らない。ADR 0024 の約束）。札（種類・件数の印）は HeroUI の Chip を使う
// （段階 3 で独自の札のクラスをやめた）。影は使わない（浮いていることは縁取りの線で示す）。

// 一覧の行・編集の欄を囲む枠（地の上の区切り。面の色は敷かない）。
export const FRAME_CLASS = 'rounded-box border border-separator';

// 取り消せない操作（削除）の確認と、安全停止のような危険を示す欄を囲む枠。枠の色は tones.ts の danger の文字色と同じ
// （記号と文言は中に置き、枠の色だけに頼らない）。
export const FRAME_DANGER_CLASS =
  'rounded-box border border-danger-soft-foreground';

// HeroUI の入力欄を使わない入力欄（select・日付・数の欄）。境界は入力欄の境界の色（地・カードに 3:1 以上。ADR 0024）。
export const FIELD_CLASS =
  'rounded-box border border-field-border bg-transparent px-2 py-1 text-sm text-foreground';

// 浮いた物（キャンバスのフローティングウィンドウ）の縁取り（ADR 0181 の段階 3・U393）。影の代わりに、島と同じく線で示す。
// カードの境界（--border の 1px）と形で分かるよう、3:1 を測った入力欄の境界の色（--field-border。ADR 0024）の 2px にする。
export const FLOAT_OUTLINE_CLASS = 'border-2 border-field-border';
