// 保存モードの切り替えの欄と、記録しない間の島の印（UI-05 の段階 6、ADR 0189。設計 01 いつも見える状態、ADR 0014・0024・
// 0181）。何を出すかは純粋な関数（state/storage-mode-state.ts）が決め、ここは描くだけ。
//
// - 切り替えの欄（StorageModeControl）: 見出し「保存モード」と、今の値の記号と文言（中枢から受け取った値）、3 つの選択肢
//   （通常・継続相談・記録しない。錠剤型の Button）。今の値の選択肢は secondary（面を塗る）で aria-pressed、ほかは outline
//   （1 画面の primary は 1 つ。ADR 0024。今の値は上の行の記号と文言でも示す）。押しても画面の表示は変えず、
//   main の状態欄の通知で変わる（正本は中枢）。今の値をもう一度押しても送らない。拒否の文言は欄のすぐ下に出す。
//   従来の窓（会話の欄）と状態の層のパネルだけが置く（島・入力バー・キャンバスには置かない。役割の表）。
// - 記録しない間の印（PrivateModeMark）: 記録しないの記号（記録の丸に斜めの線）と文言「記録しない」の札。色だけに頼らない。
//   島の小さい形に、記録しない間はいつも出す（従来の窓とキャンバス表示の両方）。面と文字は accent-soft の組（パネルの
//   8 項目の記録しないの面と同じ。ADR 0024 の表に足して測る）。
import { Button } from '@heroui/react';
import type { StorageMode } from '@buddy/contracts';
import { STORAGE_MODE_CONTROL_LABELS } from '../labels.js';
import type { StorageModeControlView } from '../state/storage-mode-state.js';
import { InlineNotice } from './InlineNotice.js';
import { PrivacyIcon } from './StatusIcons.js';
import { StatusText } from './StatusText.js';

export const STORAGE_MODE_HEADING_ID = 'storage-mode-heading';

export function PrivateModeMark() {
  return (
    <span
      data-private-mark="on"
      role="img"
      aria-label={STORAGE_MODE_CONTROL_LABELS.privateMarkName}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-accent-soft-foreground bg-accent-soft px-2 text-xs font-semibold text-accent-soft-foreground"
    >
      <PrivacyIcon mark="private_mode" className="size-3.5" />
      <span aria-hidden="true">{STORAGE_MODE_CONTROL_LABELS.privateMark}</span>
    </span>
  );
}

export function StorageModeControl({
  view,
  message,
  onChange,
  headingId = STORAGE_MODE_HEADING_ID,
}: {
  readonly view: StorageModeControlView;
  // 切り替えの拒否の文言（なければ null）。
  readonly message: string | null;
  readonly onChange: (mode: StorageMode) => void;
  // 同じ画面に 2 つ置かないので既定の ID のままでよい（試験で変える）。
  readonly headingId?: string;
}) {
  if (view.kind === 'hidden') return null;
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      data-storage-mode-control=""
      className="flex flex-col gap-2"
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span id={headingId} className="text-xs text-muted">
          {STORAGE_MODE_CONTROL_LABELS.title}
        </span>
        <StatusText line={view.line} />
      </p>
      <div className="flex flex-wrap gap-2">
        {view.options.map((option) => (
          <Button
            key={option.mode}
            size="sm"
            variant={option.selected ? 'secondary' : 'outline'}
            aria-pressed={option.selected}
            data-storage-mode={option.mode}
            onPress={() => {
              if (!option.selected) onChange(option.mode);
            }}
          >
            {option.mode === 'private' ? (
              <PrivacyIcon mark="private_mode" className="size-3.5" />
            ) : null}
            {option.label}
          </Button>
        ))}
      </div>
      {message === null ? null : <InlineNotice tone="warning" text={message} />}
    </div>
  );
}
