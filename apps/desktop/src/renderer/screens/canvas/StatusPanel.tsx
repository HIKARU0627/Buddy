// 状態の層のパネル（UI-04、本人の決定 2026-10-22、ADR 0032・0014・0024・0031）。つまみを押すと main が状態の層の窓を
// 画面の端から広げ、この部品が窓いっぱいに描かれる。左の列にはつまみがそのまま残り（押すとしまう）、右に上から:
// 1. この端末の入出力の記号と、停止（いつでも 1 回で効く。確認を挟まない）か再開。
// 1.5. 音声の段（B05-06）: 音声の状態・「音声を外部へ送っている」の印・同意の取り消し・最小の「続ける」（VoiceStrip）。
// 2. ADR 0014 の常に見せる 8 項目。記号と決まった位置（4 × 2 の格子）で示し、名前と値はフォーカス・ポインターで出す。
//    値のない項目は点線の枠（未受信）、警告は塗りと ⚠ の形。ロック中・不明は、位置だけを灰色の面で残して値を隠す。
//    停止のボタンの横に、全体の停止のショートカットのキーの形（登録できなければ打ち消しの線と ⚠）を置く。
// 3. 確認が必要な操作の一覧と確認の欄（従来の窓の WorkPanel と同じ部品 WorkOperations）。承認・取消・再試行・照合は、
//    ボタンを押すと main が OS の確認ダイアログを 1 回だけ出す（パネルはその入口で、承認そのものではない）。
// ボタンは main が渡した操作の一覧（connection.operations）からだけ作る。キャンバスの記述・外部の内容からは作らない
// （キャンバスの記述は状態の層へ届かない。ADR 0032 の窓の役割の表）。
import { useEffect, useRef, type ReactNode } from 'react';
import { Button, Tooltip } from '@heroui/react';
import type { DesktopStatusBar } from '@buddy/contracts';
import { InlineNotice } from '../../components/InlineNotice.js';
import { StatusItemIcon } from '../../components/StatusIcons.js';
import { StatusMark, StatusText } from '../../components/StatusText.js';
import { StopShortcutMark } from '../../components/StopShortcutMark.js';
import {
  STATUS_ITEM_KEYS,
  STATUS_ITEM_LABELS,
  stopControl,
} from '../../state/status-panel-state.js';
import type {
  StatusItem,
  StopShortcutMark as StopShortcutMarkValue,
} from '../../state/status-panel-state.js';
import type { StatusLine } from '../../tones.js';

export const PANEL_LABELS = {
  region: '状態のパネル',
  stop: '■ 停止',
  stopName: 'この端末の入出力を停止',
  resume: '再開',
  resumeName: 'この端末で入出力を再開',
  hidden: '隠しています',
} as const;

// 項目の形（UI-04 のレビュー P2-4。色だけに頼らない）。
// value: 実線の枠。missing（未受信）: 点線の枠と薄い記号（つまみの専用の記号と同じ意味の点線）。
// alert: 警告・危険の色の面と枠、状態の記号は ⚠。notice: 記録しないモードなど、accent の面と枠。
const TILE_CLASS: Readonly<Record<StatusItem['shape'], string>> = {
  value: 'border border-separator',
  missing: 'border border-dashed border-muted',
  alert: 'border',
  notice:
    'border border-accent-soft-foreground bg-accent-soft text-accent-soft-foreground',
};

const ALERT_CLASS: Readonly<Record<'warning' | 'danger', string>> = {
  warning:
    'border-warning-soft-foreground bg-warning-soft text-warning-soft-foreground',
  danger:
    'border-danger-soft-foreground bg-danger-soft text-danger-soft-foreground',
};

function ItemTile({ item }: { readonly item: StatusItem }) {
  const shapeClass =
    item.shape === 'alert'
      ? `${TILE_CLASS.alert} ${ALERT_CLASS[item.line.tone === 'danger' ? 'danger' : 'warning']}`
      : TILE_CLASS[item.shape];
  const mark =
    item.shape === 'missing' ? null : item.line.mark === 'none' ? (
      <span className="text-muted">○</span>
    ) : (
      <StatusMark line={item.line} />
    );
  return (
    <Tooltip delay={250} closeDelay={0}>
      <Tooltip.Trigger
        tabIndex={0}
        role="img"
        aria-label={`${item.label}: ${item.line.text}`}
        data-item={item.key}
        data-shape={item.shape}
        className={`flex h-14 flex-col items-center justify-center gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent ${shapeClass}`}
      >
        <StatusItemIcon
          item={item.key}
          className={`size-5 ${
            item.shape === 'value'
              ? 'text-muted'
              : item.shape === 'missing'
                ? 'text-muted opacity-40'
                : ''
          }`}
        />
        <span aria-hidden="true" className="flex h-4 items-center text-sm">
          {mark}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Content placement="bottom">
        <span className="text-xs">
          <span className="text-muted">{item.label}</span> {item.line.text}
        </span>
      </Tooltip.Content>
    </Tooltip>
  );
}

