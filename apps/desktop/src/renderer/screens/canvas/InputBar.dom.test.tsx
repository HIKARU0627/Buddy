// 入力バーの Enter 送信（UI-08、ADR 0032・0067）。広げた TextArea でも、通常の Enter で 1 回だけ送り、
// IME の変換の確定（isComposing）と Shift+Enter では送らない。happy-dom の文書に React で描いて確かめる。
import { happy } from '../../test-support/happy-dom.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from '../../app/AppProviders.js';
import { InputBar } from './InputBar.js';

after(async () => {
  await happy.happyDOM.close();
});

function enter(options: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...options,
  });
}

test('Enter sends once from the expanded textarea, while IME composition and Shift+Enter do not', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let sent = 0;
  await act(async () => {
    root.render(
      <AppProviders>
        <InputBar
          line={{ tone: 'success', mark: 'dot', text: '受付中' }}
          enabled
          value=""
          onChange={() => undefined}
          onSubmit={() => {
            sent += 1;
          }}
          sending={false}
          attention={false}
          canSummon
          onSummon={() => undefined}
          expanded
        />
      </AppProviders>,
    );
  });
  const field = container.querySelector('textarea');
  assert(field !== null);
  const composing = enter();
  Object.defineProperty(composing, 'isComposing', { value: true });
  await act(async () => {
    field.dispatchEvent(composing);
  });
  assert.equal(sent, 0);
  const shift = enter({ shiftKey: true });
  await act(async () => {
    field.dispatchEvent(shift);
  });
  assert.equal(sent, 0);
  const plain = enter();
  await act(async () => {
    field.dispatchEvent(plain);
  });
  assert.equal(sent, 1);
  assert.equal(plain.defaultPrevented, true);
  await act(async () => root.unmount());
  container.remove();
});

test('focus moves to the expanded field when the compact field is replaced', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const bar = (expanded: boolean) => (
    <AppProviders>
      <InputBar
        line={{ tone: 'success', mark: 'dot', text: '受付中' }}
        enabled
        value=""
        onChange={() => undefined}
        onSubmit={() => undefined}
        sending={false}
        attention={false}
        canSummon
        onSummon={() => undefined}
        expanded={expanded}
      />
    </AppProviders>
  );
  await act(async () => root.render(bar(false)));
  const compact = container.querySelector('input');
  assert(compact !== null);
  compact.focus();
  assert.equal(document.activeElement, compact);
  await act(async () => root.render(bar(true)));
  const expanded = container.querySelector('textarea');
  assert(expanded !== null);
  assert.equal(document.activeElement, expanded);
  await act(async () => root.unmount());
  container.remove();
});

test('Enter also sends from the compact single-line input', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let sent = 0;
  await act(async () => {
    root.render(
      <AppProviders>
        <InputBar
          line={{ tone: 'success', mark: 'dot', text: '受付中' }}
          enabled
          value=""
          onChange={() => undefined}
          onSubmit={() => {
            sent += 1;
          }}
          sending={false}
          attention={false}
          canSummon
          onSummon={() => undefined}
        />
      </AppProviders>,
    );
  });
  const field = container.querySelector('input');
  assert(field !== null);
  const plain = enter();
  await act(async () => {
    field.dispatchEvent(plain);
  });
  assert.equal(sent, 1);
  await act(async () => root.unmount());
  container.remove();
});
