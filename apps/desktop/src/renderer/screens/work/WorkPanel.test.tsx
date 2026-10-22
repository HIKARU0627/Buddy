// 会話・変更の確認・処理状況の画面の試験（B04-05、ADR 0024・0031）。サーバー描画（react-dom/server）で HTML にして、
// 表示する内容・読み上げのラベル・ボタンを確かめる。押したときの要求は work-state.test.ts（actions）で確かめる。
// 期待値の文言は手で書く。クリック・キーボードでの実際の操作は Electron の画面で確かめる。
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DesktopOperationEntry,
  DesktopOperationPreview,
} from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import { INITIAL_WORK_STATE } from '../../state/work-state.js';
import type { WorkActions, WorkViewState } from '../../state/work-state.js';
import { WorkPanel } from './WorkPanel.js';

const test = (name: string, fn: () => void) =>
  nodeTest(name, { timeout: 10_000 }, fn);

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const NO_ACTIONS: WorkActions = {
  submit: () => undefined,
  setDraft: () => undefined,
  preview: () => undefined,
  closePreview: () => undefined,
  approve: () => undefined,
  cancel: () => undefined,
  reconcile: () => undefined,
  retry: () => undefined,
};

const entry = (
  overrides: Partial<DesktopOperationEntry> = {},
): DesktopOperationEntry => ({
  ref: id(1),
  operation_kind: 'task.create',
  state: 'awaiting_approval',
  approval_state: 'none',
  allowed_actions: ['preview', 'approve', 'cancel'],
  result: null,
  state_revision: '1',
  delivery_unknown: false,
  ...overrides,
});

const preview: DesktopOperationPreview = {
  preview_ref: id(0x20),
  operation_kind: 'mail.labels.change',
  service: 'mock',
  target: 'mail-001',
  fields: [{ field: 'labels_add', values: ['follow-up'] }],
};

const render = (
  operations: readonly DesktopOperationEntry[],
  options: {
    readonly state?: WorkViewState;
    readonly link?: 'connected' | 'other';
    readonly stopped?: boolean;
  } = {},
) =>
  renderToStaticMarkup(
    <AppProviders>
      <WorkPanel
        state={options.state ?? INITIAL_WORK_STATE}
        actions={NO_ACTIONS}
        operations={operations}
        link={options.link ?? 'connected'}
        stopped={options.stopped ?? false}
      />
    </AppProviders>,
  );

const buttons = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*>(.*?)<\/button>/gu)].map((match) =>
    (match[1] ?? '').replace(/<[^>]+>/gu, '').trim(),
  );

const roles = (html: string, role: string) =>
  [...html.matchAll(new RegExp(`role="${role}"[^>]*>(.*?)</p>`, 'gu'))].length;

test('the conversation has a labelled field, one primary send button and its headings', () => {
  const html = render([]);
  assert.match(html, /<h2[^>]*>会話<\/h2>/u);
  assert.match(html, /<h2[^>]*>確認が必要な操作<\/h2>/u);
  assert.match(html, /まだ会話はありません。/u);
  assert.match(html, /<label[^>]*>話しかける<\/label>/u);
  assert.match(html, /<textarea/u);
  assert.match(html, /Ctrl か ⌘ を押しながら Enter でも送れます/u);
  assert.deepEqual(buttons(html), ['送る']);
  assert.equal([...html.matchAll(/button--primary/gu)].length, 1);
  assert.match(html, /操作はまだありません。/u);
});

test('the conversation shows the history, a clarification label and no IDs', () => {
  const state: WorkViewState = {
    ...INITIAL_WORK_STATE,
    messages: [
      { id: 1, role: 'user', text: '用事を登録して', clarification: false },
      {
        id: 2,
        role: 'buddy',
        text: '用事の題名を教えてください。',
        clarification: true,
      },
    ],
  };
  const html = render([], { state });
  assert.match(html, /aria-label="会話の履歴"/u);
  assert.match(html, /あなた/u);
  assert.match(html, /Buddy（聞き返し）/u);
  assert.match(html, /用事の題名を教えてください。/u);
  assert.doesNotMatch(html, /00000000-0000-4000/u);
});

