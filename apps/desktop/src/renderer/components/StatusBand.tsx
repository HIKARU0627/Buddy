// 状態帯（設計 01 いつも見える状態、ADR 0014・0024）を、上の中央の島（ADR 0181 の段階 2）と、その下の項目の行にした。
// 従来の窓の全画面（端末の画面・登録の画面）で共通。
//
// - 島（StatusIsland）: 画面の上の中央に貼り付ける（スクロールしても上に残る）。小さい形は、この端末の入出力（ライブ領域）・
//   中枢との接続・停止（1 回で効く。確認を挟まない。U396）。確認が必要な操作が増えたときと、操作の結果が届いたときだけ、
//   下へ広がって 1 行を出す（何を出すかは純粋な関数 islandView が決める）。島から確認・承認はしない（OS の確認ダイアログの
//   入口は今までどおり「確認が必要な操作」の行）。
// - 項目の行: 中枢が正本の項目（表示先・音声・保存モード・予算保留・安全停止）を島の下に 1 行で小さく並べ、値がないものは
//   「—」にする（ADR 0014 が常に見せる項目として定めているため畳まない。U397）。
//
// 停止のボタンは、main が止まっていることを確かめた後（停止の範囲が none でない）は出さない。止まっている端末で押しても
// 何も変わらず（domain の stopLocally）、主状態の「■ 停止中」と取り違えるため（UI レビュー 2 回目 R1-M3）。
// 未受信・ロック中・ロック状態不明では、内容を出さずにその旨だけを出し、停止は押せるままにする（ADR 0014）。
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { DesktopConnectionView, DesktopStatusBar } from '@buddy/contracts';
import { Button, InfoIcon, WarningIcon } from '@heroui/react';
import { NOT_RECEIVED_NOTE } from '../labels.js';
import { ISLAND_LABELS, islandView } from '../state/island-state.js';
import type {
  IslandExpanded,
  IslandSignals,
  IslandView,
} from '../state/island-state.js';
import { detailItems } from '../state/status-lines.js';
import { StatusText } from './StatusText.js';

export const STOP_LABEL = '■ 入出力を停止';
type HoldSource = 'pointer' | 'focus';
export const IO_LINE_LABEL = ISLAND_LABELS.ioLabel;
// 「確認が必要な操作を見る」で移る先（WorkPanel の「確認が必要な操作」の見出し。画面の操作でフォーカスを受ける）。
export const ATTENTION_HEADING_ID = 'attention-heading';

export function StopButton({ onStop }: { readonly onStop: () => void }) {
  return (
    <Button variant="danger-soft" size="sm" onPress={onStop}>
      {STOP_LABEL}
    </Button>
  );
}

// 同じ画面の「確認が必要な操作」の見出しへ移る（フォーカスを移し、見える位置へ巻き取る）。
function openAttention(): void {
  const heading = document.getElementById(ATTENTION_HEADING_ID);
  if (heading === null) return;
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({ block: 'center' });
}

function ExpandedLine({ expanded }: { readonly expanded: IslandExpanded }) {
  return (
    <p
      data-island-line={expanded.reason}
      className="max-w-prose text-sm leading-6"
    >
      <StatusText line={expanded.line} />
    </p>
  );
}

