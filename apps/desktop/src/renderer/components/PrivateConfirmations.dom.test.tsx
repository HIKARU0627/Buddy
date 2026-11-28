// 記録しない会話の独立した確認の欄（ADR 0197、U503）を happy-dom に React で実際に描いて確かめる。
// 確かめること: 見出し「記録しない会話の確認」と記録しない間の印・会話の内容は保存しない旨、行は何をどう変えるか（件名・
// 差出人・付ける／外すラベル）だけ、「承認する」「断る」は参照と決定だけで 1 回呼ぶ、送っている間・保留・停止中・対象を
// 確かめられない行では承認を押せない（断るは押せる）、結果の文言、確認も結果もなければ何も描かない、島を広げる数え方。
// 期待値は手で書いた。本物のブラウザ・Electron の窓ではない。
import { happy } from '../test-support/happy-dom.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import type {
  DesktopIpcRequest,
  DesktopIpcResponse,
  DesktopPrivateConfirmationEntry,
} from '@buddy/contracts';
import { AppProviders } from '../app/AppProviders.js';
import {
  EMPTY_ISLAND_MEMORY,
  nextIslandMemory,
} from '../state/island-state.js';
import {
  PrivateConfirmationStore,
  decisionNotice,
} from '../state/private-confirmation-state.js';
import { PrivateConfirmations } from './PrivateConfirmations.js';

after(async () => {
  await happy.happyDOM.close();
});

const REF = '00000000-0000-4000-8000-000000000701';

const entry = (
  over: Partial<DesktopPrivateConfirmationEntry> = {},
): DesktopPrivateConfirmationEntry => ({
  ref: REF,
  service: 'gmail',
  account_label: 'synthetic-account',
  target: {
    subject: 'B06-SYNTH 件名',
    sender: 'sender@example.invalid',
    received_at: null,
  },
  labels_add: ['B06-SYNTH-label'],
  labels_remove: ['B06-SYNTH-old'],
  approvable: true,
  delivery_unknown: false,
  ...over,
});

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const draw = (node: ReactNode) =>
    act(() => root.render(<AppProviders>{node}</AppProviders>));
  const cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  const button = (decision: 'approve' | 'decline') =>
    host.querySelector<HTMLButtonElement>(
      `button[data-private-decision="${decision}"]`,
    );
  return { host, draw, cleanup, button };
}

const IDLE = { busy: [], notice: null } as const;

test('the section says it is a private conversation, shows only what to change, and each button calls once with the reference', async () => {
  const view = mount();
  const calls: [string, string][] = [];
  try {
    await view.draw(
      <PrivateConfirmations
        entries={[entry()]}
        state={IDLE}
        actions={{ decide: (ref, decision) => calls.push([ref, decision]) }}
        stopped={false}
      />,
    );
    const section = view.host.querySelector('section');
    assert.ok(section);
    const heading = view.host.querySelector(
      `#${section.getAttribute('aria-labelledby') ?? ''}`,
    );
    assert.equal(heading?.textContent, '記録しない会話の確認');
    // 記録しない間の印（記号と文言）と、会話の内容は保存しない旨。
    assert.ok(view.host.querySelector('[data-private-mark="on"]'));
    assert.match(section.textContent ?? '', /会話の内容は保存しません。/u);
    const row = view.host.querySelector(`[data-private-confirmation="${REF}"]`);
    assert.ok(row);
    assert.match(row.textContent ?? '', /メールのラベルの変更/u);
    assert.match(row.textContent ?? '', /件名: B06-SYNTH 件名/u);
    assert.match(row.textContent ?? '', /差出人: sender@example\.invalid/u);
    assert.match(row.textContent ?? '', /付ける: B06-SYNTH-label/u);
    assert.match(row.textContent ?? '', /外す: B06-SYNTH-old/u);
    assert.equal(
      view.button('approve')?.getAttribute('aria-label'),
      '承認する（メールのラベルの変更・付ける: B06-SYNTH-label・外す: B06-SYNTH-old）',
    );
    await act(async () => view.button('approve')?.click());
    await act(async () => view.button('decline')?.click());
    assert.deepEqual(calls, [
      [REF, 'approve'],
      [REF, 'decline'],
    ]);
  } finally {
    view.cleanup();
  }
});