// ロック中・不明・受け取る前: 位置だけを残し、値を出さない。未受信の点線とは別の形（記号のない灰色の面。つまみの
// 専用の記号の「隠す」と同じ形）。
function HiddenTile({ itemKey }: { readonly itemKey: StatusItem['key'] }) {
  return (
    <span
      role="img"
      aria-label={`${STATUS_ITEM_LABELS[itemKey]}: ${PANEL_LABELS.hidden}`}
      data-item={itemKey}
      data-shape="hidden"
      className="flex h-14 rounded-md bg-default"
    />
  );
}

export function StatusPanel({
  tab,
  status,
  ioLine,
  items,
  message,
  onStop,
  onResume,
  stopShortcut = null,
  stopKeys = '',
  operations,
  voice = null,
}: {
  // 左の列に残すつまみ（StatusTab）。
  readonly tab: ReactNode;
  readonly status: DesktopStatusBar | null;
  // 先頭の入出力の記号と文言（ロック中・不明なら「ロック中」）。
  readonly ioLine: StatusLine;
  // ADR 0014 の 8 項目（ロック中・不明・受け取る前は null）。
  readonly items: readonly StatusItem[] | null;
  // 停止・再開の拒否の文言（なければ null）。
  readonly message: string | null;
  readonly onStop: () => void;
  readonly onResume: (expectedIoEpoch: string) => void;
  // 全体の停止のショートカットの印（登録できたか。null なら出さない）と、そのキー。
  readonly stopShortcut?: StopShortcutMarkValue;
  readonly stopKeys?: string;
  // 確認が必要な操作の一覧と確認の欄（出せないときは null）。
  readonly operations: ReactNode;
  // 音声の段（B05-06。音声を使わない組み立て・従来の試験では null）。
  readonly voice?: ReactNode;
}) {
  const control = stopControl(status);
  const regionRef = useRef<HTMLElement>(null);
  // 出したら、パネルへフォーカスを移す（停止のボタンには移さない。Enter の押し間違いで止めない）。
  useEffect(() => {
    regionRef.current?.focus();
  }, []);
  return (
    <div className="flex h-screen w-screen bg-surface text-foreground">
      <div className="flex w-14 shrink-0 items-center border-r border-separator">
        {tab}
      </div>
      <section
        ref={regionRef}
        tabIndex={-1}
        aria-label={PANEL_LABELS.region}
        className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4 outline-none motion-safe:animate-[status-panel-in_180ms_ease-out]"
      >
        <div className="flex items-center justify-between gap-3">
          <p role="status" className="text-base font-semibold">
            <StatusText line={ioLine} />
          </p>
          {control.kind === 'stop' ? (
            <span className="flex items-center gap-2">
              <StopShortcutMark mark={stopShortcut} keys={stopKeys} />
              <Button
                variant="danger"
                size="sm"
                aria-label={PANEL_LABELS.stopName}
                onPress={onStop}
              >
                {PANEL_LABELS.stop}
              </Button>
            </span>
          ) : control.kind === 'resume' ? (
            <Button
              variant="primary"
              size="sm"
              aria-label={PANEL_LABELS.resumeName}
              onPress={() => onResume(control.expectedIoEpoch)}
            >
              {PANEL_LABELS.resume}
            </Button>
          ) : null}
        </div>
        {message === null ? null : (
          <InlineNotice tone="warning" text={message} />
        )}
        {voice}
        <div className="grid grid-cols-4 gap-2">
          {items === null
            ? STATUS_ITEM_KEYS.map((key) => (
                <HiddenTile key={key} itemKey={key} />
              ))
            : items.map((entry) => <ItemTile key={entry.key} item={entry} />)}
        </div>
        {operations}
      </section>
    </div>
  );
}
