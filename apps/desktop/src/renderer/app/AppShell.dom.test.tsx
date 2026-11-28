// 画面の共通の枠と、形の伸び縮みの部品（ADR 0204）。happy-dom の文書に React で描いて確かめる。期待値は手で書く。
import { happy } from '../test-support/happy-dom.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppProviders } from './AppProviders.js';
import { AppShell } from './AppShell.js';
import type { ShellPage } from './AppShell.js';
import { FluidBox, motionMs, usePresence } from '../components/Fluid.js';

after(async () => {
  await happy.happyDOM.close();
});

// 動きの時間の変数（試験用）。試験の文書は計算済みのスタイルを覚えるので、最初に読む前にまとめて置く。
for (const [name, value] of [
  ['--test-ms', '520ms'],
  ['--test-s', '0.3s'],
  ['--test-zero', '0s'],
  ['--test-leave', '40ms'],
] as const)
  document.documentElement.style.setProperty(name, value);

// ページの面（選んでいない面は、読み上げの役割を外して inert で隠す）。
const PANELS = '[data-slot="tabs-panel"]';
// サイドバーの名前（細い列でポインターを載せたときの title）。
const tabTitles = (container: Element) =>
  [...container.querySelectorAll('[role="tab"]')].map(
    (tab) => tab.querySelector('[title]')?.getAttribute('title') ?? null,
  );

const PAGES: readonly ShellPage[] = [
  {
    id: 'talk',
    label: '会話',
    icon: <span data-icon="talk" />,
    badge: 2,
    badgeLabel: '確認が必要な操作 2 件',
    content: <input aria-label="下書き" defaultValue="" />,
  },
  {
    id: 'ledger',
    label: '家計簿',
    icon: <span data-icon="ledger" />,
    badge: 0,
    content: <p>家計簿の中身</p>,
  },
];

