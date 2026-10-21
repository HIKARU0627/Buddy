// 中枢の画面の「新しい端末を登録する」「承認待ちの申請」「登録済みの端末」の欄の試験（ADR 0024・0026）。
// サーバー描画（react-dom/server）で表示とボタンを確かめ、押したときは確認（ConfirmRequest）を経て要求を送ることを
// onPress・onConfirm を呼んで確かめる。期待値の文言は手で書く。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DesktopClaimEntry,
  DesktopDeviceEntry,
  DesktopIpcRequest,
  DesktopIpcResponse,
} from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import {
  INITIAL_HUB_STATE,
  applyHubResponse,
  hubActions,
  markSending,
} from '../../state/hub-state.js';
import type { ConfirmRequest } from './ConfirmDialog.js';
import { ClaimsPanel, DevicesPanel, PairingOpenPanel } from './HubPanels.js';

const CLAIM: DesktopClaimEntry = {
  ref: '00000000-0000-4000-8000-000000000d01',
  device_name: '合成の申請',
  platform: 'windows',
  claimed_at: '2030-10-05T00:01:00Z',
  expires_at: '2030-10-05T00:06:00Z',
  claim_check: '0a1b2c3d',
};
const SELF: DesktopDeviceEntry = {
  ref: null,
  device_name: '中枢の端末',
  platform: 'macos',
  hub_local: true,
  this_device: true,
  registered_at: '2030-10-05T00:00:00Z',
  last_seen_at: '2030-10-05T00:10:00Z',
  revoked_at: null,
};
const OTHER: DesktopDeviceEntry = {
  ...SELF,
  ref: '00000000-0000-4000-8000-000000000d02',
  device_name: '合成の端末',
  platform: 'windows',
  hub_local: false,
  this_device: false,
};
const REVOKED: DesktopDeviceEntry = {
  ...OTHER,
  ref: null,
  device_name: '失効した端末',
  revoked_at: '2030-10-05T00:20:00Z',
};

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

function capture() {
  const sent: DesktopIpcRequest[] = [];
  const asked: ConfirmRequest[] = [];
  return {
    sent,
    asked,
    actions: hubActions((built) => sent.push(built)),
    onAsk: (request: ConfirmRequest) => asked.push(request),
  };
}

test('claims: empty, loading and listed claims show the claim check and ask before deciding', () => {
  const { sent, asked, actions, onAsk } = capture();
  assert.match(
    html(
      <ClaimsPanel claims={[]} busy={false} onAsk={onAsk} actions={actions} />,
    ),
    /承認待ちの申請はありません。/u,
  );
  assert.match(
    html(
      <ClaimsPanel
        claims={null}
        busy={false}
        onAsk={onAsk}
        actions={actions}
      />,
    ),
    /読み込んでいます…/u,
  );
  const listed = html(
    <ClaimsPanel
      claims={[CLAIM]}
      busy={false}
      onAsk={onAsk}
      actions={actions}
    />,
  );
  assert.match(listed, /<section aria-label="承認待ちの申請">/u);
  assert.match(listed, /合成の申請/u);
  assert.match(listed, /0a1b 2c3d/u);
  assert.doesNotMatch(listed, /00000000-0000-4000-8000-000000000d01/u);
  const buttons = pressables(
    ClaimsPanel({ claims: [CLAIM], busy: false, onAsk, actions }),
  );
  buttons.get('承認する')?.();
  buttons.get('拒否する')?.();
  // 押しただけでは送らず、確認を出す。
  assert.equal(sent.length, 0);
  assert.deepEqual(
    asked.map((request) => [request.title, request.tone, request.confirmLabel]),
    [
      ['「合成の申請」を承認しますか', 'accent', '承認する'],
      ['「合成の申請」の申請を拒否しますか', 'danger', '拒否する'],
    ],
  );
  for (const request of asked) request.onConfirm();
  assert.deepEqual(
    sent.map((request) => [request.channel, request.payload]),
    [
      ['desktop.claim_decide', { ref: CLAIM.ref, decision: 'approve' }],
      ['desktop.claim_decide', { ref: CLAIM.ref, decision: 'reject' }],
    ],
  );
  // 送っている間はボタンを押せない。
  assert.match(
    html(<ClaimsPanel claims={[CLAIM]} busy onAsk={onAsk} actions={actions} />),
    /<button[^>]*disabled[^>]*>承認する/u,
  );
});

