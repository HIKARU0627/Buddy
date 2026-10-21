// 登録の画面と中枢との接続の欄の試験（ADR 0024・0025）。HeroUI の部品をサーバー描画（react-dom/server）で HTML にして、
// 手順ごとの表示・ボタン・読み上げのラベルを確かめる。押したときの要求は、フックを使わない部品を関数として呼び、
// onPress を呼んで確かめる。期待値の文言は手で書く。
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
  normalizeTail,
  pairingActions,
  parsePort,
} from '../../state/connection-state.js';
import type {
  PairingView,
  ShownConnection,
} from '../../state/connection-state.js';
import {
  INITIAL_VIEW_STATE,
  deviceActions,
} from '../../state/desktop-state.js';
import type { DesktopViewState } from '../../state/desktop-state.js';
import { ConnectionSection } from '../device/ConnectionSection.js';
import { FailedStep, WaitingStep } from './PairingPanel.js';
import { PairingScreen, reregistrationCopy } from './PairingScreen.js';

const FP = '0123456789abcdef'.repeat(4);
// 地域時間の 2026-10-21 10:00:00 を「今」にする。
const NOW = new Date(2026, 9, 21, 10, 0, 0).getTime();

const base: ShownConnection = {
  visibility: 'shown',
  registration: 'unregistered',
  link: 'not_connected',
  link_reason: null,
  last_confirmed_at: null,
  retry_at: null,
  pairing: null,
  hub_screen: false,
  hub_target: null,
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
  claim_check: null,
  cancelable: true,
  ...extra,
});

