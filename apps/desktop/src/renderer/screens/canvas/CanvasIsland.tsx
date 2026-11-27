// キャンバス表示の上の中央の島（ADR 0181 の段階 4。本人の決定 2026-11-27）。島の窓（役割 island）いっぱいに描く。
// 窓は透明で、島（カプセル）の外は透ける（U399 の暫定 (a)）。何を出すかは段階 2 の純粋な関数 islandView が決める。
//
// - 小さい形（いつも出す）: 入出力の記号と文言（ライブ領域。状態の層のパネルからここへ移した）、状態のパネルを出すボタン
//   （中に、確認が必要な操作の数・プライバシーと権限の専用の記号 3 つ・パネルの記号。UI-04 の端のつまみの中身）、
//   停止（止まっていないときだけ。1 回で効く。確認を挟まない。U396）。未受信・ロック中・ロック状態不明では、内容を隠した旨
//   （ライブ領域）と、パネルを出すボタン（記号だけ）と停止だけにする。
// - 広がる形（本人の決定 4）: 確認が必要な操作が増えたときと、操作の結果が届いたときだけ、区切り線の下に 1 行を足す。
//   確認が必要な操作のときは「確認が必要な操作を見る」で状態のパネルを出す（確認の入口はパネルのまま。島から確認・承認は
//   しない）。行が長いときは 1 行で切る（全文は読み上げとパネルで分かる）。
// - 島の窓はキー入力を受けない（main が focusable: false で作る）。押しても前面の窓（パネル・入力バー）を外さない。
//   キーボードからは全体のショートカット（停止・パネル）で同じ操作ができる。
// - 動きを減らす設定では、広がった行を滑り込ませない（motion-safe。--motion-island も 0s）。窓の大きさは main が一度に変える。
import { useCallback, useState } from 'react';
import { Button, Chip, InfoIcon, WarningIcon } from '@heroui/react';
import { PanelIcon, PrivacyIcon } from '../../components/StatusIcons.js';
import { StatusMark, StatusText } from '../../components/StatusText.js';
import { ISLAND_LABELS } from '../../state/island-state.js';
import type { IslandExpanded, IslandView } from '../../state/island-state.js';
import type { PrivacyMark } from '../../state/status-panel-state.js';

export const CANVAS_ISLAND_LABELS = {
  openPanel: '状態のパネルを出す',
  stop: '■ 停止',
  stopName: '入出力を停止',
} as const;

const ON_CLASS: Readonly<Record<PrivacyMark['key'], string>> = {
  voice_external:
    'border-warning-soft-foreground bg-warning-soft text-warning-soft-foreground',
  private_mode:
    'border-accent-soft-foreground bg-accent-soft text-accent-soft-foreground',
  safety_stop:
    'border-danger-soft-foreground bg-danger-soft text-danger-soft-foreground',
};

// 状態ごとの形（色だけに頼らない。UI-04 のレビュー P2-3 の形を、つまみから島へそのまま移した）。
// on: 塗った面と濃い記号（実線の枠も同じ色）。off: 線だけ（実線の枠と記号）。unknown（未受信）: 点線の枠と薄い記号。
// hidden（ロック中・不明・受け取る前）: 記号を出さない灰色の面（隠していることを、未受信の点線と別の形で示す）。
const SHAPE_CLASS: Readonly<
  Record<Exclude<PrivacyMark['state'], 'on'>, string>
> = {
  off: 'border border-separator text-muted',
  unknown: 'border border-dashed border-muted text-muted',
  hidden: 'bg-default',
};

export function PrivacySlot({ mark }: { readonly mark: PrivacyMark }) {
  const base =
    'flex size-6 items-center justify-center rounded-part transition-colors';
  const shape =
    mark.state === 'on'
      ? `border ${ON_CLASS[mark.key]}`
      : SHAPE_CLASS[mark.state];
  return (
    <span
      data-privacy={mark.key}
      data-state={mark.state}
      className={`${base} ${shape}`}
    >
      {mark.state === 'hidden' ? null : (
        <PrivacyIcon
          mark={mark.key}
          className={`size-3.5 ${mark.state === 'unknown' ? 'opacity-40' : ''}`}
        />
      )}
    </span>
  );
}

type HoldSource = 'pointer' | 'focus';

// 島に触れている間（ポインターかフォーカスのどちらかがある間）の始まりの時刻。触れ始めた時刻だけを覚える
// （段階 2 の従来の窓の島と同じ。WCAG 2.2.1）。
export function useIslandHold(): readonly [
  number | null,
  (source: HoldSource, holding: boolean) => void,
] {
  const [hold, setHold] = useState<{
    readonly pointer: boolean;
    readonly focus: boolean;
    readonly since: number | null;
  }>({ pointer: false, focus: false, since: null });
  const onHoldChange = useCallback((source: HoldSource, holding: boolean) => {
    setHold((previous) => {
      const next = { ...previous, [source]: holding };
      const touching = next.pointer || next.focus;
      return {
        ...next,
        since: touching ? (previous.since ?? Date.now()) : null,
      };
    });
  }, []);
  return [hold.since, onHoldChange] as const;
}

