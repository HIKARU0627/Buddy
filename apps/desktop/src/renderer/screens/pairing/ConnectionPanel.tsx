// 中枢との接続の欄（設計 01 いつも見える状態、07 §2〜§4、ADR 0024・0025）。登録・接続の状態・最終確認時刻・
// 接続し直す時刻・切断の理由・自宅のネットワークの判定（理由のコードだけ）と、中枢の操作の ID・版・状態を出す。
// 状態は色だけでなく文言と記号でも示す。状態は引数で受け取り、限定 API を直接呼ばない。
import { Card, Chip } from '@heroui/react';
import { PanelTitle } from '../../components/PanelTitle.js';
import {
  LINK_LABELS,
  LINK_REASON_LABELS,
  OPERATION_STATE_LABELS,
  REGISTRATION_LABELS,
  UNKNOWN,
  formatObservedAt,
} from '../../labels.js';
import type { ShownConnection } from '../../state/connection-state.js';

export function ConnectionPanel({
  connection,
}: {
  readonly connection: ShownConnection;
}) {
  const items: [string, string][] = [
    ['登録', REGISTRATION_LABELS[connection.registration]],
    ['接続', LINK_LABELS[connection.link]],
    [
      '最終確認',
      connection.last_confirmed_at === null
        ? UNKNOWN
        : formatObservedAt(connection.last_confirmed_at),
    ],
  ];
  if (connection.link_reason !== null)
    items.push(['理由', LINK_REASON_LABELS[connection.link_reason]]);
  if (connection.retry_at !== null)
    items.push(['次の接続', formatObservedAt(connection.retry_at)]);
  if (connection.home_network !== null)
    items.push([
      '自宅の判定',
      connection.home_network.exempt
        ? '中枢と同じマシン（判定を免除）'
        : connection.home_network.allowed
          ? '● 自宅のネットワーク'
          : `○ 自宅のネットワークではありません（${connection.home_network.reasons.join('・')}）`,
    ]);
  return (
    <section aria-label="中枢との接続">
      <Card>
        <Card.Header>
          <PanelTitle>中枢との接続</PanelTitle>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3">
          <dl className="grid grid-cols-1 gap-y-2 text-sm">
            {items.map(([label, value]) => (
              <div key={label} className="flex min-w-0 gap-3">
                <dt className="w-20 shrink-0 text-muted">{label}</dt>
                <dd className="min-w-0 break-words">{value}</dd>
              </div>
            ))}
          </dl>
          {connection.link === 'connected' ? (
            connection.operations.length === 0 ? (
              <p className="text-sm text-muted">中枢の操作はありません。</p>
            ) : (
              <ul
                aria-label="中枢の操作"
                className="flex flex-col gap-2 text-sm"
              >
                {connection.operations.map((operation) => (
                  <li
                    key={operation.operation_id}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <Chip variant="soft">
                      {OPERATION_STATE_LABELS[operation.state] ??
                        operation.state}
                    </Chip>
                    <span className="font-mono break-all">
                      {operation.operation_id}
                    </span>
                    <span className="text-muted">
                      版 {operation.state_revision}・内容版{' '}
                      {operation.content_version}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </Card.Content>
      </Card>
    </section>
  );
}