function render(
  connection: ShownConnection,
  extra: Partial<DesktopViewState> = {},
): string {
  return renderToStaticMarkup(
    <AppProviders>
      <PairingScreen
        state={{ ...INITIAL_VIEW_STATE, connection, ...extra }}
        connection={connection}
        actions={deviceActions(null, () => undefined)}
        pairing={pairingActions(() => undefined)}
        now={NOW}
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

const inputValue = (html: string, label: string): string | null => {
  const id = new RegExp(`<label[^>]*for="([^"]+)"[^>]*>${label}`, 'u').exec(
    html,
  )?.[1];
  if (id === undefined) return null;
  return (
    new RegExp(`<input[^>]*id="${id}"[^>]*value="([^"]*)"`, 'u').exec(
      html,
    )?.[1] ??
    new RegExp(`<input[^>]*value="([^"]*)"[^>]*id="${id}"`, 'u').exec(
      html,
    )?.[1] ??
    null
  );
};

test('an unregistered device starts at step 1 with the address and the stop button on top', () => {
  const html = render(base);
  assert.match(
    html,
    /<h2 id="pairing-heading"[^>]*>この端末を中枢に登録する<\/h2>/u,
  );
  assert.match(html, /<section aria-labelledby="pairing-heading">/u);
  assert.match(html, /手順 1 \/ 4<span[^>]*>中枢の宛先/u);
  assert.match(html, /中枢の宛先/u);
  assert.match(html, /https:\/\/ やパスは付けず、宛先だけを入れます。/u);
  assert.match(html, /■ 入出力を停止/u);
  // 押せないボタンは置かない（押したときに理由を欄の下に出す）。
  assert.match(html, /<button[^>]*>中枢の証明書を受け取る<\/button>/u);
  assert.doesNotMatch(
    html,
    /<button[^>]*disabled[^>]*>中枢の証明書を受け取る/u,
  );
  assert.equal(inputValue(html, 'ポート'), '47443');
});

test('the address form is filled from the last typed target or the hub target', () => {
  const typed = render(base, {
    lastTarget: { host: '100.64.0.20', port: 47999 },
  });
  assert.equal(inputValue(typed, '中枢の宛先'), '100.64.0.20');
  assert.equal(inputValue(typed, 'ポート'), '47999');
  const rereg = render({
    ...base,
    registration: 'reregistration_required',
    link: 'reregistration_required',
    link_reason: 'certificate_mismatch',
    hub_target: { host: '100.64.0.30', port: 47443 },
  });
  assert.equal(inputValue(rereg, '中枢の宛先'), '100.64.0.30');
});

test('the fingerprint is a fixed 4 by 4 grid and the last four digits are asked for', () => {
  const html = render({ ...base, pairing: pairingAt('fingerprint_check') });
  assert.match(html, /手順 2 \/ 4<span[^>]*>指紋の確認/u);
  assert.match(
    html,
    /<p id="pairing-fingerprint"[^>]*>中枢の証明書の指紋（SHA-256・64 桁）<\/p>/u,
  );
  const groups = [
    ...html.matchAll(
      /<ol aria-labelledby="pairing-fingerprint"[^>]*>(.*?)<\/ol>/gu,
    ),
  ][0]?.[1];
  assert.deepEqual(
    [...(groups ?? '').matchAll(/<li[^>]*>([^<]*)<\/li>/gu)].map((m) => m[1]),
    [
      '0123',
      '4567',
      '89ab',
      'cdef',
      '0123',
      '4567',
      '89ab',
      'cdef',
      '0123',
      '4567',
      '89ab',
      'cdef',
      '0123',
      '4567',
      '89ab',
      'cdef',
    ],
  );
  assert.match(html, /中枢の画面の指紋の最後の 4 桁/u);
  assert.match(html, /一致しないときは申請を送りません。/u);
  assert.match(html, /最後の 4 桁を確かめて次へ/u);
  assert.match(html, /一致しない（やめる）/u);
  assert.doesNotMatch(html, /ワンタイムコード/u);
});

test('a tail rejected by main is shown under the tail field', () => {
  const html = render(
    { ...base, pairing: pairingAt('fingerprint_check') },
    {
      message: {
        channel: 'desktop.pairing_confirm',
        text: '中枢の画面の指紋と違います。宛先が正しいか確かめてください。',
      },
    },
  );
  assert.match(html, /data-invalid="true"/u);
  assert.match(
    html,
    /中枢の画面の指紋の最後の 4 桁.*中枢の画面の指紋と違います。宛先が正しいか確かめてください。/u,
  );
});

test('confirm sends the shown fingerprint and the typed tail; nothing else decides', () => {
  const sent: DesktopIpcRequest[] = [];
  const actions = pairingActions((built) => sent.push(built));
  actions.confirm(FP, 'cdef');
  actions.cancel();
  assert.deepEqual(
    sent.map((request) => [request.channel, request.payload]),
    [
      [
        'desktop.pairing_confirm',
        { fingerprint: FP, fingerprint_tail: 'cdef' },
      ],
      ['desktop.pairing_cancel', null],
    ],
  );
});

test('code entry uses an eight digit one-time code field and asks for the device name', () => {
  const code = render({ ...base, pairing: pairingAt('code_entry') });
  assert.match(code, /手順 3 \/ 4<span[^>]*>コードの入力/u);
  assert.match(
    code,
    /<label[^>]*id="pairing-code-label"[^>]*>ワンタイムコード<\/label>/u,
  );
  assert.match(code, /aria-labelledby="pairing-code-label"/u);
  assert.match(
    code,
    /autoComplete="one-time-code"|autocomplete="one-time-code"/u,
  );
  assert.match(code, /maxLength="8"|maxlength="8"/u);
  assert.match(code, /この端末の名前/u);
  assert.match(code, /申請する/u);
});

test('waiting shows the claim check and the deadline with time left', () => {
  const expires = new Date(2026, 9, 21, 10, 5, 0).toISOString();
  const html = render(
    {
      ...base,
      pairing: pairingAt('waiting_approval', {
        claim_expires_at: expires,
        claim_check: 'cafe5aa9',
      }),
    },
    { submittedName: '合成の端末' },
  );
  assert.match(html, /手順 4 \/ 4<span[^>]*>承認待ち/u);
  assert.match(
    html,
    /role="status"[^>]*>(<[^>]+>)*中枢での承認を待っています…/u,
  );
  assert.match(html, /中枢の画面で「合成の端末」の申請を承認してください。/u);
  assert.match(html, /cafe 5aa9/u);
  assert.match(html, /10:05 まで（残り 5 分）/u);
  const sent: DesktopIpcRequest[] = [];
  pressables(
    WaitingStep({
      pairing: pairingAt('waiting_approval'),
      deviceName: null,
      now: NOW,
      actions: pairingActions((built) => sent.push(built)),
    }),
  ).get('申請をやめる')?.();
  assert.deepEqual(
    sent.map((request) => request.channel),
    ['desktop.pairing_cancel'],
  );
});

test('a failure gives what happened and what to do, with one action', () => {
  const failed = render({
    ...base,
    pairing: pairingAt('failed', { failure: 'pickup_unknown' }),
  });
  assert.match(failed, /role="alert"/u);
  assert.match(failed, /登録が済んだか確かめられませんでした/u);
  assert.match(failed, /自動ではやり直しません。/u);
  assert.doesNotMatch(failed, /手順 \d/u);
  const sent: DesktopIpcRequest[] = [];
  pressables(
    FailedStep({
      pairing: pairingAt('failed', { failure: 'pickup_unknown' }),
      actions: pairingActions((built) => sent.push(built)),
    }),
  ).get('失効したので、もう一度登録する')?.();
  assert.deepEqual(
    sent.map((request) => request.channel),
    ['desktop.pairing_cancel'],
  );
  const changed = render({
    ...base,
    pairing: pairingAt('failed', { failure: 'certificate_changed' }),
  });
  assert.match(changed, /中枢の証明書が変わったため、申請を送りませんでした/u);
  const storage = render({
    ...base,
    registration: 'secure_storage_unavailable',
  });
  assert.match(storage, /この端末では登録できません/u);
  assert.doesNotMatch(storage, /中枢の証明書を受け取る/u);
});

test('reregistration explains why first; a changed certificate is a danger alert', () => {
  const mismatch = reregistrationCopy({
    ...base,
    registration: 'reregistration_required',
    link_reason: 'certificate_mismatch',
  });
  assert.equal(mismatch.status, 'danger');
  assert.equal(mismatch.title, '中枢の証明書が、登録したときと変わりました');
  assert.match(mismatch.body, /新しい指紋を中枢の画面と必ず比べてください。/u);
  const revoked = reregistrationCopy({
    ...base,
    registration: 'reregistration_required',
    link_reason: 'device_revoked',
  });
  assert.equal(revoked.status, 'warning');
  assert.equal(revoked.title, 'この端末は中枢で失効しました');
  const html = render({
    ...base,
    registration: 'reregistration_required',
    link: 'reregistration_required',
    link_reason: 'device_revoked',
  });
  assert.match(html, /この端末は中枢で失効しました.*この端末を中枢に登録する/u);
});

test('the connection section shows reason, home check and operations without secrets', () => {
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
      <ConnectionSection connection={connected} />
    </AppProviders>,
  );
  assert.match(html, /<h2[^>]*>中枢との接続<\/h2>/u);
  assert.match(html, /● 自宅のネットワークです/u);
  assert.match(html, /結果不明（保留）/u);
  assert.match(html, /00000000-0000-4000-8000-000000000501/u);
  assert.match(html, /版 4・内容版 1/u);
  assert.doesNotMatch(html, /abab/u);
  const outside = renderToStaticMarkup(
    <AppProviders>
      <ConnectionSection
        connection={{
          ...connected,
          link: 'waiting_retry',
          link_reason: 'outside_home_network',
          retry_at: '2030-10-01T00:00:02Z',
          home_network: {
            allowed: false,
            exempt: false,
            reasons: ['gateway_mac_mismatch'],
            reported_at: '2030-10-01T00:00:00Z',
          },
          operations: [],
        }}
      />
    </AppProviders>,
  );
  assert.match(outside, /<dt[^>]*>理由<\/dt>/u);
  assert.match(outside, /○ 自宅のネットワークではありません/u);
  assert.doesNotMatch(outside, /中枢の操作/u);
  const exempt = renderToStaticMarkup(
    <AppProviders>
      <ConnectionSection
        connection={{
          ...connected,
          home_network: {
            allowed: true,
            exempt: true,
            reasons: [],
            reported_at: '2030-10-01T00:00:00Z',
          },
        }}
      />
    </AppProviders>,
  );
  assert.match(exempt, /中枢と同じマシンのため、判定は不要です/u);
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
  assert.equal(normalizeTail(' C7A6 '), 'c7a6');
  assert.equal(normalizeTail('c7 a6'), 'c7a6');
  assert.equal(normalizeTail('c7a'), null);
  assert.equal(normalizeTail('c7a60'), null);
  assert.equal(normalizeTail('g7a6'), null);
  assert.equal(normalizeTail(''), null);
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

// 受取りの要求の最中（cancelable が false）は「申請をやめる」を押せない（PR #73 のレビューの指摘 M2）。
test('the withdraw button is disabled while the pickup is in flight', () => {
  const withdraw = (markup: string) =>
    [...markup.matchAll(/<button\b[^>]*>(?:(?!<\/button>).)*<\/button>/gsu)]
      .map((match) => match[0])
      .find((button) => button.includes('申請をやめる'));
  const waiting = (cancelable: boolean) =>
    render({ ...base, pairing: pairingAt('waiting_approval', { cancelable }) });
  const enabled = withdraw(waiting(true));
  const disabled = withdraw(waiting(false));
  assert(enabled !== undefined && disabled !== undefined);
  assert.doesNotMatch(enabled, /\sdisabled=""/u);
  assert.match(disabled, /\sdisabled=""/u);
});

test('a hub address main does not allow is shown under the address field', () => {
  const html = render(base, {
    message: {
      channel: 'desktop.pairing_begin',
      text: 'Tailscale のアドレス（100.x.x.x）か、〜.ts.net の名前を入れてください。',
    },
    lastTarget: { host: '192.168.0.10', port: 47443 },
  });
  assert.match(
    html,
    /中枢の宛先.*data-invalid="true".*Tailscale のアドレス（100\.x\.x\.x）か、〜\.ts\.net の名前を入れてください。/su,
  );
  assert.doesNotMatch(html, /role="alert"/u);
});