test('a waiting operation shows its state with a symbol and the confirm and cancel buttons, and no resend', () => {
  const html = render([entry()]);
  assert.match(html, /用事の登録/u);
  assert.match(html, /<span[^>]*>○<\/span><span>承認待ち<\/span>/u);
  assert.deepEqual(buttons(html), ['送る', '内容を確認', '取り消す']);
  assert.doesNotMatch(html, /再送|再試行|もう一度送る/u);
  assert.doesNotMatch(html, /00000000-0000-4000/u);
});

test('an unknown result says it could not be confirmed, offers reconcile and never a resend', () => {
  const html = render([
    entry({ state: 'unknown_held', allowed_actions: ['reconcile'] }),
  ]);
  assert.match(html, /結果を確認できませんでした/u);
  assert.match(html, /自動では送り直しません。「照合」を押すと/u);
  assert.deepEqual(buttons(html), ['送る', '照合']);
  assert.doesNotMatch(html, /再送|再試行|送り直す/u);
  // 結果不明は「確認が必要な操作」に出す（処理中ではない）。
  assert.doesNotMatch(html, /処理中の操作/u);
  // 状態の文言に理由のコード・API の名前が出ない。
  assert.doesNotMatch(html, /unknown_held|reconcil|dispatch/u);
});

test('a lost command shows a sentence and offers no button until the operation moves', () => {
  const html = render([entry({ delivery_unknown: true })]);
  assert.match(html, /命令が届いたか確かめられていません/u);
  assert.match(
    html,
    /承認か取消が中枢に届いたか分かりません。自動では送り直しません。/u,
  );
  assert.deepEqual(buttons(html), ['送る']);
});

test('running and finished operations use the sentence table; finished ones are limited', () => {
  const html = render([
    entry({ ref: id(2), state: 'preparing', allowed_actions: ['cancel'] }),
    entry({ ref: id(3), state: 'reconciling', allowed_actions: ['reconcile'] }),
    ...[4, 5, 6, 7, 8, 9, 10].map((n) =>
      entry({
        ref: id(n),
        state: n === 4 ? 'succeeded' : 'cancelled',
        allowed_actions: [],
      }),
    ),
  ]);
  assert.match(html, /<h2[^>]*>処理中の操作<\/h2>/u);
  assert.match(html, /実行を準備しています/u);
  assert.match(html, /結果を確認しています/u);
  assert.match(html, /<h2[^>]*>終わった操作<\/h2>/u);
  assert.match(html, /完了しました/u);
  assert.match(
    html,
    /ほか2\u00a0件の終わった操作は、ここには出していません。/u,
  );
});

test('the confirmation shows kind, account, target, before and after, and impact, with one primary approve button', () => {
  const state: WorkViewState = {
    ...INITIAL_WORK_STATE,
    preview: { ref: id(1), preview, approving: false },
  };
  const html = render([entry({ operation_kind: 'mail.labels.change' })], {
    state,
  });
  assert.match(html, /<h2[^>]*>変更の確認<\/h2>/u);
  assert.match(
    html,
    /<dt[^>]*>操作の種類<\/dt><dd[^>]*>メールのラベルの変更<\/dd>/u,
  );
  assert.match(html, /<dt[^>]*>アカウント<\/dt><dd[^>]*>模擬のメール<\/dd>/u);
  assert.match(html, /<dt[^>]*>対象<\/dt>/u);
  assert.match(html, /mail-001/u);
  assert.match(html, /<caption[^>]*>変更の前後<\/caption>/u);
  assert.match(html, /<th[^>]*scope="row"[^>]*>付けるラベル<\/th>/u);
  assert.match(html, /付いていません/u);
  assert.match(html, /follow-up/u);
  assert.match(html, /<h3[^>]*>影響<\/h3>/u);
  assert.match(html, /メールは送りません。/u);
  assert.match(html, /取り消せるのは、実行の前だけです。/u);
  // 1 画面に primary は 1 つ: 確認を開いている間は「承認する」だけが primary で、「送る」は secondary。
  assert.equal([...html.matchAll(/button--primary/gu)].length, 1);
  assert.deepEqual(buttons(html), ['送る', '承認する', '閉じる', '取り消す']);
  assert.match(html, /<button[^>]*button--primary[^>]*>承認する<\/button>/u);
  assert.match(html, /確認のダイアログが開きます/u);
  // 確認の中身に、ID・hash・版は出ない。
  assert.doesNotMatch(
    html,
    /00000000-0000-4000-8000-000000000020|content_hash|preview_id/u,
  );
});

