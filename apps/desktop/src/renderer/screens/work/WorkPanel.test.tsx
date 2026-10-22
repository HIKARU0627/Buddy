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
  check: () => undefined,
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
  headline: null,
  detail: null,
  ...overrides,
});

const preview: DesktopOperationPreview = {
  preview_ref: id(0x20),
  operation_kind: 'mail.labels.change',
  service: 'mock',
  target: 'mail-001',
  fields: [{ field: 'labels_add', values: ['follow-up'] }],
  account_label: 'user@example.com',
  target_detail: {
    subject: '来週の打ち合わせ',
    sender: 'sato@example.com',
    received_at: '2026-10-04T18:30:00+09:00',
  },
  approvable: true,
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
  // 見えるボタンは短く、読み上げの名前に対象（操作の内容）を含める。
  assert.match(html, /aria-label="内容を確認（用事の登録）"/u);
  assert.match(html, /aria-label="取り消す（用事の登録）"/u);
  assert.doesNotMatch(html, /再送|再試行|もう一度送る/u);
  assert.doesNotMatch(html, /content_hash|operation_id|state_revision/u);
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
    /命令が中枢に届いたか分かりません。自動では送り直しません。「状態を確かめる」を押すと/u,
  );
  // 読み取りだけで確かめるボタンだけ（命令の再送・取消・再試行は出さない）。
  assert.deepEqual(buttons(html), ['送る', '状態を確かめる']);
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
    preview: { ref: id(1), seq: 1, preview, approving: false },
  };
  const html = render([entry({ operation_kind: 'mail.labels.change' })], {
    state,
  });
  assert.match(html, /<h2[^>]*>変更の確認<\/h2>/u);
  assert.match(
    html,
    /<dt[^>]*>操作の種類<\/dt><dd[^>]*>メールのラベルの変更<\/dd>/u,
  );
  // アカウントの表示名と、対象のメールの件名・差出人・受信日時（内部の ID では見分けられない）。
  assert.match(
    html,
    /<dt[^>]*>アカウント<\/dt><dd[^>]*>user@example.com（模擬のメール）<\/dd>/u,
  );
  assert.match(html, /<dt[^>]*>対象のメール<\/dt>/u);
  assert.match(html, /来週の打ち合わせ/u);
  assert.match(html, /sato@example.com/u);
  assert.match(html, /2026-10-04T18:30:00\+09:00/u);
  assert.doesNotMatch(html, /mail-001/u);
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
    preview: { ref: id(1), seq: 1, preview, approving: true },
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
    turnNotice: {
      tone: 'warning',
      text: '発言を入力してください。',
      field: true,
    },
  };
  const html = render([entry()], { state });
  assert.match(html, /role="alert"[^>]*>.*取り消せませんでした。/u);
  assert.match(html, /発言を入力してください。/u);
  assert.match(html, /aria-invalid="true"/u);
  // 通信の失敗は入力の誤りではない: 欄は赤くせず、欄とは別の通知にする。
  const lost: WorkViewState = {
    ...INITIAL_WORK_STATE,
    draft: '今日の予定を見せて',
    turnNotice: {
      tone: 'warning',
      text: '発言が中枢に届いたか確かめられませんでした。',
    },
  };
  const lostHtml = render([], { state: lost });
  assert.doesNotMatch(lostHtml, /aria-invalid="true"/u);
  assert.match(
    lostHtml,
    /role="alert"[^>]*>.*発言が中枢に届いたか確かめられませんでした。/u,
  );
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
    preview: { ref: id(1), seq: 1, preview, approving: false },
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

test('a row is titled by its content and every button names its target for a screen reader', () => {
  const html = render([
    entry({ headline: '牛乳を買う', detail: '期限 2030-10-06' }),
    entry({
      ref: id(2),
      headline: '来週の打ち合わせ',
      detail: '付ける: follow-up',
      operation_kind: 'mail.labels.change',
      state: 'unknown_held',
      allowed_actions: ['reconcile'],
    }),
  ]);
  assert.match(html, />牛乳を買う<\/span>/u);
  assert.match(html, />用事の登録・期限 2030-10-06<\/span>/u);
  assert.match(html, />来週の打ち合わせ<\/span>/u);
  assert.match(html, /aria-label="内容を確認（牛乳を買う）"/u);
  assert.match(html, /aria-label="取り消す（牛乳を買う）"/u);
  assert.match(html, /aria-label="照合（来週の打ち合わせ）"/u);
  // 見える文字の名前は短いまま。
  assert.deepEqual(buttons(html), ['送る', '内容を確認', '取り消す', '照合']);
});

