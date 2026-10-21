// UI レンダラーの画面（設計 01 いつも見える状態・停止・終了、ADR 0014・0015）。
// 状態欄・この端末の入出力の停止と「この端末で再開する」・ウィンドウを閉じる・クライアントの終了・電源とロックの記録を出す。
// ロック中・ロック状態不明では状態欄の内容と記録を描画しない。再開は画面のボタンだけで行う。
import { useCallback, useEffect, useState } from 'react';
import type {
  DesktopIpcNotification,
  DesktopIpcResponse,
  DesktopStatusBar,
} from '@buddy/contracts';
import { desktopApi, request } from './desktop-api.js';
import {
  HUB_CONNECTION_LABELS,
  POWER_EVENT_LABELS,
  POWER_SOURCE_LABELS,
  REJECT_MESSAGES,
  STOP_SCOPE_LABELS,
  UNKNOWN,
  formatObservedAt,
} from './labels.js';

type PowerEvent = Extract<
  DesktopIpcNotification,
  { channel: 'desktop.power_event' }
>;
type Shown = Extract<DesktopStatusBar, { visibility: 'shown' }>;

const POWER_LOG_LIMIT = 50;

const optional = (value: string | null, voiceMissing = false): string =>
  value ?? (voiceMissing ? '未対応（B05 で追加）' : UNKNOWN);

const yesNo = (value: boolean | null, yes: string, no: string): string =>
  value === null ? UNKNOWN : value ? yes : no;

function StatusItems({ status }: { status: Shown }) {
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
    <dl className="status-items">
      {items.map(([label, value]) => (
        <div key={label} className="status-item">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function StatusBar({ status }: { status: DesktopStatusBar | null }) {
  if (status === null)
    return (
      <header className="status-bar" role="status">
        <p>状態を確認しています…</p>
      </header>
    );
  if (status.visibility === 'hidden')
    return (
      <header className="status-bar status-hidden" role="status">
        <p>
          {status.lock_state === 'locked'
            ? '🔒 端末がロック中のため、内容を隠しています。'
            : '？ ロック状態を確認できないため、内容を隠しています。'}
        </p>
      </header>
    );
  return (
    <header
      className={`status-bar ${status.input_permitted ? 'status-open' : 'status-stopped'}`}
      role="status"
    >
      <p className="io-state">
        この端末の入出力:{' '}
        <strong>{STOP_SCOPE_LABELS[status.stop_scope]}</strong>
        <span className="epoch">（世代 {status.io_epoch}）</span>
      </p>
      <StatusItems status={status} />
    </header>
  );
}

export function App() {
  const api = desktopApi();
  const [status, setStatus] = useState<DesktopStatusBar | null>(null);
  const [powerLog, setPowerLog] = useState<PowerEvent[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const handleResponse = useCallback((response: DesktopIpcResponse) => {
    if (response.outcome === 'rejected') {
      setMessage(REJECT_MESSAGES[response.reason]);
      return;
    }
    setMessage(null);
    if ('status' in response) setStatus(response.status);
  }, []);

  const send = useCallback(
    (built: Parameters<NonNullable<typeof api>['invoke']>[0]) => {
      if (!api) return;
      api
        .invoke(built)
        .then(handleResponse)
        .catch(() => setMessage('main と通信できませんでした。'));
    },
    [api, handleResponse],
  );

  useEffect(() => {
    if (!api) return undefined;
    const unsubscribe = api.onNotification((notification) => {
      if (notification.channel === 'desktop.state_changed')
        setStatus(notification.status);
      else if (notification.channel === 'desktop.power_event')
        setPowerLog((log) => [notification, ...log].slice(0, POWER_LOG_LIMIT));
    });
    send(request('desktop.get_state', null));
    return unsubscribe;
  }, [api, send]);

  if (!api)
    return (
      <main className="app">
        <p role="alert">限定 API を読み込めませんでした。</p>
      </main>
    );

  const shown = status?.visibility === 'shown' ? status : null;
  const canResume = shown !== null && shown.stop_scope === 'local';

  return (
    <div className="app">
      <StatusBar status={status} />
      <main>
        <section className="controls" aria-label="操作">
          <button
            type="button"
            className="danger"
            onClick={() => send(request('desktop.io_stop', null))}
          >
            ■ この端末の入出力を停止
          </button>
          {canResume ? (
            <button
              type="button"
              className="primary"
              onClick={() =>
                send(
                  request('desktop.io_resume', {
                    expected_io_epoch: shown.io_epoch,
                  }),
                )
              }
            >
              ▶ この端末で再開する
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => send(request('desktop.window_hide', null))}
          >
            ウィンドウを閉じる（トレイに残ります）
          </button>
          <button
            type="button"
            onClick={() => send(request('desktop.client_quit', null))}
          >
            クライアントを終了（中枢は止めません）
          </button>
        </section>
        {message !== null ? (
          <p className="message" role="alert">
            ⚠ {message}
          </p>
        ) : null}
        {shown === null ? null : (
          <>
            <section className="content" aria-label="内容">
              <h2>内容</h2>
              {shown.input_permitted ? (
                <p>会話・候補の表示は B02 以降で追加します。</p>
              ) : (
                <p>
                  「この端末で再開する」を押すまで、内容の受付と表示を再開しません。
                </p>
              )}
            </section>
            <section className="power-log" aria-label="電源とロックの記録">
              <h2>電源とロックの記録</h2>
              {powerLog.length === 0 ? (
                <p>記録はまだありません。</p>
              ) : (
                <ol>
                  {powerLog.map((entry, index) => (
                    <li key={`${entry.observed_at}-${index}`}>
                      <time dateTime={entry.observed_at}>
                        {formatObservedAt(entry.observed_at)}
                      </time>
                      <span>{POWER_EVENT_LABELS[entry.event]}</span>
                      <span className="source">
                        {POWER_SOURCE_LABELS[entry.source]}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
