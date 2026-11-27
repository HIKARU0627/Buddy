// 忘却の画面（UI-10、Issue #180、ADR 0183）の操作の試験。preload の限定 API を模擬（要求を記録して手で答える）にし、
// useMemoryState と MemoryPanel を happy-dom の文書に React で描いて確かめる。期待値は手で書いた。
// 確かめること: ゲートが閉じている間は計画・実行が押せず理由が出る、実行のボタンは確認の帯の中だけ、計画の後に変わった
// （preview_stale）は作り直しを促して自動では作り直さない、結果が分からない（outcome_unknown）は「消えたかもしれません」を出して
// 自動では送り直さない、中枢の 503（forget_unavailable）は画面の状態に写す。Electron の実際の画面での見た目・操作は未実施。
import { happy } from '../../test-support/happy-dom.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  DesktopIpcRequest,
  DesktopIpcResponse,
  DesktopMemoryView,
} from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import type { BuddyDesktopApi } from '../../desktop-api.js';
import { useMemoryState } from '../../state/use-memory-state.js';
import { MemoryPanel } from './MemoryPanel.js';

after(async () => {
  await happy.happyDOM.close();
});

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = Date.parse('2030-11-04T09:00:00.000Z');
const ROW_1 = uuid(0x101);
const ROW_2 = uuid(0x102);
const ROW_3 = uuid(0x103);
const PLAN_REF = uuid(0x201);

const entry = (ref: string, text: string, fields = {}) => ({
  ref,
  kind: 'preference' as const,
  origin: 'explicit_request' as const,
  text,
  status: 'active' as const,
  created_at: '2030-10-01T00:00:00.000Z',
  review_at: '2030-12-30T00:00:00.000Z',
  delete_at: null,
  source_counts: { turn: 1, source_item: 0, memory: 0 },
  ...fields,
});

const view = (fields: Partial<DesktopMemoryView> = {}): DesktopMemoryView => ({
  fetch: 'loaded',
  fetched_at: '2030-11-04T08:59:00.000Z',
  forget: 'open',
  truncated: false,
  entries: [
    entry(ROW_1, '返信は短めが好み'),
    entry(ROW_2, '短い返信の言い回し', {
      origin: 'auto_extraction',
      source_counts: { turn: 0, source_item: 0, memory: 1 },
    }),
    entry(ROW_3, '毎朝 7 時に散歩する', {
      kind: 'routine',
      status: 'review_pending',
      review_at: '2030-11-01T00:00:00.000Z',
      delete_at: '2030-12-01T00:00:00.000Z',
    }),
  ],
  plan: null,
  result: null,
  list_seq: 2,
  ...fields,
});

const PLAN: DesktopMemoryView['plan'] = {
  ref: PLAN_REF,
  target_ref: ROW_1,
  forgetting_generation: '3',
  expires_at: '2030-11-04T09:10:00.000Z',
  removed: {
    counts: [
      { kind: 'session_summary', count: 1 },
      { kind: 'memory', count: 2 },
      { kind: 'user_directive', count: 1 },
    ],
    memory_refs: [ROW_1, ROW_2],
    unlisted_memory_count: 0,
    directive_count: 1,
  },
  kept: { operation_states: ['awaiting_approval'], lineage_only: 0 },
  blocked_source_count: 1,
};

type Answer = (request: DesktopIpcRequest) => DesktopIpcResponse;

interface Fake {
  readonly api: BuddyDesktopApi;
  readonly sent: DesktopIpcRequest[];
  answer: Answer;
}

const okWith = (
  request: DesktopIpcRequest,
  memories: DesktopMemoryView,
): DesktopIpcResponse =>
  ({
    request_id: request.request_id,
    channel: request.channel,
    outcome: 'ok',
    memories,
  }) as DesktopIpcResponse;

const rejectWith = (
  request: DesktopIpcRequest,
  reason: Extract<DesktopIpcResponse, { outcome: 'rejected' }>['reason'],
): DesktopIpcResponse => ({
  request_id: request.request_id,
  channel: request.channel,
  outcome: 'rejected',
  reason,
});