function ExpandedLine({ expanded }: { readonly expanded: IslandExpanded }) {
  return (
    <p
      data-island-line={expanded.reason}
      className="flex min-w-0 items-center gap-1.5 text-sm leading-6"
    >
      <StatusMark line={expanded.line} />
      <span className="truncate">{expanded.line.text}</span>
    </p>
  );
}

export function CanvasIsland({
  view,
  pending,
  summaryLabel,
  privacy,
  onStop,
  onOpenPanel,
  onHoldChange = () => undefined,
}: {
  readonly view: IslandView;
  // 確認が必要な操作の数（ロック中・未登録・受け取る前は null で、数を出さない）。
  readonly pending: number | null;
  // 状態の要約の読み上げの名前（statusSummaryView の label）。
  readonly summaryLabel: string;
  readonly privacy: readonly PrivacyMark[];
  readonly onStop: () => void;
  readonly onOpenPanel: () => void;
  readonly onHoldChange?: (source: HoldSource, holding: boolean) => void;
}) {
  const expanded = view.kind === 'shown' ? view.expanded : null;
  const hidden = view.kind === 'hidden';
  const stop =
    view.kind === 'hidden' || view.stop ? (
      <Button
        variant="danger-soft"
        size="sm"
        aria-label={CANVAS_ISLAND_LABELS.stopName}
        onPress={onStop}
      >
        {CANVAS_ISLAND_LABELS.stop}
      </Button>
    ) : null;
  const Icon =
    view.kind === 'hidden' && view.icon === 'warning' ? WarningIcon : InfoIcon;
  const privacyLabel = privacy.map((mark) => mark.label).join('、');
  return (
    <div className="flex justify-center">
      <section
        aria-label={ISLAND_LABELS.region}
        data-island={expanded === null ? 'compact' : 'expanded'}
        onPointerEnter={() => onHoldChange('pointer', true)}
        onPointerLeave={() => onHoldChange('pointer', false)}
        onFocus={() => onHoldChange('focus', true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            onHoldChange('focus', false);
        }}
        className="flex w-fit max-w-full select-none flex-col rounded-island border border-border bg-surface text-foreground"
      >
        <div className="flex h-[46px] items-center justify-center gap-2 pr-1.5 pl-4">
          {hidden ? (
            <p
              role="status"
              className="flex min-w-0 items-center gap-2 text-sm leading-6"
            >
              {view.icon === 'none' ? null : (
                <Icon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted"
                />
              )}
              <span>{view.text}</span>
            </p>
          ) : (
            <p
              role="status"
              className="flex shrink-0 items-center text-sm font-semibold"
            >
              <StatusText line={view.io} />
            </p>
          )}
          <Button
            variant="ghost"
            size="sm"
            isIconOnly={hidden}
            aria-label={`${CANVAS_ISLAND_LABELS.openPanel}（${summaryLabel}。${privacyLabel}）`}
            onPress={onOpenPanel}
            className={hidden ? '' : 'gap-1.5 px-2'}
          >
            {hidden ? null : (
              <>
                {pending === null ? null : (
                  <Chip
                    aria-hidden="true"
                    size="sm"
                    variant={pending > 0 ? 'primary' : 'tertiary'}
                    color={pending > 0 ? 'warning' : 'default'}
                    className="min-w-6 justify-center tabular-nums"
                  >
                    {pending}
                  </Chip>
                )}
                <span aria-hidden="true" className="flex items-center gap-1">
                  {privacy.map((mark) => (
                    <PrivacySlot key={mark.key} mark={mark} />
                  ))}
                </span>
              </>
            )}
            <PanelIcon className="size-4 text-muted" />
          </Button>
          {stop}
        </div>
        {/* 広がる形。polite のライブ領域（status）は内容を出している間いつも置いておき、読ませる行だけを中に入れる。 */}
        <div
          className={
            expanded === null
              ? ''
              : 'flex items-center gap-3 border-t border-separator py-2 pr-2 pl-4 motion-safe:animate-island-in'
          }
        >
          <div className="min-w-0 flex-1">
            {view.kind === 'shown' ? (
              <div role="status" data-island-live="status">
                {expanded?.live === 'status' ? (
                  <ExpandedLine expanded={expanded} />
                ) : null}
              </div>
            ) : null}
            {/* 失敗は alert。差し込んだ時点で読まれるので、出すときだけ置く。 */}
            {expanded?.live === 'alert' ? (
              <div role="alert" data-island-live="alert">
                <ExpandedLine expanded={expanded} />
              </div>
            ) : null}
            {expanded !== null && expanded.live === null ? (
              <ExpandedLine expanded={expanded} />
            ) : null}
          </div>
          {expanded?.openAttention === true ? (
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0"
              onPress={onOpenPanel}
            >
              {ISLAND_LABELS.openAttention}
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
