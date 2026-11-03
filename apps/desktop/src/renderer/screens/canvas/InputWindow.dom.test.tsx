// 入力バーの聞き返し（UI-08、ADR 0067）。送信の応答を待つ間に下書きを編集したら、古い依頼の聞き返しを
// 新しい下書きの上に出さない。happy-dom の文書に React で描き、遅らせた応答で確かめる。
import { happy } from '../../test-support/happy-dom.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  DesktopIpcRequest,
  DesktopIpcResponse,
  DesktopStatusBar,
} from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import type { BuddyDesktopApi } from '../../desktop-api.js';
import { RoleWindow } from './RoleWindow.js';

after(async () => {
  await happy.happyDOM.close();
});

const status: DesktopStatusBar = {
  visibility: 'shown',
  lock_state: 'unlocked',
  stop_scope: 'none',
  input_permitted: true,
  io_epoch: '0',
  voice_state: null,
  hub_connection: 'connected',
  hub_last_confirmed_at: null,
  display_target: null,
  storage_mode: null,
  budget_held: null,
  safety_stopped: null,
};

const id = '00000000-0000-4000-8000-000000000001';

function setValue(field: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    happy.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(field, value);
  field.dispatchEvent(
    new happy.Event('input', { bubbles: true }) as unknown as Event,
  );
}

test('a clarification that returns after the draft changed is not shown', async () => {
  let resolveTurn: (response: DesktopIpcResponse) => void = () => undefined;
  const pending = new Promise<DesktopIpcResponse>((resolve) => {
    resolveTurn = resolve;
  });
  const api: BuddyDesktopApi = {
    windowRole: 'input',
    stopShortcut: null,
    invoke: (request: DesktopIpcRequest) => {
      if (request.channel === 'desktop.get_state')
        return Promise.resolve({
          request_id: request.request_id,
          channel: request.channel,
          outcome: 'ok',
          status,
        } as DesktopIpcResponse);
      if (request.channel === 'desktop.turn_submit') return pending;
      return Promise.resolve({
        request_id: request.request_id,
        channel: request.channel,
        outcome: 'ok',
      } as DesktopIpcResponse);
    },
    onNotification: () => () => undefined,
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AppProviders>
        <RoleWindow api={api} role="input" />
      </AppProviders>,
    );
  });
  await act(async () => undefined);
  const field = container.querySelector('textarea');
  assert(field !== null);
  await act(async () => setValue(field, '古い依頼'));
  await act(async () => {
    field.dispatchEvent(
      new happy.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }) as unknown as Event,
    );
  });
  // 応答を待つ間に下書きを編集する。
  await act(async () => setValue(field, '新しい下書き'));
  await act(async () => {
    resolveTurn({
      request_id: id,
      channel: 'desktop.turn_submit',
      outcome: 'ok',
      turn: {
        status: 'clarification',
        reply_text: '古い依頼についての質問',
        result: null,
      },
    });
    await pending;
  });
  assert.doesNotMatch(container.textContent ?? '', /古い依頼についての質問/u);
  assert.doesNotMatch(container.textContent ?? '', /古い依頼/u);
  await act(async () => root.unmount());
  container.remove();
});