test('guidance for an unknown result and for a lost command is body-sized text, not a small supplement', () => {
  const html = render([
    entry({ state: 'unknown_held', allowed_actions: ['reconcile'] }),
  ]);
  assert.match(
    html,
    /<p class="max-w-prose text-sm leading-6 text-muted">実行されたかどうか分かりません。/u,
  );
  assert.match(html, /実行先の状態を確認します。変更は加えません。/u);
  assert.doesNotMatch(html, /text-xs[^>]*>実行されたかどうか/u);
});

test('the confirmation of a new draft keeps the body in its own full-width block and has no empty before column', () => {
  const draft: DesktopOperationPreview = {
    preview_ref: id(0x21),
    operation_kind: 'mail.draft.create',
    service: 'gmail',
    target: 'mail-004',
    fields: [
      { field: 'draft_to', values: ['sato@example.com'] },
      { field: 'draft_subject', values: ['Re: 来週の打ち合わせ'] },
      {
        field: 'draft_body',
        values: ['佐藤さん\n\nご連絡ありがとうございます。'],
      },
    ],
    account_label: 'user@example.com',
    target_detail: {
      subject: '来週の打ち合わせ',
      sender: 'sato@example.com',
      received_at: '2026-10-04T18:30:00+09:00',
    },
    approvable: true,
  };
  const state: WorkViewState = {
    ...INITIAL_WORK_STATE,
    preview: { ref: id(1), seq: 1, preview: draft, approving: false },
  };
  const html = render([entry({ operation_kind: 'mail.draft.create' })], {
    state,
  });
  // 保存先と返信元をはっきり出す。
  assert.match(
    html,
    /<dt[^>]*>下書きの保存先<\/dt><dd[^>]*>user@example.com（Gmail）<\/dd>/u,
  );
  assert.match(html, /<dt[^>]*>返信元のメール<\/dt>/u);
  assert.match(html, /<h3[^>]*>新しく作成する内容<\/h3>/u);
  // 新規作成は「変更前」の列を出さない。本文は表の外の全幅の欄に、通常の太さで出す。
  assert.doesNotMatch(html, />変更前</u);
  assert.match(
    html,
    /<h4[^>]*>本文<\/h4><p class="max-w-prose whitespace-pre-wrap[^"]*">佐藤さん/u,
  );
  assert.doesNotMatch(html, /font-semibold[^>]*>佐藤さん/u);
});

test('a confirmation that cannot identify the account or the mail offers no approve button', () => {
  const state: WorkViewState = {
    ...INITIAL_WORK_STATE,
    preview: {
      ref: id(1),
      seq: 1,
      preview: {
        ...preview,
        account_label: null,
        target_detail: null,
        approvable: false,
      },
      approving: false,
    },
  };
  const html = render([entry({ operation_kind: 'mail.labels.change' })], {
    state,
  });
  assert.match(html, /口座か対象のメールを確認できないため、承認できません。/u);
  assert.doesNotMatch(html, />承認する</u);
  // 承認の操作がないので、primary は「送る」に戻る（1 画面に primary は 1 つ）。
  assert.equal([...html.matchAll(/button--primary/gu)].length, 1);
  assert.match(html, /<button[^>]*button--primary[^>]*>送る<\/button>/u);
  assert.deepEqual(buttons(html), ['送る', '閉じる', '取り消す']);
});

test('headings that receive focus are focusable but not in the tab order, and the latest answer is announced', () => {
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
    preview: { ref: id(1), seq: 1, preview, approving: false },
  };
  const html = render([entry({ operation_kind: 'mail.labels.change' })], {
    state,
  });
  assert.match(html, /<h2 id="preview-heading" tabindex="-1"/u);
  assert.match(html, /<h2 id="attention-heading" tabindex="-1"/u);
  // 最新の追加分だけを読み上げる（履歴の全文ではない）。
  assert.match(
    html,
    /<p role="status" aria-live="polite" class="sr-only">用事の題名を教えてください。<\/p>/u,
  );
  assert.equal(html.split('role="status" aria-live="polite"').length - 1, 1);
});

test('the schedule answer says what was counted and what this screen cannot show', () => {
  const state: WorkViewState = {
    ...INITIAL_WORK_STATE,
    messages: [
      { id: 1, role: 'user', text: '今日の予定を見せて', clarification: false },
      {
        id: 2,
        role: 'buddy',
        text: '取得した予定は3\u00a0件です。この画面では、予定の件名と時刻はまだ表示できません。',
        clarification: false,
      },
    ],
  };
  const html = render([], { state });
  assert.match(
    html,
    /取得した予定は3\u00a0件です。この画面では、予定の件名と時刻はまだ表示できません。/u,
  );
  assert.doesNotMatch(html, /ここには出していません/u);
});
