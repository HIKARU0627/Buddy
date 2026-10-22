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
import { REJECT_MESSAGES } from '../../labels.js';
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

const html = (node: ReactNode) =>
  renderToStaticMarkup(<AppProviders>{node}</AppProviders>);

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
  assert.match(html, /手順 1 \/ 4<span[^>]*>宛先の入力/u);
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

test('the fingerprint is a fixed 4 by 4 grid with the last group masked, and the last four digits are asked for', () => {
  const html = render({ ...base, pairing: pairingAt('fingerprint_check') });
  assert.match(html, /手順 2 \/ 4<span[^>]*>指紋の確認/u);
  assert.match(
    html,
    /<p id="pairing-fingerprint"[^>]*>中枢の証明書の指紋（SHA-256・64\u00a0桁）<\/p>/u,
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
      '····',
    ],
  );
  // 入力させる最後の 4 桁（cdef）は、この画面のどこにも出さない（中枢の画面から読む。R1-H1）。
  const lastRow =
    /<li[^>]*>0123<\/li><li[^>]*>4567<\/li><li[^>]*>89ab<\/li><li[^>]*>····<\/li><\/ol>/u;
  assert.match(html, lastRow);
  assert.match(
    html,
    /<li aria-label="最後の 4\u00a0桁は伏せています（中枢の画面で読みます）"[^>]*>····<\/li>/u,
  );
  assert.match(
    html,
    /最後の 4\u00a0桁はこの画面では伏せています。中枢の画面から読んで入力してください。/u,
  );
  assert.doesNotMatch(html, /64\u00a0桁すべてが同じ/u);
  // 入力は 4 桁の InputOTP（16 進）。
  assert.match(
    html,
    /<label[^>]*id="pairing-tail-label"[^>]*>中枢の画面の指紋の最後の 4\u00a0桁<\/label>/u,
  );
  assert.match(html, /aria-labelledby="pairing-tail-label"/u);
  assert.match(html, /maxLength="4"|maxlength="4"/u);
  assert.match(html, /pattern="\^\[0-9a-fA-F\]\*\$"/u);
  assert.match(html, /一致しないときは申請を送りません。/u);
  assert.match(html, /最後の 4\u00a0桁を確かめて次へ/u);
  assert.match(html, /一致しない（やめる）/u);
  assert.doesNotMatch(html, /ワンタイムコード/u);
});