async function mount(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<AppProviders>{node}</AppProviders>));
  return {
    container,
    root,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test('with pages, the shell lists them as tabs and keeps every page mounted while hiding the others', async () => {
  const shell = await mount(
    <AppShell
      role="この端末"
      band={<p data-band="">状態帯</p>}
      todo={<p data-todo="">今やること</p>}
      footer={<p data-footer="">フッター</p>}
      pages={PAGES}
    />,
  );
  const tabs = [...shell.container.querySelectorAll('[role="tab"]')];
  assert.deepEqual(tabTitles(shell.container), ['会話', '家計簿']);
  // 最初のページを選んでいる。数は 0 でなければ出す（読み上げの名前つき）。
  assert.deepEqual(
    tabs.map((tab) => tab.getAttribute('aria-selected')),
    ['true', 'false'],
  );
  assert.equal(
    shell.container.querySelectorAll('[aria-label="確認が必要な操作 2 件"]')
      .length,
    1,
  );
  // 選んでいないページも描いたまま（inert で隠す）。読み上げの面（tabpanel）は選んだ 1 つだけ。
  assert.equal(shell.container.querySelectorAll('[role="tabpanel"]').length, 1);
  const panels = [...shell.container.querySelectorAll(PANELS)];
  assert.equal(panels.length, 2);
  assert.deepEqual(
    panels.map((panel) => panel.hasAttribute('inert')),
    [false, true],
  );
  assert.match(panels[1]?.className ?? '', /data-\[inert\]:hidden/u);
  assert.match(panels[1]?.textContent ?? '', /家計簿の中身/u);
  // 状態帯・今やること・フッターは 1 つずつ（Tabs の外に置き、2 度描かない）。
  for (const name of ['band', 'todo', 'footer'])
    assert.equal(shell.container.querySelectorAll(`[data-${name}]`).length, 1);
  await shell.close();
});

test('switching the page keeps what was typed on the page left behind', async () => {
  const shell = await mount(<AppShell role="この端末" pages={PAGES} />);
  const field = shell.container.querySelector('input');
  assert(field !== null);
  field.value = '書きかけ';
  const tabs = [...shell.container.querySelectorAll('[role="tab"]')];
  await act(async () => {
    (tabs[1] as HTMLElement).click();
  });
  const panels = [...shell.container.querySelectorAll(PANELS)];
  assert.deepEqual(
    panels.map((panel) => panel.hasAttribute('inert')),
    [true, false],
  );
  // 同じ要素のまま残っている。
  assert.equal(shell.container.querySelector('input'), field);
  assert.equal(field.value, '書きかけ');
  await shell.close();
});

test('a controlled page follows the caller, and reports the page the user picks', async () => {
  const picked: string[] = [];
  function Controlled() {
    const [page, setPage] = useState('ledger');
    return (
      <AppShell
        role="この端末"
        pages={PAGES}
        page={page}
        onPageChange={(id) => {
          picked.push(id);
          setPage(id);
        }}
      />
    );
  }
  const shell = await mount(<Controlled />);
  const tabs = [...shell.container.querySelectorAll('[role="tab"]')];
  assert.equal(tabs[1]?.getAttribute('aria-selected'), 'true');
  await act(async () => {
    (tabs[0] as HTMLElement).click();
  });
  assert.deepEqual(picked, ['talk']);
  assert.equal(tabs[0]?.getAttribute('aria-selected'), 'true');
  await shell.close();
});

test('without pages, the shell is one column with no tabs', () => {
  for (const pages of [undefined, [] as readonly ShellPage[]]) {
    const html = renderToStaticMarkup(
      <AppProviders>
        <AppShell
          role="この端末（未登録）"
          band={<p>状態帯</p>}
          footer={<p>フッター</p>}
          {...(pages === undefined ? {} : { pages })}
        >
          <p>本体</p>
        </AppShell>
      </AppProviders>,
    );
    assert.doesNotMatch(html, /role="tab"|role="tablist"|role="tabpanel"/u);
    assert.match(html, /<h1[^>]*>Buddy<\/h1>/u);
    assert.match(html, /この端末（未登録）/u);
    // 上から 状態帯 → 本体 → フッター。
    assert(html.indexOf('状態帯') < html.indexOf('本体'));
    assert(html.indexOf('本体') < html.indexOf('フッター'));
  }
});

test('the motion time is read in milliseconds, and is zero when it cannot be read', () => {
  assert.equal(motionMs('--test-ms'), 520);
  assert.equal(motionMs('--test-s'), 300);
  assert.equal(motionMs('--test-zero'), 0);
  assert.equal(motionMs('--test-missing'), 0);
});

test('a leaving value stays for the motion time, and disappears at once when the time is zero', async () => {
  const seen: (readonly [string | null, boolean])[] = [];
  function Probe({
    value,
    duration,
  }: {
    readonly value: string | null;
    readonly duration: string;
  }) {
    const { shown, leaving } = usePresence(value, duration);
    seen.push([shown, leaving]);
    return <p>{shown ?? '（なし）'}</p>;
  }
  // 描き直しでも同じ木のまま（Probe を作り直さない）。
  const probe = (value: string | null, duration: string) => (
    <AppProviders>
      <Probe value={value} duration={duration} />
    </AppProviders>
  );
  const shell = await mount(<Probe value="行" duration="--test-leave" />);
  assert.equal(shell.container.textContent, '行');
  // 値がなくなっても、動きの時間の間は前の値を返す（消える途中の印つき）。
  await act(async () => {
    shell.root.render(probe(null, '--test-leave'));
  });
  assert.equal(shell.container.textContent, '行');
  assert.deepEqual(seen.at(-1), ['行', true]);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  assert.equal(shell.container.textContent, '（なし）');
  assert.deepEqual(seen.at(-1), [null, false]);
  // 待つ間に値が戻れば、消さない。
  await act(async () => {
    shell.root.render(probe('次の行', '--test-leave'));
  });
  await act(async () => {
    shell.root.render(probe(null, '--test-leave'));
  });
  await act(async () => {
    shell.root.render(probe('戻った行', '--test-leave'));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  assert.equal(shell.container.textContent, '戻った行');
  // 動きの時間が 0（動きを減らす設定）なら、描く前に消す。
  await act(async () => {
    shell.root.render(probe(null, '--test-zero'));
  });
  assert.equal(shell.container.textContent, '（なし）');
  await shell.close();
});

test('the fluid box leaves the size to the content where it cannot be measured', async () => {
  const shell = await mount(
    <FluidBox as="section" aria-label="島" className="rounded-island">
      <p>中身</p>
    </FluidBox>,
  );
  const outer = shell.container.querySelector('section');
  assert(outer !== null);
  assert.equal(outer.getAttribute('aria-label'), '島');
  // 試験の文書は大きさを測れない（0 × 0）。大きさを指定せず、動きも始めない。
  assert.equal(outer.style.width, '');
  assert.equal(outer.style.height, '');
  assert.equal(outer.dataset['fluid'], undefined);
  assert.equal(outer.textContent, '中身');
  await shell.close();
});
