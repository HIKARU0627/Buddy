// 保存してよい記憶の種類の欄（ADR 0191）の操作の試験。preload の限定 API を模擬（要求を記録して手で答える）にし、
// useMemoryState と MemorySettingsPanel を happy-dom の文書に React で描いて確かめる。期待値は手で書いた。
// 確かめること: 読めていない間は選択を置かない、既定（何も選んでいない）の文、6 種類の決まった順と説明、選んだら変えた後の
// 種類の全部を 1 回だけ送る、送っている間はどの選択も押せない、別の画面で変わったときは欄の中に理由を出して送り直さない。
// Electron の実際の画面での見た目・操作は未実施。
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
import { MemorySettingsPanel } from './MemorySettingsPanel.js';

after(async () => {
  await happy.happyDOM.close();
});

const view = (
  settings: DesktopMemoryView['settings'],
  listSeq = 2,
): DesktopMemoryView => ({
  fetch: 'loaded',
  fetched_at: '2030-11-04T08:59:00.000Z',
  forget: 'closed',
  truncated: false,
  entries: [],
  plan: null,
  result: null,
  list_seq: listSeq,
  settings,
});

function Harness({ api }: { readonly api: BuddyDesktopApi }) {
  const memories = useMemoryState(api, true);
  return (
    <MemorySettingsPanel state={memories.state} actions={memories.actions} />
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
  await settle();
  return {
    container,
    async close() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const boxes = (root: Element) =>
  [...root.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];

const rowTexts = (root: Element) =>
  [...root.querySelectorAll('li[data-memory-kind]')].map((row) =>
    (row.textContent ?? '').trim(),
  );

function fakeApi(
  reply: (request: DesktopIpcRequest) => DesktopIpcResponse | Promise<never>,
) {
  const sent: DesktopIpcRequest[] = [];
  const api = {
    invoke: (request: DesktopIpcRequest) => {
      sent.push(request);
      return Promise.resolve(reply(request));
    },
    subscribe: () => () => undefined,
  } as unknown as BuddyDesktopApi;
  return { api, sent };
}

test('ADR 0191: settings that were not read show no choices and say so', async () => {
  const { api, sent } = fakeApi(
    (request) =>
      ({
        request_id: request.request_id,
        channel: request.channel,
        outcome: 'ok',
        memories: view(null),
      }) as DesktopIpcResponse,
  );
  const screen = await render(api);
  try {
    assert.equal(boxes(screen.container).length, 0);
    assert.match(
      screen.container.textContent ?? '',
      /保存してよい記憶の種類を、まだ中枢から読めていません。/u,
    );
    assert.doesNotMatch(
      screen.container.textContent ?? '',
      /今は何も選んでいない/u,
    );
    assert.deepEqual(
      sent.map((request) => request.channel),
      ['desktop.memories_list'],
    );
  } finally {
    await screen.close();
  }
});

test('ADR 0191: the default is nothing allowed; checking a kind sends every allowed kind once and the section shows the result', async () => {
  let hold: Promise<void> | null = null;
  let release: () => void = () => undefined;
  const { api, sent } = fakeApi((request) => {
    if (request.channel !== 'desktop.memory_settings_change')
      return {
        request_id: request.request_id,
        channel: request.channel,
        outcome: 'ok',
        memories: view({ allowed_kinds: [] }),
      } as DesktopIpcResponse;
    const answer = {
      request_id: request.request_id,
      channel: request.channel,
      outcome: 'ok',
      memories: view(
        { allowed_kinds: request.payload.allowed_kinds as never },
        5,
      ),
    } as DesktopIpcResponse;
    return (hold ?? Promise.resolve()).then(() => answer) as never;
  });
  const screen = await render(api);
  try {
    const text = () => screen.container.textContent ?? '';
    assert.match(text(), /今は何も選んでいないので、記憶は保存しません。/u);
    assert.match(
      text(),
      /選ぶのをやめても、保存済みの記憶は消えません。忘れるときは、下の「記憶と忘却」の欄を使います。/u,
    );
    assert.deepEqual(rowTexts(screen.container), [
      '好み好きなもの・苦手なもの・返事の長さなど',
      '目標達成したいこと・続けたいこと',
      '人家族・友人・仕事の相手についてのこと',
      '習慣毎日・毎週のように繰り返すこと',
      '言葉の使い方呼び方・言い回し・略語の意味',
      '進み具合学習や作業がどこまで進んだか',
    ]);
    assert.deepEqual(
      boxes(screen.container).map((box) => box.checked),
      [false, false, false, false, false, false],
    );
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await act(async () => {
      boxes(screen.container)[1]?.click();
    });
    // 送っている間は、どの選択も押せない。
    assert(boxes(screen.container).every((box) => box.disabled));
    await act(async () => {
      boxes(screen.container)[0]?.click();
    });
    release();
    await settle();
    assert.deepEqual(
      sent
        .filter(
          (request) => request.channel === 'desktop.memory_settings_change',
        )
        .map((request) => request.payload),
      [{ allowed_kinds: ['goal'] }],
    );
    assert.deepEqual(
      boxes(screen.container).map((box) => box.checked),
      [false, true, false, false, false, false],
    );
    assert.match(text(), /今は\u00a01\u00a0種類を保存します。/u);
    assert(boxes(screen.container).every((box) => !box.disabled));
  } finally {
    await screen.close();
  }
});

test('ADR 0191: a change refused because another screen changed the settings is explained in the section and not re-sent', async () => {
  const { api, sent } = fakeApi(
    (request) =>
      (request.channel === 'desktop.memory_settings_change'
        ? {
            request_id: request.request_id,
            channel: request.channel,
            outcome: 'rejected',
            reason: 'preview_stale',
          }
        : {
            request_id: request.request_id,
            channel: request.channel,
            outcome: 'ok',
            memories: view({ allowed_kinds: ['person'] }, 2 + sent.length),
          }) as DesktopIpcResponse,
  );
  const screen = await render(api);
  try {
    await act(async () => {
      boxes(screen.container)[0]?.click();
    });
    await settle();
    await settle();
    const section = screen.container.querySelector(
      'section[aria-labelledby="memory-settings-heading"]',
    );
    assert(section !== null);
    assert.match(
      section.textContent ?? '',
      /設定がほかの画面で変わりました。今の設定を読み直したので、もう一度選んでください。/u,
    );
    assert.deepEqual(
      sent.map((request) => request.channel),
      [
        'desktop.memories_list',
        'desktop.memory_settings_change',
        'desktop.memories_list',
      ],
    );
    // 読み直した中枢の今の値（人だけ）を見せる。
    assert.deepEqual(
      boxes(screen.container).map((box) => box.checked),
      [false, false, true, false, false, false],
    );
  } finally {
    await screen.close();
  }
});
