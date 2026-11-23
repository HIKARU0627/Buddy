// 連携アカウントの欄（ConnectionsPanel。B08-02 P3・B09-05、ADR 0142・0145）の試験。サーバー描画（react-dom/server）で、
// 取得の状態、提供元・状態・権限、取得対象（ID のまま）と範囲、Microsoft のアカウント種別・拒否の理由・カテゴリの扱い、
// 未取得を「連携なし」と言わないこと、理由のコード・接続 ID・版を出さないことを確かめる。期待値は手で書く。
// 実際の見た目・クリックは Electron の画面で確かめる（未実施）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DesktopConnectionEntry,
  DesktopProviderConnectionsView,
} from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import { INITIAL_CONNECTIONS_STATE } from '../../state/connections-state.js';
import type {
  ConnectionActions,
  ConnectionsViewState,
} from '../../state/connections-state.js';
import { ConnectionsPanel } from './ConnectionsPanel.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const ACTIONS: ConnectionActions = {
  refresh: () => undefined,
  update: () => undefined,
  discover: () => undefined,
};

const googleEntry = (
  overrides: Partial<DesktopConnectionEntry> = {},
): DesktopConnectionEntry => ({
  ref: id(1),
  provider: 'google',
  status: 'active',
  access: 'read',
  granted_scopes: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.readonly',
  ],
  targets: {
    calendar_ids: ['primary'],
    mail_container_ids: ['INBOX'],
    attachment_kinds: ['pdf', 'text'],
    mail_lookback_days: 90,
    calendar_past_days: 30,
    calendar_future_days: 90,
    attachment_max_bytes: 10000000,
  },
  graph_account: null,
  discovery: null,
  delivery_unknown: false,
  ...overrides,
});

const microsoftEntry = (
  overrides: Partial<DesktopConnectionEntry> = {},
): DesktopConnectionEntry => ({
  ref: id(2),
  provider: 'microsoft',
  status: 'needs_attention',
  access: 'read',
  granted_scopes: ['Mail.Read'],
  targets: {
    calendar_ids: [],
    mail_container_ids: ['inbox'],
    attachment_kinds: ['pdf'],
    mail_lookback_days: 30,
    calendar_past_days: 0,
    calendar_future_days: 90,
    attachment_max_bytes: 5000000,
  },
  graph_account: {
    account_kind: 'work_or_school',
    delegation: 'delegated_user',
    rejection_reason: 'admin_consent_required',
    category_updates: 'display_only',
  },
  discovery: null,
  delivery_unknown: false,
  ...overrides,
});

const view = (
  entries: DesktopConnectionEntry[],
  overrides: Partial<DesktopProviderConnectionsView> = {},
): DesktopProviderConnectionsView => ({
  fetch: 'loaded',
  entries,
  list_seq: 2,
  ...overrides,
});

const render = (node: ReactNode) =>
  renderToStaticMarkup(<AppProviders>{node}</AppProviders>);

const panel = (state: Partial<ConnectionsViewState>) =>
  render(
    <ConnectionsPanel
      state={{ ...INITIAL_CONNECTIONS_STATE, ...state }}
      actions={ACTIONS}
    />,
  );

// 文字だけ（タグを除く）。
const text = (html: string) => html.replace(/<[^>]+>/gu, ' ');

test('nothing read yet says so and never says there are no connections', () => {
  const html = text(panel({}));
  assert.match(html, /連携アカウント/u);
  assert.match(html, /まだ取得できていません/u);
  assert.doesNotMatch(html, /連携しているアカウントはまだありません/u);
});

test('a loaded empty list says there are no connections yet', () => {
  const html = text(panel({ view: view([]) }));
  assert.match(html, /連携しているアカウントはまだありません/u);
});

test('a google connection shows provider, scopes and the saved targets by id', () => {
  const html = text(panel({ view: view([googleEntry()]) }));
  assert.match(html, /Google/u);
  assert.match(html, /連携中/u);
  assert.match(html, /参照だけ/u);
  assert.match(html, /gmail\.readonly/u);
  assert.match(html, /取得する対象と範囲/u);
  assert.match(html, /カレンダー/u);
  assert.match(html, /primary/u);
  assert.match(html, /ラベル/u);
  assert.match(html, /INBOX/u);
  assert.match(html, /PDF/u);
  assert.match(html, /テキスト（txt・md・csv）/u);
  assert.match(html, /メールを遡る日数（上限 90\u00a0日）/u);
  assert.match(html, /選べる対象を読み込む/u);
  assert.match(html, /保存する/u);
  // 接続 ID・版・理由のコードは出さない。
  assert.doesNotMatch(html, /permission_revision/u);
  assert.doesNotMatch(html, /connection_id/u);
});

