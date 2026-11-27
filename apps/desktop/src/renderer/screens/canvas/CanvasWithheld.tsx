// キャンバスの物を描かない理由の 1 文（UI-05 の段階 4、ADR 0188）。表示のリースを失った間、キャンバスの窓は物を描かずに、
// 上の中央の島の下へこの 1 段だけを出す。記号と文言（tones.ts の約束。色だけに頼らない）、枠は shapes.ts の共通の枠
// （角の丸みは箱の段）。地はキャンバスの地のまま（新しい色の組を作らない）。文が折り返しても記号は 1 行目にそろえる
// （InlineNotice と同じ並べ方）。取り直せたら main が記述を送り、この段は消える。
import { FRAME_CLASS } from '../../shapes.js';
import type { StatusLine } from '../../tones.js';
import { StatusMark } from '../../components/StatusText.js';

export function CanvasWithheld({ line }: { readonly line: StatusLine }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-20 flex justify-center px-4">
      <p
        role="status"
        data-canvas-withheld="true"
        className={`${FRAME_CLASS} flex max-w-prose items-start gap-1.5 bg-background px-4 py-3 text-sm leading-6 text-foreground`}
      >
        <span className="flex shrink-0">
          <StatusMark line={line} />
        </span>
        <span>{line.text}</span>
      </p>
    </div>
  );
}