export function StatusIsland({
  view,
  onStop,
  stopShortcut = null,
  onHoldChange = () => undefined,
  onOpenAttention = openAttention,
}: {
  readonly view: IslandView;
  readonly onStop: () => void;
  readonly stopShortcut?: ReactNode;
  // ポインター・キーボードのフォーカスが島に入った（true）・出た（false）。広がった島を畳まないために使う。
  readonly onHoldChange?: (source: HoldSource, holding: boolean) => void;
  readonly onOpenAttention?: () => void;
}) {
  const expanded = view.kind === 'shown' ? view.expanded : null;
  const stop = (
    <span className="flex items-center gap-2">
      {stopShortcut}
      <StopButton onStop={onStop} />
    </span>
  );
  const Icon =
    view.kind === 'hidden' && view.icon === 'warning' ? WarningIcon : InfoIcon;
  return (
    <div className="sticky top-2 z-20 flex justify-center">
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
        className="flex w-fit max-w-full flex-col rounded-island border border-border bg-surface px-5 py-2 text-foreground"
      >
        <div className="flex min-h-10 flex-wrap items-center justify-center gap-x-5 gap-y-1">
          {view.kind === 'hidden' ? (
            <>
              <p
                role="status"
                className="flex items-center gap-2 text-sm leading-6"
              >
                {view.icon === 'none' ? null : (
                  <Icon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted"
                  />
                )}
                <span>{view.text}</span>
              </p>
              {stop}
            </>
          ) : (
            <>
              <p
                role="status"
                className="flex items-center gap-2 text-base font-semibold"
              >
                <span className="text-xs font-normal text-muted">
                  {ISLAND_LABELS.ioLabel}
                </span>
                <StatusText line={view.io} />
              </p>
              <p className="flex items-center gap-2 text-sm">
                <span className="text-xs text-muted">
                  {ISLAND_LABELS.hubLabel}
                </span>
                <StatusText line={view.hub} className="tabular-nums" />
              </p>
              {view.stop ? stop : null}
            </>
          )}
        </div>
        {/* 広がる形。polite のライブ領域（status）は内容を出している間いつも置いておき、読ませる行だけを中に入れる（出した瞬間に読まれるように）。 */}
        <div
          className={
            expanded === null
              ? ''
              : 'mt-2 border-t border-separator pt-2 pb-1 motion-safe:animate-island-in'
          }
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {/* 行は縦に重ねる（空のライブ領域は高さを持たない）。ボタンは右に寄せる。 */}
            <div className="min-w-0 flex-1">
              {view.kind === 'shown' ? (
                <div role="status" data-island-live="status">
                  {expanded?.live === 'status' ? (
                    <ExpandedLine expanded={expanded} />
                  ) : null}
                </div>
              ) : null}
              {/* 失敗は alert。alert は差し込んだ時点で読まれるので、出すときだけ置く（失敗のない画面に alert を置かない）。 */}
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
              <Button variant="secondary" size="sm" onPress={onOpenAttention}>
                {ISLAND_LABELS.openAttention}
              </Button>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

export function StatusBand({
  status,
  connection,
  now,
  onStop,
  stopShortcut = null,
  island = null,
}: {
  readonly status: DesktopStatusBar | null;
  readonly connection: DesktopConnectionView | null;
  readonly now: number;
  readonly onStop: () => void;
  // 全体の停止のショートカットの印（UI-04。停止のボタンの横に置く）。
  readonly stopShortcut?: ReactNode;
  // 島を広げるきっかけ（確認が必要な操作・操作の結果。登録の画面などでは null）。
  readonly island?: IslandSignals | null;
}) {
  // 島に触れている間（ポインターかフォーカスのどちらかがある間）の始まりの時刻。触れ始めた時刻だけを覚える（島の中で
  // フォーカスが移っても延ばさない）。
  const [hold, setHold] = useState<{
    readonly pointer: boolean;
    readonly focus: boolean;
    readonly since: number | null;
  }>({ pointer: false, focus: false, since: null });
  const holdingSince = hold.since;
  const view = islandView({
    status,
    connection,
    now,
    signals: island,
    holdingSince,
  });
  const items =
    status !== null && status.visibility === 'shown' ? detailItems(status) : [];
  return (
    <>
      <StatusIsland
        view={view}
        onStop={onStop}
        stopShortcut={stopShortcut}
        onHoldChange={(source, holding) => {
          setHold((previous) => {
            const next = { ...previous, [source]: holding };
            const touching = next.pointer || next.focus;
            return {
              ...next,
              since: touching ? (previous.since ?? Date.now()) : null,
            };
          });
        }}
      />
      {items.length === 0 ? null : (
        <div className="-mt-3 flex flex-wrap items-baseline justify-center gap-x-4 gap-y-1 text-xs">
          <dl className="contents">
            {items.map((entry) => (
              <div key={entry.label} className="flex gap-1.5">
                <dt className="text-muted">{entry.label}</dt>
                <dd className={entry.missing ? 'text-muted' : ''}>
                  {entry.value}
                </dd>
              </div>
            ))}
          </dl>
          {items.some((entry) => entry.missing) ? (
            <p className="text-muted">{NOT_RECEIVED_NOTE}</p>
          ) : null}
        </div>
      )}
    </>
  );
}
