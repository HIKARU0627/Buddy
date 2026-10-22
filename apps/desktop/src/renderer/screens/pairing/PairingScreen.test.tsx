// ペアリングの画面と接続の欄の試験（ADR 0024・0025）。HeroUI の部品をサーバー描画（react-dom/server）で HTML にして、
// 手順ごとの表示・ボタン・読み上げのラベルを確かめる。押したときの要求は onPress を呼んで確かめる。期待値の文言は手で書く。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DesktopIpcRequest } from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import {
  needsPairing,
  normalizeCode,
  normalizeDeviceName,
  normalizeHost,
  pairingActions,
  parsePort,
} from '../../state/connection-state.js';
import type {
  PairingView,
  ShownConnection,
} from '../../state/connection-state.js';
import { deviceActions } from '../../state/desktop-state.js';
import { ConnectionPanel } from './ConnectionPanel.js';
import { Failed, FingerprintCheck, PAIRING_LABELS } from './PairingPanel.js';
import { PairingScreen } from './PairingScreen.js';

const FP = '0123456789abcdef'.repeat(4);

const base: ShownConnection = {
  visibility: 'shown',
  registration: 'unregistered',
  link: 'not_connected',
  link_reason: null,
  last_confirmed_at: null,
  retry_at: null,
  pairing: null,
  home_network: null,
  operations: [],
};

const pairingAt = (
  step: PairingView['step'],
  extra: Partial<PairingView> = {},
): PairingView => ({
  step,
  host: '100.64.0.10',
  port: 47443,
  fingerprint: step === 'fetching_certificate' ? null : FP,
  claim_expires_at: null,
  failure: null,
  cancelable: true,
  ...extra,
});

function render(connection: ShownConnection): string {
  return renderToStaticMarkup(
    <AppProviders>
      <PairingScreen
        state={{ status: null, powerLog: [], message: null, connection }}
        connection={connection}
        actions={deviceActions(null, () => undefined)}
        pairing={pairingActions(() => undefined)}
      />
    </AppProviders>,
  );
}

function pressables(node: ReactNode): Map<string, () => void> {
  const found = new Map<string, () => void>();
  const walk = (current: ReactNode): void => {
    if (Array.isArray(current)) {
      for (const child of current as ReactNode[]) walk(child);
      return;
    }
    if (!isValidElement(current)) return;
    const props = current.props as { onPress?: unknown; children?: ReactNode };
    if (
      typeof props.onPress === 'function' &&
      typeof props.children === 'string'
    )
      found.set(props.children, props.onPress as () => void);
    walk(props.children);
  };
  walk(node);
  return found;
}

test('an unregistered device is asked for the hub address; the stop button stays on top', () => {
  const html = render(base);
  assert.match(html, /<section aria-label="ペアリング">/u);
  assert.match(html, /この端末を中枢に登録する/u);
  assert.match(html, /中枢の宛先（Tailscale の IP アドレスか名前）/u);
  assert.match(html, /中枢の証明書を受け取る/u);
  assert.match(html, /■ この端末の入出力を停止/u);
  // 宛先が空のうちは受け取りのボタンを押せない。
  assert.match(html, /<button[^>]*disabled[^>]*>中枢の証明書を受け取る/u);
});

test('the fingerprint is shown in groups and confirming sends exactly the shown fingerprint', () => {
  const html = render({ ...base, pairing: pairingAt('fingerprint_check') });
  assert.match(html, /0123 4567 89ab cdef 0123/u);
  assert.match(html, /aria-label="中枢の証明書の指紋（SHA-256）"/u);
  assert.match(html, /✓ 一致（申請に進む）/u);
  assert.match(html, /一致しない（やめる）/u);
  // 申請の欄（コード）はまだ出さない。
  assert.doesNotMatch(html, /ワンタイムコード/u);
  const sent: DesktopIpcRequest[] = [];
  const buttons = pressables(
    FingerprintCheck({
      pairing: pairingAt('fingerprint_check'),
      actions: pairingActions((built) => sent.push(built)),
    }),
  );
  buttons.get('✓ 一致（申請に進む）')?.();
  buttons.get('一致しない（やめる）')?.();
  assert.deepEqual(
    sent.map((request) => [request.channel, request.payload]),
    [
      ['desktop.pairing_confirm', { fingerprint: FP }],
      ['desktop.pairing_cancel', null],
    ],
  );
});

test('code entry, waiting and failure steps show their own texts', () => {
  const code = render({ ...base, pairing: pairingAt('code_entry') });
  assert.match(code, /ワンタイムコード（8 桁）/u);
  assert.match(code, /この端末の名前/u);
  const waiting = render({
    ...base,
    pairing: pairingAt('waiting_approval', {
      claim_expires_at: '2030-10-01T00:05:00Z',
    }),
  });
  assert.match(waiting, /role="status"[^>]*>… 中枢での承認を待っています/u);
  assert.match(waiting, /申請の期限:/u);
  const failed = render({
    ...base,
    pairing: pairingAt('failed', { failure: 'pickup_unknown' }),
  });
  assert.match(failed, /role="alert"/u);
  assert.match(failed, /受取りの結果が分かりません。自動では再送しません。/u);
  const sent: DesktopIpcRequest[] = [];
  pressables(
    Failed({
      pairing: pairingAt('failed', { failure: 'pickup_unknown' }),
      actions: pairingActions((built) => sent.push(built)),
    }),
  ).get('最初からやり直す')?.();
  assert.deepEqual(
    sent.map((request) => request.channel),
    ['desktop.pairing_cancel'],
  );
  const storage = render({
    ...base,
    registration: 'secure_storage_unavailable',
  });
  assert.match(
    storage,
    /安全な保存（OS の鍵束）が使えないため、登録できません。/u,
  );
  assert.doesNotMatch(storage, /中枢の証明書を受け取る/u);
});

