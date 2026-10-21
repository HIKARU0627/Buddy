// 中枢との接続の欄（ADR 0024・0025）。接続の状態と最終確認は状態帯に出すので、ここは理由・自宅の判定・
// 中枢の操作だけを出す（同じ情報を 2 か所に出さない）。理由は状態の言い換えになるときは出さない。
import type { DesktopConnectionView } from '@buddy/contracts';
import { Section } from '../../components/Section.js';
import {
  HOME_REASON_LABELS,
  LINK_REASON_LABELS,
  OPERATION_STATE_LABELS,
} from '../../labels.js';

type ShownConnection = Extract<DesktopConnectionView, { visibility: 'shown' }>;

// 状態帯の行の言い換えになる理由（出さない）。
const REDUNDANT_REASONS: ReadonlySet<string> = new Set([
  'resnapshot',
  'core_stopping',
  'stream_closed',
  'unreachable',
]);

function homeText(connection: ShownConnection): string | null {
  const home = connection.home_network;
  if (home === null) return null;
  if (home.exempt) return '中枢と同じマシンのため、判定は不要です';
  if (home.allowed) return '● 自宅のネットワークです';
  const reasons = home.reasons.map(
    (reason) => HOME_REASON_LABELS[reason] ?? reason,
  );
  return `○ 自宅のネットワークではありません（${reasons.join('・')}）`;
}

export function ConnectionSection({
  connection,
}: {
  readonly connection: ShownConnection;
}) {
  const rows: [string, string][] = [];
  const reason = connection.link_reason;
  if (
    reason !== null &&
    connection.link !== 'connected' &&
    !REDUNDANT_REASONS.has(reason)
  )
    rows.push(['理由', LINK_REASON_LABELS[reason]]);
  const home = homeText(connection);
  if (home !== null) rows.push(['自宅の判定', home]);
  return (
    <Section id="connection-heading" title="中枢との接続">
      {rows.length === 0 ? null : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm leading-6">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {connection.link !== 'connected' ? null : connection.operations.length ===
        0 ? (
        <p className="text-sm text-muted">中枢の操作はありません。</p>
      ) : (
        <ul
          aria-label="中枢の操作"
          className="flex flex-col divide-y divide-separator text-sm"
        >
          {connection.operations.map((operation) => (
            <li
              key={operation.operation_id}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-1.5"
            >
              <span className="font-medium">
                {OPERATION_STATE_LABELS[operation.state] ?? operation.state}
              </span>
              <span className="font-mono text-xs break-all text-muted">
                {operation.operation_id}
              </span>
              <span className="text-xs text-muted tabular-nums">
                版 {operation.state_revision}・内容版{' '}
                {operation.content_version}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
