// 状態の層の端のつまみ（UI-02 の試作・UI-04、ADR 0032）。上から、持ち手（引き出せることを示す縦の線）・パネルを出す
// ボタン（中に、入出力の記号・確認が必要な操作の数・プライバシーと権限の専用の記号 3 つ）・キャンバスを前に出すボタン
// （入力バーと同じ 4 つの四角の記号）を縦に並べる。説明文は置かず、読み上げの名前だけを付ける（本人の判断 2026-10-22）。
// 専用の記号 3 つ（音声を外部へ送っている・記録しないモード・安全停止中）は、いつも同じ位置に出す。その状態にあれば
// 塗った面と濃い記号、ないなら線だけ、値がまだないなら点線の枠と薄い記号、ロック中で隠すなら記号のない灰色の面。
// パネルを出している間は、同じつまみがパネルの左の縁に残り、押すとしまう（ボタンの aria-expanded）。
// ロック中・不明はキャンバスのボタンを押せない（キャンバスの中身を出さない）。パネルはロック中でも出せる（停止へ届く）。
import { Button, Chip } from '@heroui/react';
import { CanvasIcon } from '../../components/CanvasIcon.js';
import { PrivacyIcon } from '../../components/StatusIcons.js';
import { StatusMark } from '../../components/StatusText.js';
import type { PrivacyMark } from '../../state/status-panel-state.js';
import type { StatusTabView } from '../../state/window-role-state.js';

const ON_CLASS: Readonly<Record<PrivacyMark['key'], string>> = {
  voice_external:
    'border-warning-soft-foreground bg-warning-soft text-warning-soft-foreground',
  private_mode:
    'border-accent-soft-foreground bg-accent-soft text-accent-soft-foreground',
  safety_stop:
    'border-danger-soft-foreground bg-danger-soft text-danger-soft-foreground',
};

// 状態ごとの形（色だけに頼らない。UI-04 のレビュー P2-3）。
// on: 塗った面と濃い記号（実線の枠も同じ色）。off: 線だけ（実線の枠と記号）。unknown（未受信）: 点線の枠と薄い記号。
// hidden（ロック中・不明・受け取る前）: 記号を出さない灰色の面（隠していることを、未受信の点線と別の形で示す）。
const SHAPE_CLASS: Readonly<
  Record<Exclude<PrivacyMark['state'], 'on'>, string>
> = {
  off: 'border border-separator text-muted',
  unknown: 'border border-dashed border-muted text-muted',
  hidden: 'bg-default',
};

function PrivacySlot({ mark }: { readonly mark: PrivacyMark }) {
  const base =
    'flex size-7 items-center justify-center rounded-md transition-colors';
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
          className={`size-4 ${mark.state === 'unknown' ? 'opacity-40' : ''}`}
        />
      )}
    </span>
  );
}

export function StatusTab({
  view,
  privacy,
  panelOpen,
  onTogglePanel,
  canSummon,
  onSummon,
  className = 'h-screen w-screen',
}: {
  readonly view: StatusTabView;
  readonly privacy: readonly PrivacyMark[];
  readonly panelOpen: boolean;
  readonly onTogglePanel: () => void;
  readonly canSummon: boolean;
  readonly onSummon: () => void;
  // 大きさ（つまみだけの窓は窓いっぱい、パネルの縁ではつまみの大きさ）。
  readonly className?: string;
}) {
  const privacyLabel = privacy.map((mark) => mark.label).join('、');
  return (
    <aside
      aria-label={view.label}
      className={`relative flex select-none flex-col items-center justify-between border-l border-separator bg-surface py-2 pl-1 text-foreground ${className}`}
    >
      <span
        aria-hidden="true"
        className="absolute top-1/2 left-1 h-8 w-1 -translate-y-1/2 rounded-full bg-separator"
      />
      <Button
        variant="ghost"
        aria-expanded={panelOpen}
        aria-label={`${panelOpen ? '状態のパネルをしまう' : '状態のパネルを出す'}（${view.label}。${privacyLabel}）`}
        onPress={onTogglePanel}
        className="flex h-auto w-11 min-w-0 flex-col items-center gap-1.5 px-0 py-1.5"
      >
        <span
          aria-hidden="true"
          className="flex size-6 items-center justify-center text-lg leading-none"
        >
          <StatusMark line={view.line} />
        </span>
        {view.pending === null ? (
          <span aria-hidden="true" className="h-6" />
        ) : (
          <Chip
            aria-hidden="true"
            size="sm"
            variant={view.pending > 0 ? 'primary' : 'tertiary'}
            color={view.pending > 0 ? 'warning' : 'default'}
            className="min-w-7 justify-center tabular-nums"
          >
            {view.pending}
          </Chip>
        )}
        <span aria-hidden="true" className="my-0.5 h-px w-6 bg-separator" />
        <span aria-hidden="true" className="flex flex-col items-center gap-1">
          {privacy.map((mark) => (
            <PrivacySlot key={mark.key} mark={mark} />
          ))}
        </span>
      </Button>
      <Button
        isIconOnly
        variant="outline"
        aria-label="キャンバスを前に出す"
        isDisabled={!canSummon}
        onPress={onSummon}
        className="size-10"
      >
        <CanvasIcon className="size-5" />
      </Button>
    </aside>
  );
}
