// source_list: 出典の一覧（UI-07、ADR 0032）。題名とホスト名。リンクにするのは https の URL だけ（ユーザー名・パスワードがある URL・
// ほかのスキームは文字のまま。画面でも確かめ、main が開くときにもう一度確かめる）。リンクはアプリの中で開かず、外部の
// ブラウザーで開く（target="_blank" を main の window.open の規則が受けて https だけを OS に渡す）。外部へ出ることは、
// 四角から出る矢印の形で示す。題名・ホスト名はプレーンテキスト。キャンバスが後ろにある間は窓がフォーカスを受けないので、押せない。
import { Link } from '@heroui/react';
import type { CanvasContent } from '@buddy/contracts';
import { ExternalMark } from '../../../components/CanvasPartIcons.js';
import {
  ROW,
  httpsLink,
  rowsThatFit,
} from '../../../state/canvas-content-state.js';
import { MoreChip } from './part-kit.js';
import type { PartProps } from './part-kit.js';

type SourceContent = Extract<CanvasContent, { component: 'source_list' }>;

export function SourcePart({ item, content, box }: PartProps<SourceContent>) {
  const capacity = rowsThatFit(
    content.sources.length,
    box.height,
    ROW.source.pitch,
    ROW.source.gap,
    item.data.more_count > 0,
  );
  const sources = content.sources.slice(0, capacity);
  const hidden = content.sources.length - sources.length + item.data.more_count;
  return (
    <>
      <ul data-part="sources" className="flex flex-col gap-1">
        {sources.map((source, index) => {
          const link = httpsLink(source.url);
          return (
            <li
              key={index}
              data-linked={link === null ? 'false' : 'true'}
              className="flex min-h-11 items-center gap-2"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                {link === null ? (
                  <span className="truncate text-sm text-foreground">
                    {source.title}
                  </span>
                ) : (
                  <Link
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 truncate text-sm font-medium"
                  >
                    {source.title}
                  </Link>
                )}
                <span className="truncate text-xs text-muted">
                  {link === null ? '' : link.host}
                </span>
              </span>
              {link === null ? null : (
                <ExternalMark className="size-4 text-muted" />
              )}
            </li>
          );
        })}
      </ul>
      <MoreChip count={hidden} />
    </>
  );
}