test('while main shows its own confirmation the approve button is disabled and says what to do', () => {
  const state: WorkViewState = {
    ...INITIAL_WORK_STATE,
    preview: { ref: id(1), preview, approving: true },
  };
  const html = render([entry({ operation_kind: 'mail.labels.change' })], {
    state,
  });
  assert.match(html, /確認のダイアログで、承認するか選んでください…/u);
  assert.match(html, /<button[^>]*disabled[^>]*>承認する<\/button>/u);
  assert.equal(roles(html, 'status') >= 1, true);
  assert.doesNotMatch(html, />閉じる</u);
});

test('a notice is shown under its row with a role, and a failure of sending is shown under the field', () => {
  const state: WorkViewState = {
    ...INITIAL_WORK_STATE,
    notices: { [id(1)]: { tone: 'warning', text: '取り消せませんでした。' } },
    turnNotice: { tone: 'warning', text: '発言を入力してください。' },
  };
  const html = render([entry()], { state });
  assert.match(html, /role="alert"[^>]*>.*取り消せませんでした。/u);
  assert.match(html, /発言を入力してください。/u);
  assert.match(html, /aria-invalid="true"/u);
});

test('while the input is stopped there is no field, no send button and no confirm button; cancel stays', () => {
  const html = render([entry()], { stopped: true });
  assert.match(html, /入出力が止まっているため、発言と承認はできません。/u);
  assert.doesNotMatch(html, /<textarea/u);
  assert.deepEqual(buttons(html), ['取り消す']);
});

test('while not connected only the conversation history and a sentence remain', () => {
  const html = render([], { link: 'other' });
  assert.match(html, /中枢に接続していないため、発言と承認はできません。/u);
  assert.doesNotMatch(html, /<textarea|確認が必要な操作/u);
  assert.deepEqual(buttons(html), []);
});

test('a notice of the operation whose confirmation is open is shown once, in the confirmation', () => {
  const text = '確認で「やめる」を選んだため、承認していません。';
  const state: WorkViewState = {
    ...INITIAL_WORK_STATE,
    preview: { ref: id(1), preview, approving: false },
    notices: { [id(1)]: { tone: 'warning', text } },
  };
  const html = render([entry({ operation_kind: 'mail.labels.change' })], {
    state,
  });
  assert.equal(html.split(text).length - 1, 1);
});

test('a not-executed operation offers retry; an unknown one never does', () => {
  const html = render([
    entry({ ref: id(2), state: 'not_executed', allowed_actions: ['retry'] }),
    entry({
      ref: id(3),
      state: 'unknown_held',
      allowed_actions: ['reconcile'],
    }),
  ]);
  assert.deepEqual(buttons(html), ['送る', '照合', '再試行']);
  assert.match(html, /変更は行われていません。「再試行」を押すと/u);
  const stopped = render(
    [entry({ ref: id(2), state: 'not_executed', allowed_actions: ['retry'] })],
    { stopped: true },
  );
  assert.deepEqual(buttons(stopped), []);
});