// レビューの指摘 M2: 受取りの要求の最中（cancelable が false）は「やめる」を押せない。
test('the cancel button is disabled while the pickup is in flight', () => {
  const cancelButton = (markup: string) =>
    [...markup.matchAll(/<button\b[^>]*>(?:(?!<\/button>).)*<\/button>/gsu)]
      .map((match) => match[0])
      .find((button) => button.includes(PAIRING_LABELS.cancel));
  const waiting = (cancelable: boolean) =>
    render({
      ...base,
      pairing: pairingAt('waiting_approval', { cancelable }),
    });
  const enabled = cancelButton(waiting(true));
  const disabled = cancelButton(waiting(false));
  assert(enabled !== undefined && disabled !== undefined);
  assert.doesNotMatch(enabled, /\sdisabled=""/u);
  assert.match(disabled, /\sdisabled=""/u);
});

test('the connection panel shows link, reason, home check and operations without secrets', () => {
  const connected: ShownConnection = {
    ...base,
    registration: 'registered',
    link: 'connected',
    last_confirmed_at: '2030-10-01T00:00:00Z',
    home_network: {
      allowed: true,
      exempt: false,
      reasons: [],
      reported_at: '2030-10-01T00:00:00Z',
    },
    operations: [
      {
        operation_id: '00000000-0000-4000-8000-000000000501',
        content_version: '1',
        content_hash: 'ab'.repeat(32),
        state_revision: '4',
        state: 'unknown_held',
        approval_state: 'valid',
        allowed_actions: ['reconcile'],
        result: null,
      },
    ],
  };
  const html = renderToStaticMarkup(
    <AppProviders>
      <ConnectionPanel connection={connected} />
    </AppProviders>,
  );
  assert.match(html, /<section aria-label="中枢との接続">/u);
  assert.match(html, /● 接続中/u);
  assert.match(html, /● 自宅のネットワーク/u);
  assert.match(html, /結果不明（保留）/u);
  assert.match(html, /00000000-0000-4000-8000-000000000501/u);
  assert.match(html, /版 4・内容版 1/u);
  const waiting = renderToStaticMarkup(
    <AppProviders>
      <ConnectionPanel
        connection={{
          ...connected,
          link: 'waiting_retry',
          link_reason: 'outside_home_network',
          retry_at: '2030-10-01T00:00:02Z',
          operations: [],
        }}
      />
    </AppProviders>,
  );
  assert.match(waiting, /○ 接続できません（自動で接続し直します）/u);
  assert.match(waiting, /自宅のネットワークの外です/u);
  assert.doesNotMatch(waiting, /中枢の操作/u);
  const revoked = render({
    ...base,
    registration: 'reregistration_required',
    link: 'reregistration_required',
    link_reason: 'device_revoked',
  });
  assert.match(revoked, /この端末は失効しました/u);
  assert.match(revoked, /中枢の証明書を受け取る/u);
});

test('input helpers accept only well-formed values', () => {
  assert.equal(needsPairing(base), true);
  assert.equal(needsPairing({ ...base, registration: 'registered' }), false);
  assert.equal(
    needsPairing({
      ...base,
      registration: 'registered',
      pairing: pairingAt('failed', { failure: 'unreachable' }),
    }),
    true,
  );
  assert.equal(parsePort('47443'), 47443);
  assert.equal(parsePort('0'), null);
  assert.equal(parsePort('70000'), null);
  assert.equal(parsePort('4a'), null);
  assert.equal(normalizeHost(' 100.64.0.10 '), '100.64.0.10');
  assert.equal(normalizeHost('buddy-hub.example'), 'buddy-hub.example');
  assert.equal(normalizeHost('https://100.64.0.10/v1'), null);
  assert.equal(normalizeHost('user@host'), null);
  assert.equal(normalizeHost(''), null);
  assert.equal(normalizeCode('1234 5678'), '12345678');
  assert.equal(normalizeCode('1234-567'), null);
  assert.equal(normalizeDeviceName('  合成の端末  '), '合成の端末');
  assert.equal(normalizeDeviceName('あ'.repeat(41)), null);
  const sent: DesktopIpcRequest[] = [];
  const actions = pairingActions((built) => sent.push(built));
  actions.begin('100.64.0.10', 47443);
  actions.submit('12345678', '合成の端末');
  assert.deepEqual(
    sent.map((request) => [request.channel, request.payload]),
    [
      ['desktop.pairing_begin', { host: '100.64.0.10', port: 47443 }],
      [
        'desktop.pairing_submit',
        { pairing_code: '12345678', device_name: '合成の端末' },
      ],
    ],
  );
});
