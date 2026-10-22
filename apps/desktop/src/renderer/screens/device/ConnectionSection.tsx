// 中枢との接続の欄（ADR 0024・0025）。接続の状態と最終確認は状態帯に出すので、ここは理由・自宅の判定を出す
// （同じ情報を 2 か所に出さない）。中枢で進んでいる操作は、会話の画面の処理状況に出す（B04-05、ADR 0031）。理由は状態の言い換えになるときは出さない。
import type { DesktopConnectionView } from '@buddy/contracts';
import type { ReactNode } from 'react';
import { Section } from '../../components/Section.js';
import { StatusText } from '../../components/StatusText.js';
import type { StatusLine } from '../../tones.js';
import { HOME_REASON_LABELS, LINK_REASON_LABELS } from '../../labels.js';

type ShownConnection = Extract<DesktopConnectionView, { visibility: 'shown' }>;

// 状態帯の行の言い換えになる理由（出さない）。
const REDUNDANT_REASONS: ReadonlySet<string> = new Set([
  'resnapshot',
  'core_stopping',
  'stream_closed',
  'unreachable',
]);

// 自宅の判定（記号と色は tones.ts の対応表。記号は StatusText が付ける）。
export function homeLine(connection: ShownConnection): StatusLine | null {
  const home = connection.home_network;
  if (home === null) return null;
  if (home.exempt)
    return {
      tone: 'neutral',
      mark: 'none',
      text: '中枢と同じマシンのため、判定は不要です',
    };
  if (home.allowed)
    return { tone: 'success', mark: 'dot', text: '自宅のネットワークです' };
  const reasons = home.reasons.map(
    (reason) => HOME_REASON_LABELS[reason] ?? reason,
  );
  return {
    tone: 'warning',
    mark: 'circle',
    text: `自宅のネットワークではありません（${reasons.join('・')}）`,
  };
}

export function ConnectionSection({
  connection,
  title = '中枢との接続',
}: {
  readonly connection: ShownConnection;
  // 欄の見出し（中枢の画面のタブでは「このマシンと中枢の接続」）。
  readonly title?: string;
}) {
  const rows: [string, ReactNode][] = [];
  const reason = connection.link_reason;
  if (
    reason !== null &&
    connection.link !== 'connected' &&
    !REDUNDANT_REASONS.has(reason)
  )
    rows.push(['理由', LINK_REASON_LABELS[reason]]);
  const home = homeLine(connection);
  if (home !== null) rows.push(['自宅の判定', <StatusText line={home} />]);
  return (
    <Section id="connection-heading" title={title}>
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
    </Section>
  );
}
