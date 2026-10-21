// 状態欄（設計 01 いつも見える状態、ADR 0015）。ロック中・ロック状態不明では内容を描画しない。
// 状態は色だけでなく、文言と記号（● ■ 🔒 ？）でも示す。
import { Card, Chip } from '@heroui/react';
import type { DesktopStatusBar } from '@buddy/contracts';
import {
  HUB_CONNECTION_LABELS,
  STOP_SCOPE_LABELS,
  UNKNOWN,
  formatObservedAt,
} from '../../labels.js';
import type { ShownStatus } from '../../state/desktop-state.js';

const optional = (value: string | null, voiceMissing = false): string =>
  value ?? (voiceMissing ? '未対応（B05 で追加）' : UNKNOWN);

const yesNo = (value: boolean | null, yes: string, no: string): string =>
  value === null ? UNKNOWN : value ? yes : no;

function StatusItems({ status }: { readonly status: ShownStatus }) {
  const items: [string, string][] = [
    ['中枢', HUB_CONNECTION_LABELS[status.hub_connection]],
    [
      '最終確認',
      status.hub_last_confirmed_at === null
        ? UNKNOWN
        : formatObservedAt(status.hub_last_confirmed_at),
    ],
    ['表示先', optional(status.display_target)],
    ['音声', optional(status.voice_state, true)],
    ['保存モード', optional(status.storage_mode)],
    ['予算保留', yesNo(status.budget_held, '保留あり', 'なし')],
    ['安全停止', yesNo(status.safety_stopped, '安全停止中', 'なし')],
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label} className="flex min-w-0 gap-3">
          <dt className="w-20 shrink-0 text-muted">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function HiddenNotice({
  lockState,
}: {
  readonly lockState: 'locked' | 'unknown';
}) {
  return (
    <Card variant="secondary" className="border border-dashed border-border">
      <Card.Content>
        <p className="text-sm">
          {lockState === 'locked'
            ? '🔒 端末がロック中のため、内容を隠しています。'
            : '？ ロック状態を確認できないため、内容を隠しています。'}
        </p>
      </Card.Content>
    </Card>
  );
}

export function StatusPanel({
  status,
}: {
  readonly status: DesktopStatusBar | null;
}) {
  if (status === null)
    return (
      <header role="status">
        <Card variant="secondary">
          <Card.Content>
            <p className="text-sm text-muted">状態を確認しています…</p>
          </Card.Content>
        </Card>
      </header>
    );
  if (status.visibility === 'hidden')
    return (
      <header role="status">
        <HiddenNotice lockState={status.lock_state} />
      </header>
    );
  return (
    <header role="status">
      <Card
        className={
          status.input_permitted
            ? 'border-l-4 border-success'
            : 'border-l-4 border-warning'
        }
      >
        <Card.Header>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span>この端末の入出力:</span>
            <Chip
              color={status.input_permitted ? 'success' : 'warning'}
              variant="soft"
            >
              <strong>{STOP_SCOPE_LABELS[status.stop_scope]}</strong>
            </Chip>
            <span className="text-muted">（世代 {status.io_epoch}）</span>
          </p>
        </Card.Header>
        <Card.Content>
          <StatusItems status={status} />
        </Card.Content>
      </Card>
    </header>
  );
}