function fake(answer: Answer): Fake {
  const sent: DesktopIpcRequest[] = [];
  const state: Fake = {
    sent,
    answer,
    api: {
      invoke: (request) => {
        sent.push(request);
        return Promise.resolve(state.answer(request));
      },
      onNotification: () => () => undefined,
    },
  };
  return state;
}

function Harness({ api }: { readonly api: BuddyDesktopApi }) {
  const memories = useMemoryState(api, true);
  return (
    <MemoryPanel state={memories.state} actions={memories.actions} now={NOW} />
  );
}

async function render(api: BuddyDesktopApi) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AppProviders>
        <Harness api={api} />
      </AppProviders>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    async close() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const buttons = (root: Element, name: RegExp) =>
  [...root.querySelectorAll('button')].filter((button) =>
    name.test(button.textContent),
  );

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

test('while the gate is closed the list is shown and planning and executing cannot be pressed', async () => {
  const f = fake((request) =>
    okWith(request, view({ forget: 'closed', plan: PLAN })),
  );
  const screen = await render(f.api);
  const text = screen.container.textContent;
  // 一覧（種類の見出し・本文・由来・期限・見直し待ちの印）は見える。
  assert.match(text, /好み/u);
  assert.match(text, /習慣/u);
  assert.match(text, /返信は短めが好み/u);
  assert.match(text, /由来: 発言\u00a01\u00a0件/u);
  assert.match(text, /見直し待ち/u);
  // 「まだ使えません」と分かる理由を出す。
  const note = screen.container.querySelector('#memory-forget-gate-note');
  assert(note !== null);
  assert.match(note.textContent, /忘却はまだ使えません/u);
  const plans = buttons(screen.container, /忘却の計画を作る/u);
  assert.equal(plans.length, 3);
  for (const button of plans) {
    assert.equal(button.disabled, true);
    assert.equal(
      button.getAttribute('aria-describedby'),
      'memory-forget-gate-note',
    );
  }
  const execute = buttons(screen.container, /忘れる（確認へ）/u);
  assert.equal(execute.length, 1);
  assert.equal(execute[0]?.disabled, true);
  // 押しても（無効なので）計画・実行は送らない。
  await act(async () => {
    plans[0]?.click();
    execute[0]?.click();
  });
  assert.deepEqual(
    f.sent.map((request) => request.channel),
    ['desktop.memories_list'],
  );
  await screen.close();
});

test('the execute button exists only inside the confirmation band, with the counts and the plan time', async () => {
  const f = fake((request) => okWith(request, view({ plan: PLAN })));
  const screen = await render(f.api);
  const band = screen.container.querySelector(
    '[role="group"][aria-label="忘却の確認"]',
  );
  assert(band !== null);
  const all = buttons(screen.container, /忘れる/u);
  assert.equal(all.length, 1);
  assert(band.contains(all[0] as Node));
  assert.match(
    band.textContent,
    /消える物 合計\u00a04\u00a0件（記憶\u00a02\u00a0件・指示\u00a01\u00a0件）/u,
  );
  assert.match(band.textContent, /これまでに忘れた回数: 3\u00a0回/u);
  assert.match(band.textContent, /残り\u00a010\u00a0分/u);
  assert.doesNotMatch(screen.container.textContent, /世代/u);
  // 右の計画は「消える物」「消える指示」「残る物」の順。
  const headings = [...screen.container.querySelectorAll('[data-plan] h4')].map(
    (heading) => heading.textContent.replace(/\s*\d+\u00a0件$/u, ''),
  );
  assert.deepEqual(headings, ['消える物', '消える指示', '残る物']);
  assert.match(screen.container.textContent, /承認待ちの操作 1\u00a0件/u);
  // 一覧の行には実行のボタンがない（計画を作るボタンだけ）。
  for (const row of screen.container.querySelectorAll('li[data-memory-status]'))
    assert.equal(buttons(row, /忘れる（確認へ）/u).length, 0);
  // 実行は確認の帯のボタンから、計画の参照だけを送る。
  f.answer = (request) =>
    request.channel === 'desktop.forget_execute'
      ? okWith(
          request,
          view({
            entries: [
              view().entries[2] as DesktopMemoryView['entries'][number],
            ],
            result: {
              outcome: 'forgotten',
              removed_total: 4,
              at: '2030-11-04T09:00:00.000Z',
            },
            list_seq: 3,
          }),
        )
      : okWith(request, view({ plan: PLAN }));
  await act(async () => all[0]?.click());
  await settle();
  assert.deepEqual(f.sent.at(-1), {
    channel: 'desktop.forget_execute',
    request_id: f.sent.at(-1)?.request_id,
    payload: { ref: PLAN_REF },
  });
  assert.match(
    screen.container.textContent,
    /記憶を忘れました。（消えた物 4\u00a0件）/u,
  );
  await screen.close();
});