test('devices: this device and revoked devices cannot be revoked; revoking asks first', () => {
  const { sent, asked, actions, onAsk } = capture();
  const listed = html(
    <DevicesPanel
      devices={[SELF, OTHER, REVOKED]}
      busy={false}
      onAsk={onAsk}
      actions={actions}
    />,
  );
  assert.match(listed, /<section aria-label="登録済みの端末">/u);
  assert.match(listed, /この端末/u);
  assert.match(listed, /● 有効/u);
  assert.match(listed, /× 失効済み/u);
  assert.match(listed, /中枢と同じマシン/u);
  // 失効のボタンは他の有効な端末の 1 つだけ。
  assert.equal(listed.match(/>失効する</gu)?.length, 1);
  const buttons = pressables(
    DevicesPanel({
      devices: [SELF, OTHER, REVOKED],
      busy: false,
      onAsk,
      actions,
    }),
  );
  buttons.get('失効する')?.();
  assert.equal(sent.length, 0);
  assert.equal(asked[0]?.title, '「合成の端末」を失効しますか');
  assert.equal(asked[0]?.tone, 'danger');
  asked[0]?.onConfirm();
  assert.deepEqual(
    sent.map((request) => [request.channel, request.payload]),
    [['desktop.device_revoke', { ref: OTHER.ref }]],
  );
});

test('pairing open shows the one-time code and fingerprint only after it is started', () => {
  const { sent, actions } = capture();
  const before = html(
    <PairingOpenPanel session={null} busy={false} actions={actions} />,
  );
  assert.match(before, /ペアリングを始める（コードを出す）/u);
  assert.doesNotMatch(before, /aria-label="ワンタイムコード"/u);
  const after = html(
    <PairingOpenPanel
      session={{
        pairing_code: '12345678',
        certificate_fingerprint: 'ab'.repeat(32),
        expires_at: '2030-10-05T00:05:00Z',
      }}
      busy={false}
      actions={actions}
    />,
  );
  assert.match(after, /aria-label="ワンタイムコード"[^>]*>1234 5678/u);
  assert.match(after, /abab abab/u);
  assert.match(after, /コードを出し直す/u);
  pressables(PairingOpenPanel({ session: null, busy: false, actions })).get(
    'ペアリングを始める（コードを出す）',
  )?.();
  assert.deepEqual(
    sent.map((request) => request.channel),
    ['desktop.pairing_open'],
  );
});

test('hub state: lists replace, rejections only set a message, heavy operations are busy until answered', () => {
  const decide: DesktopIpcRequest = {
    channel: 'desktop.claim_decide',
    request_id: '00000000-0000-4000-8000-000000000d03',
    payload: { ref: CLAIM.ref, decision: 'approve' },
  };
  const busy = markSending(INITIAL_HUB_STATE, decide);
  assert.equal(busy.busy, true);
  const rejected: DesktopIpcResponse = {
    request_id: decide.request_id,
    channel: 'desktop.claim_decide',
    outcome: 'rejected',
    reason: 'outcome_unknown',
  };
  const afterReject = applyHubResponse(busy, 'desktop.claim_decide', rejected);
  assert.equal(afterReject.busy, false);
  assert.match(String(afterReject.message), /自動では送り直しません/u);
  assert.equal(afterReject.claims, null);
  const listed = applyHubResponse(afterReject, 'desktop.claim_decide', {
    request_id: decide.request_id,
    channel: 'desktop.claim_decide',
    outcome: 'ok',
    claims: [CLAIM],
  });
  assert.deepEqual(listed.claims, [CLAIM]);
  assert.equal(listed.message, null);
  // 一覧の取り直しは文言を消さない（操作の結果の文言を残す）。
  const refreshed = applyHubResponse(
    { ...listed, message: '前の文言' },
    'desktop.claims_list',
    {
      request_id: decide.request_id,
      channel: 'desktop.claims_list',
      outcome: 'ok',
      claims: [],
    },
  );
  assert.equal(refreshed.message, '前の文言');
});