test('approval is not offered while sending, held, stopped or for an unidentified target; decline stays available when stopped', async () => {
  const view = mount();
  const actions = { decide: () => undefined };
  try {
    await view.draw(
      <PrivateConfirmations
        entries={[entry()]}
        state={{ busy: [REF], notice: null }}
        actions={actions}
        stopped={false}
      />,
    );
    assert.equal(view.button('approve')?.disabled, true);
    assert.equal(view.button('approve')?.textContent, '送っています…');
    assert.equal(view.button('decline')?.disabled, true);

    await view.draw(
      <PrivateConfirmations
        entries={[entry({ delivery_unknown: true })]}
        state={IDLE}
        actions={actions}
        stopped={false}
      />,
    );
    assert.equal(view.button('approve')?.disabled, true);
    assert.match(view.host.textContent ?? '', /結果を確かめています。/u);

    await view.draw(
      <PrivateConfirmations
        entries={[entry()]}
        state={IDLE}
        actions={actions}
        stopped
      />,
    );
    assert.equal(view.button('approve')?.disabled, true);
    assert.equal(view.button('decline')?.disabled, false);
    assert.match(
      view.host.textContent ?? '',
      /入出力が止まっている間は承認できません/u,
    );

    await view.draw(
      <PrivateConfirmations
        entries={[entry({ approvable: false, target: null })]}
        state={IDLE}
        actions={actions}
        stopped={false}
      />,
    );
    assert.equal(view.button('approve'), null);
    assert.equal(view.button('decline')?.disabled, false);
    assert.match(
      view.host.textContent ?? '',
      /対象のメールを確かめられないため、承認できません。/u,
    );
  } finally {
    view.cleanup();
  }
});

test('nothing is drawn without confirmations or a result; the last result stays under the section', async () => {
  const view = mount();
  try {
    await view.draw(
      <PrivateConfirmations
        entries={[]}
        state={IDLE}
        actions={{ decide: () => undefined }}
        stopped={false}
      />,
    );
    assert.equal(view.host.textContent, '');
    await view.draw(
      <PrivateConfirmations
        entries={[]}
        state={{
          busy: [],
          notice: { tone: 'success', text: '断りました。変更はしていません。' },
        }}
        actions={{ decide: () => undefined }}
        stopped={false}
      />,
    );
    assert.match(
      view.host.querySelector('[role="status"]')?.textContent ?? '',
      /断りました。変更はしていません。$/u,
    );
  } finally {
    view.cleanup();
  }
});

test('the store sends one request per press and maps results and refusals to plain sentences', async () => {
  const sent: DesktopIpcRequest[] = [];
  const answers: DesktopIpcResponse[] = [];
  let release: (() => void) | null = null;
  const store = new PrivateConfirmationStore({
    invoke: (request) => {
      sent.push(request);
      return new Promise((resolve) => {
        release = () =>
          resolve(
            answers.shift() ?? {
              request_id: request.request_id,
              channel: 'desktop.private_confirmation_decide',
              outcome: 'ok',
              result: 'recorded',
            },
          );
      });
    },
  });
  store.actions.decide(REF, 'approve');
  // 送っている間は同じ行から送らない。
  store.actions.decide(REF, 'approve');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.payload, { ref: REF, decision: 'approve' });
  assert.deepEqual(store.snapshot().busy, [REF]);
  await act(async () => release?.());
  assert.deepEqual(store.snapshot(), {
    busy: [],
    notice: {
      tone: 'success',
      text: '承認しました。最小の記録だけを残して実行します。',
    },
  });
  // 隠した（ロック・切断）後に届いた応答は反映しない。
  store.actions.decide(REF, 'decline');
  store.hide();
  await act(async () => release?.());
  assert.deepEqual(store.snapshot(), { busy: [], notice: null });

  const reply = (result: string): DesktopIpcResponse =>
    ({
      request_id: REF,
      channel: 'desktop.private_confirmation_decide',
      outcome: 'ok',
      result,
    }) as DesktopIpcResponse;
  assert.deepEqual(decisionNotice(reply('record_failed')), {
    tone: 'warning',
    text: '承認しましたが、記録を残せなかったため変更はしていません。必要なら、もう一度頼んでください。',
  });
  assert.equal(decisionNotice(reply('record_unknown')).tone, 'warning');
  assert.deepEqual(
    decisionNotice({
      request_id: REF,
      channel: 'desktop.private_confirmation_decide',
      outcome: 'rejected',
      reason: 'core_rejected',
    }),
    {
      tone: 'warning',
      text: 'この確認は取り下げられたか、内容が変わったため、中枢が受け付けませんでした。変更はしていません。必要なら、もう一度頼んでください。',
    },
  );
});

test('a new private confirmation widens the island like any operation that needs a check', () => {
  const at = 1_000;
  const before = nextIslandMemory(
    EMPTY_ISLAND_MEMORY,
    { shown: true, operations: [], notices: {}, privateConfirmations: 0 },
    at,
  );
  assert.equal(before.signals.attentionCount, 0);
  const raised = nextIslandMemory(
    before,
    { shown: true, operations: [], notices: {}, privateConfirmations: 1 },
    at + 10,
  );
  assert.equal(raised.signals.attentionCount, 1);
  assert.equal(raised.signals.attentionRaisedAt, at + 10);
  // 承認・断るで減ったら畳む。
  const lowered = nextIslandMemory(
    raised,
    { shown: true, operations: [], notices: {}, privateConfirmations: 0 },
    at + 20,
  );
  assert.equal(lowered.signals.attentionRaisedAt, null);
});