test('a change after the plan asks to make the plan again and does not replan or resend by itself', async () => {
  const f = fake((request) => okWith(request, view({ plan: PLAN })));
  const screen = await render(f.api);
  f.answer = (request) =>
    request.channel === 'desktop.forget_execute'
      ? rejectWith(request, 'preview_stale')
      : okWith(request, view({ list_seq: 3 }));
  const execute = buttons(screen.container, /忘れる（確認へ）/u);
  await act(async () => execute[0]?.click());
  await settle();
  assert.match(
    screen.container.textContent,
    /計画の後に、記憶か忘却の記録が変わりました。何も消していません。「忘却の計画を作る」で作り直して/u,
  );
  // 読み直しはしたが、計画も実行も自分では送らない。
  assert.deepEqual(
    f.sent.map((request) => request.channel),
    [
      'desktop.memories_list',
      'desktop.forget_execute',
      'desktop.memories_list',
    ],
  );
  assert.equal(buttons(screen.container, /忘れる（確認へ）/u).length, 0);
  await screen.close();
});

test('an unknown outcome says it may have been forgotten and is never resent', async () => {
  const f = fake((request) => okWith(request, view({ plan: PLAN })));
  const screen = await render(f.api);
  f.answer = (request) =>
    request.channel === 'desktop.forget_execute'
      ? rejectWith(request, 'outcome_unknown')
      : okWith(
          request,
          view({
            result: {
              outcome: 'outcome_unknown',
              removed_total: 4,
              at: '2030-11-04T09:00:00.000Z',
            },
            list_seq: 3,
          }),
        );
  await act(async () =>
    buttons(screen.container, /忘れる（確認へ）/u)[0]?.click(),
  );
  await settle();
  const result = screen.container.querySelector(
    '[data-result="outcome_unknown"]',
  );
  assert(result !== null);
  assert.equal(result.getAttribute('role'), 'alert');
  assert.match(result.textContent, /消えたかもしれません/u);
  assert.match(result.textContent, /自動では送り直しません/u);
  await settle();
  assert.equal(
    f.sent.filter((request) => request.channel === 'desktop.forget_execute')
      .length,
    1,
  );
  await screen.close();
});

test('a 503 from the hub to the plan disables forgetting on the screen until the owner reads again', async () => {
  const f = fake((request) => okWith(request, view()));
  const screen = await render(f.api);
  f.answer = (request) =>
    request.channel === 'desktop.forget_plan'
      ? rejectWith(request, 'forget_unavailable')
      : okWith(request, view({ list_seq: 3 }));
  const first = buttons(screen.container, /忘却の計画を作る/u)[0];
  assert.equal(first?.disabled, false);
  await act(async () => first?.click());
  await settle();
  assert.deepEqual(f.sent.at(-1)?.payload, { ref: ROW_1 });
  for (const button of buttons(screen.container, /忘却の計画を作る/u))
    assert.equal(button.disabled, true);
  const note = screen.container.querySelector('#memory-forget-gate-note');
  assert.match(note?.textContent ?? '', /中枢が今は忘却を受け付けていません/u);
  // 本人が「読み直す」を押すと、中枢の今の値（open）に戻る。
  await act(async () => buttons(screen.container, /^読み直す$/u)[0]?.click());
  await settle();
  assert.equal(
    buttons(screen.container, /忘却の計画を作る/u)[0]?.disabled,
    false,
  );
  await screen.close();
});