test('a tail rejected by main is a warning with a symbol above the buttons, saying nothing was sent and what may be wrong', () => {
  const html = render(
    { ...base, pairing: pairingAt('fingerprint_check') },
    {
      message: {
        channel: 'desktop.pairing_confirm',
        text: REJECT_MESSAGES.fingerprint_tail_mismatch,
      },
    },
  );
  // 記号付きの warning の Alert（text-sm）を、ボタンより上に出す（R1-M3）。
  assert.match(
    html,
    /alert--warning[^>]*role="alert".*alert__indicator.*text-sm[^"]*" data-slot="alert-description">入力した 4\u00a0桁が、この端末が受け取った中枢の証明書と合いません。申請はまだ送っていません。打ち間違いでなければ、別の機器につながっているおそれがあります。.*最後の 4\u00a0桁を確かめて次へ/su,
  );
  // 合わなかったときも、最後の組は伏せたまま。
  assert.doesNotMatch(html, /cdef<\/li><\/ol>/u);
});

test('step 1 and 2 say what to do on the hub screen first; the one-time fields are marked required', () => {
  const address = render(base);
  assert.match(
    address,
    /先に中枢の画面の「端末の登録」で「ペアリングを始める（コードを出す）」を押してください。宛先・指紋・コードはそこに出ます。/u,
  );
  const fingerprint = render({
    ...base,
    pairing: pairingAt('fingerprint_check'),
  });
  assert.match(
    fingerprint,
    /中枢の画面の「新しい端末を登録する」に出ている指紋と、1\u00a0行ずつ見比べてください/u,
  );
  // InputOTP の欄にも必須の印（読み上げは「必須」）を付ける（R2 の低 1）。
  assert.match(
    fingerprint,
    /<label[^>]*label--required[^>]*id="pairing-tail-label"|<label[^>]*id="pairing-tail-label"[^>]*label--required/u,
  );
  const code = render({ ...base, pairing: pairingAt('code_entry') });
  assert.match(
    code,
    /<label[^>]*label--required[^>]*id="pairing-code-label"|<label[^>]*id="pairing-code-label"[^>]*label--required/u,
  );
  assert.match(code, /aria-required="true"/u);
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
  assert.match(html, /10:05 まで（残り 5\u00a0分）/u);
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
  assert.match(failed, /alert--warning/u);
  assert.match(failed, /登録が済んだか確かめられませんでした/u);
  assert.match(failed, /自動ではやり直しません。/u);
  // 失敗の画面でも、どの手順で止まったかを残す。
  assert.match(failed, /手順 4 \/ 4<span[^>]*>承認待ち/u);
  const sent: DesktopIpcRequest[] = [];
  const named = FailedStep({
    pairing: pairingAt('failed', { failure: 'pickup_unknown' }),
    deviceName: '合成の端末',
    actions: pairingActions((built) => sent.push(built)),
  });
  // 案内に申請した端末名を入れる（中枢の画面の「このマシン」と取り違えない。R1-M6）。
  assert.match(
    html(named),
    /「登録済みの端末」に「合成の端末」があれば失効してから/u,
  );
  pressables(named).get('確かめたので、もう一度登録する')?.();
  assert.deepEqual(
    sent.map((request) => request.channel),
    ['desktop.pairing_cancel'],
  );
  const changed = render({
    ...base,
    pairing: pairingAt('failed', { failure: 'certificate_changed' }),
  });
  assert.match(changed, /中枢の証明書が変わったため、申請を送りませんでした/u);
  // 証明書が変わったときだけ danger、ほかの失敗は warning。記号（⚠）を付ける。
  assert.match(changed, /alert--danger/u);
  assert.match(changed, /alert__indicator/u);
  // 接続できないときは、試した宛先を出す。
  const unreachable = render({
    ...base,
    pairing: pairingAt('failed', { failure: 'certificate_unavailable' }),
  });
  assert.match(
    unreachable,
    /<span class="font-mono">100\.64\.0\.10:47443<\/span>に接続できませんでした。/u,
  );
  assert.match(unreachable, /手順 1 \/ 4/u);
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
  assert.match(html, /alert__indicator/u);
  // 登録し直している途中は 1 行に縮め、失敗したときは上の警告を出さない（失敗の Alert だけ）。
  const progressing = render({
    ...base,
    registration: 'reregistration_required',
    link: 'reregistration_required',
    link_reason: 'certificate_mismatch',
    pairing: pairingAt('waiting_approval'),
  });
  assert.match(
    progressing,
    /中枢の証明書が変わったため、登録し直しています。/u,
  );
  assert.doesNotMatch(progressing, /覚えがなければ/u);
  const failedAgain = render({
    ...base,
    registration: 'reregistration_required',
    link: 'reregistration_required',
    link_reason: 'certificate_mismatch',
    pairing: pairingAt('failed', { failure: 'claim_expired' }),
  });
  assert.doesNotMatch(
    failedAgain,
    /中枢の証明書が、登録したときと変わりました/u,
  );
  // 失敗の画面でも、なぜ登録し直しているかを 1 行で残す（R1-L8）。上端の帯は「再登録が必要」（R1-L9）。
  assert.match(
    failedAgain,
    /中枢の証明書が変わったため、登録し直しています。/u,
  );
  assert.match(failedAgain, /この端末（再登録が必要）/u);
  assert.match(failedAgain, /申請の期限が切れました/u);
  // 証明書が変わった失敗は、失敗の Alert と同じことを言うので 1 行も出さない。
  const changedAgain = render({
    ...base,
    registration: 'reregistration_required',
    link: 'reregistration_required',
    link_reason: 'certificate_mismatch',
    pairing: pairingAt('failed', { failure: 'certificate_changed' }),
  });
  assert.doesNotMatch(changedAgain, /登録し直しています/u);
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
        ref: '00000000-0000-4000-8000-000000000501',
        operation_kind: 'mail.labels.change',
        state_revision: '4',
        state: 'unknown_held',
        approval_state: 'valid',
        allowed_actions: ['reconcile'],
        result: null,
        delivery_unknown: false,
      },
    ],
  };
  const html = renderToStaticMarkup(
    <AppProviders>
      <ConnectionSection connection={connected} />
    </AppProviders>,
  );
  assert.match(html, /<h2[^>]*>中枢との接続<\/h2>/u);
  assert.match(
    html,
    /text-success-soft-foreground">●<\/span><span>自宅のネットワークです<\/span>/u,
  );
  // 操作の一覧は会話の画面の処理状況に出す（B04-05）。接続の欄には出さず、参照・版も出さない。
  assert.doesNotMatch(html, /結果不明|中枢で進んでいる操作/u);
  assert.doesNotMatch(html, /00000000-0000-4000-8000-000000000501/u);
  assert.doesNotMatch(html, /版 4|内容版/u);
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
  assert.match(
    outside,
    /text-warning-soft-foreground">○<\/span><span>自宅のネットワークではありません/u,
  );
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