test('a microsoft connection shows the account kind, the rejection and the category handling', () => {
  const html = text(panel({ view: view([microsoftEntry()]) }));
  assert.match(html, /Outlook（Microsoft）/u);
  assert.match(html, /確認が必要です/u);
  assert.match(html, /職場・学校アカウント/u);
  assert.match(html, /本人の委任された権限で連携しています/u);
  assert.match(html, /組織の管理者の同意が必要です/u);
  assert.doesNotMatch(html, /admin_consent_required/u);
  assert.match(html, /カテゴリは案の表示だけです/u);
  assert.match(html, /フォルダー/u);
  assert.match(html, /inbox/u);
  // 選んでいるカレンダーが無いことも示す。
  assert.match(html, /選んでいるカレンダーはありません/u);
});

test('an unknown outcome is shown on the row and the save button is disabled', () => {
  const html = panel({
    view: view([googleEntry({ delivery_unknown: true })]),
  });
  assert.match(text(html), /結果を確認できませんでした/u);
  assert.match(html, /disabled/u);
});

test('a row notice is shown under its connection', () => {
  const html = text(
    panel({
      view: view([googleEntry()]),
      notice: { tone: 'success', text: '保存しました。', ref: id(1) },
    }),
  );
  assert.match(html, /保存しました/u);
});

test('a stale view keeps the entries and says the latest read failed', () => {
  const html = text(panel({ view: view([googleEntry()], { fetch: 'stale' }) }));
  assert.match(html, /最新の取得に失敗しました/u);
  assert.match(html, /Google/u);
});

// --- 選べる対象（ADR 0145） ---

test('discovered targets show display names, the primary mark, unchosen options and a saved id not found', () => {
  const html = text(
    panel({
      view: view([
        googleEntry({
          targets: {
            calendar_ids: ['gone@example.invalid'],
            mail_container_ids: ['INBOX'],
            attachment_kinds: ['pdf'],
            mail_lookback_days: 90,
            calendar_past_days: 30,
            calendar_future_days: 90,
            attachment_max_bytes: 10000000,
          },
          discovery: {
            calendars: {
              status: 'loaded',
              options: [
                {
                  id: 'primary-cal@example.invalid',
                  display_name: '合成のメイン',
                  kind: 'calendar',
                  primary: true,
                },
              ],
            },
            mail_containers: {
              status: 'loaded',
              options: [
                {
                  id: 'INBOX',
                  display_name: 'INBOX',
                  kind: 'mail_label',
                  primary: false,
                },
                {
                  id: 'Label_1',
                  display_name: '合成のラベル',
                  kind: 'mail_label',
                  primary: false,
                },
              ],
            },
            categories: { status: 'not_supported', categories: [] },
          },
        }),
      ]),
    }),
  );
  assert.match(html, /合成のメイン（メイン）/u);
  assert.match(html, /gone@example\.invalid/u);
  assert.match(html, /連携先で見つかりません/u);
  assert.match(html, /受信トレイ/u);
  assert.match(html, /合成のラベル/u);
  assert.match(html, /選べる対象を読み直す/u);
  // Google にはカテゴリの欄を出さない。
  assert.doesNotMatch(html, /既存のカテゴリ/u);
});

test('a microsoft discovery shows the categories, and a refused list says so without codes', () => {
  const html = text(
    panel({
      view: view([
        microsoftEntry({
          status: 'active',
          graph_account: {
            account_kind: 'personal',
            delegation: 'delegated_user',
            rejection_reason: null,
            category_updates: 'display_only',
          },
          discovery: {
            calendars: { status: 'not_supported', options: [] },
            mail_containers: { status: 'rejected', options: [] },
            categories: {
              status: 'loaded',
              categories: [
                {
                  category_id: 'cat-1',
                  display_name: '合成の赤',
                  color: 'preset0',
                },
              ],
            },
          },
        }),
      ]),
    }),
  );
  assert.match(html, /既存のカテゴリ（表示だけ）/u);
  assert.match(html, /合成の赤/u);
  assert.doesNotMatch(html, /preset0/u);
  assert.match(html, /一覧の読み取りを許可していない/u);
  assert.doesNotMatch(html, /rejected/u);
  // 保存済みの inbox は ID のまま出す（一覧が読めていないので「見つからない」とは言わない）。
  assert.match(html, /inbox/u);
  assert.doesNotMatch(html, /連携先で見つかりません/u);
});

test('the discover button is disabled for a connection that is not active and while reading', () => {
  const inactive = panel({ view: view([microsoftEntry()]) });
  assert.match(inactive, /選べる対象を読み込む/u);
  const button =
    /<button[^>]*>[^<]*選べる対象を読み込む/u.exec(inactive)?.[0] ?? '';
  assert.match(button, /disabled/u);
  const reading = text(
    panel({ view: view([googleEntry()]), discovering: id(1) }),
  );
  assert.match(reading, /読み込んでいます/u);
});
