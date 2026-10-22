// 中枢の画面の「新しい端末を登録する」「承認待ちの申請」「登録済みの端末」の欄の試験（ADR 0024・0026）。
// サーバー描画（react-dom/server）で表示とボタンを確かめ、押したときは確認（ConfirmRequest）を経て要求を送ることを
// onPress・onConfirm を呼んで確かめる。状態（hub-state）は純粋な関数として確かめる。期待値の文言は手で書く。
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
  HUB_IPC_FAILURE_MESSAGE,
  INITIAL_HUB_STATE,
  applyHubFailure,
  applyHubResponse,
  clearNotice,
  dropStaleResponse,
  hubActions,
  markSending,
} from '../../state/hub-state.js';
import type {
  HubNotice,
  HubViewState,
  PendingOperation,
} from '../../state/hub-state.js';
import {
  ClaimsPanel,
  DevicesPanel,
  HubTabs,
  PairingOpenPanel,
} from './HubPanels.js';

// 地域時間の 2030-10-05 12:00 を「今」にする。
const NOW = new Date(2030, 9, 5, 12, 0, 0).getTime();
const at = (h: number, m: number, s = 0) =>
  new Date(2030, 9, 5, h, m, s).toISOString();

const CLAIM: DesktopClaimEntry = {
  ref: '00000000-0000-4000-8000-000000000d01',
  device_name: '合成の申請',
  platform: 'windows',
  claimed_at: at(11, 58, 30),
  expires_at: at(12, 3, 30),
  claim_check: '0a1b2c3d',
};
const SELF: DesktopDeviceEntry = {
  ref: null,
  device_name: '中枢の端末',
  platform: 'macos',
  hub_local: true,
  this_device: true,
  registered_at: at(9, 0),
  last_seen_at: at(11, 59),
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
  revoked_at: at(10, 0),
};
const SESSION = {
  pairing_code: '12345678',
  certificate_fingerprint: 'ab'.repeat(30) + 'c1c2',
  // コードを出したのは 11:58（期限の 5 分前）。
  expires_at: at(12, 3),
  hub_endpoint: { host: '100.64.0.1', port: 47443 },
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
  const operations: (PendingOperation | undefined)[] = [];
  let state: HubViewState = INITIAL_HUB_STATE;
  return {
    sent,
    operations,
    state: () => state,
    actions: hubActions({
      request: (built, operation) => {
        sent.push(built);
        operations.push(operation);
      },
      update: (change) => {
        state = change(state);
      },
    }),
  };
}

const notice = (
  pane: 'claims' | 'devices',
  ref: string,
  text: string,
): HubNotice => ({
  pane,
  place: { kind: 'row', ref },
  tone: 'warning',
  text,
});

test('claims: empty, loading and listed claims show the claim check prominently; pressing sends to main, which asks with the OS dialog', () => {
  const { sent, operations, actions } = capture();
  const props = { busy: false, now: NOW, notice: null, actions };
  assert.match(
    html(<ClaimsPanel {...props} claims={[]} />),
    /承認待ちの申請はありません。/u,
  );
  assert.match(
    html(<ClaimsPanel {...props} claims={null} />),
    /読み込んでいます…/u,
  );
  const listed = html(<ClaimsPanel {...props} claims={[CLAIM]} />);
  assert.match(listed, /<section aria-labelledby="hub-claims-heading"/u);
  assert.match(listed, /合成の申請/u);
  // 確認コードはワンタイムコード（text-xl）より大きい text-2xl の太字の等幅。
  assert.match(
    listed,
    /<span class="font-mono text-2xl font-semibold[^"]*">0a1b 2c3d<\/span>/u,
  );
  // 見比べる説明は欄に 1 回だけ（行は時刻だけ）。
  assert.match(listed, /8\u00a0桁すべて同じ申請だけを承認してください。/u);
  assert.match(listed, /申請 11:58:30・12:03 まで/u);
  // 拒否は承認より軽い見た目（tertiary・文字だけ danger の色）。
  assert.match(
    listed,
    /button--tertiary text-danger-soft-foreground[^>]*>拒否する/u,
  );
  assert.match(listed, /aria-label="「合成の申請」の申請を承認する"/u);
  assert.match(listed, /aria-label="「合成の申請」の申請を拒否する"/u);
  assert.match(listed, /一覧を更新/u);
  assert.doesNotMatch(listed, /00000000-0000-4000-8000-000000000d01/u);
  const buttons = pressables(ClaimsPanel({ ...props, claims: [CLAIM] }));
  buttons.get('承認する')?.();
  buttons.get('拒否する')?.();
  // 画面の中では確認しない（本人の確認は main が OS の確認ダイアログで行う。ADR 0026）。
  assert.deepEqual(
    sent.map((request) => [request.channel, request.payload]),
    [
      ['desktop.claim_decide', { ref: CLAIM.ref, decision: 'approve' }],
      ['desktop.claim_decide', { ref: CLAIM.ref, decision: 'reject' }],
    ],
  );
  assert.deepEqual(
    operations.map((operation) => [operation?.name, operation?.verb]),
    [
      ['合成の申請', '承認'],
      ['合成の申請', '拒否'],
    ],
  );
  // 送っている間はボタンを押せない。
  assert.match(
    html(<ClaimsPanel {...props} claims={[CLAIM]} busy />),
    /<button[^>]*disabled[^>]*>承認する/u,
  );
});

test('a failed operation is shown under the row that was pressed, and only there', () => {
  const { actions } = capture();
  const text = '中枢に「合成の申請」の承認を送れませんでした。';
  const listed = html(
    <ClaimsPanel
      claims={[CLAIM, { ...CLAIM, ref: 'other', device_name: '別の申請' }]}
      busy={false}
      now={NOW}
      notice={notice('claims', CLAIM.ref, text)}
      actions={actions}
    />,
  );
  // 押した行（合成の申請）の中、次の行（別の申請）より前に出る。
  assert.match(
    listed,
    /合成の申請.*role="alert"[^>]*>中枢に「合成の申請」の承認を送れませんでした。.*別の申請/su,
  );
  assert.equal(listed.match(/role="alert"/gu)?.length, 1);
  // 他の欄（登録済みの端末）には出さない。
  const devices = html(
    <DevicesPanel
      devices={[SELF, OTHER]}
      busy={false}
      now={NOW}
      notice={notice('claims', CLAIM.ref, text)}
      actions={actions}
    />,
  );
  assert.doesNotMatch(devices, /role="alert"/u);
});

test('devices: the hub machine and revoked devices cannot be revoked; revoked is a muted circle; revoking sends to main', () => {
  const { sent, actions } = capture();
  const props = {
    devices: [SELF, OTHER, REVOKED],
    busy: false,
    now: NOW,
    notice: null,
    actions,
  };
  const listed = html(<DevicesPanel {...props} />);
  assert.match(listed, /<section aria-labelledby="hub-devices-heading"/u);
  assert.match(listed, /<span>中枢（このマシン）<\/span>/u);
  assert.match(listed, /<span>有効<\/span>/u);
  assert.match(listed, /text-muted">○<\/span><span>失効済み<\/span>/u);
  assert.doesNotMatch(listed, /text-danger/u);
  assert.match(listed, /中枢と同じマシン/u);
  // 登録の時刻は今日でも日付を付ける（同じ名前の端末を見分ける手がかり）。
  assert.match(listed, /登録 10\/5 09:00:00/u);
  // 失効のボタンは他の有効な端末の 1 つだけ。
  assert.equal(listed.match(/>失効する</gu)?.length, 1);
  assert.match(listed, /aria-label="「合成の端末」を失効する"/u);
  pressables(DevicesPanel(props)).get('失効する')?.();
  assert.deepEqual(
    sent.map((request) => [request.channel, request.payload]),
    [['desktop.device_revoke', { ref: OTHER.ref }]],
  );
});

test('pairing open shows the code smaller than the claim check, the fingerprint with the last group underlined, and hides used or expired codes', () => {
  const { sent, actions } = capture();
  const base = {
    sessionUsed: false,
    busy: false,
    now: NOW,
    notice: null,
    actions,
  };
  const before = html(<PairingOpenPanel {...base} session={null} />);
  assert.match(before, /ペアリングを始める（コードを出す）/u);
  assert.doesNotMatch(before, /hub-open-code/u);
  const after = html(<PairingOpenPanel {...base} session={SESSION} />);
  assert.match(
    after,
    /<dd id="hub-open-code" class="font-mono text-xl[^"]*">1234 5678/u,
  );
  assert.match(after, /登録する端末に入力する 8\u00a0桁/u);
  assert.match(after, /12:03 まで（残り 3\u00a0分）/u);
  assert.equal(after.match(/<li[^>]*>abab<\/li>/gu)?.length, 15);
  assert.match(
    after,
    /<li aria-label="最後の 4\u00a0桁 c1c2" class="[^"]*underline[^"]*">c1c2<\/li>/u,
  );
  assert.match(
    after,
    /下線の最後の 4\u00a0桁を、登録する端末に入力してもらいます/u,
  );
  assert.match(after, /コードを出し直す/u);
  // p 要素に aria-label・aria-labelledby を付けない（名前を付けられない役割のため）。
  assert.doesNotMatch(after, /<p[^>]*aria-label/u);
  const used = html(
    <PairingOpenPanel {...base} session={SESSION} sessionUsed />,
  );
  assert.doesNotMatch(used, /1234 5678/u);
  assert.match(used, /このコードは申請に使われました/u);
  const expired = html(
    <PairingOpenPanel
      {...base}
      session={SESSION}
      now={new Date(2030, 9, 5, 12, 3, 0).getTime()}
    />,
  );
  assert.doesNotMatch(expired, /1234 5678/u);
  assert.match(expired, /このコードは期限が切れました。/u);
  pressables(PairingOpenPanel({ ...base, session: null })).get(
    'ペアリングを始める（コードを出す）',
  )?.();
  assert.deepEqual(
    sent.map((request) => request.channel),
    ['desktop.pairing_open'],
  );
});

const decide: DesktopIpcRequest = {
  channel: 'desktop.claim_decide',
  request_id: '00000000-0000-4000-8000-000000000d03',
  payload: { ref: CLAIM.ref, decision: 'approve' },
};
const approving: PendingOperation = {
  channel: 'desktop.claim_decide',
  ref: CLAIM.ref,
  name: '合成の申請',
  verb: '承認',
};
const rejected = (
  channel: DesktopIpcRequest['channel'],
  reason: Extract<DesktopIpcResponse, { outcome: 'rejected' }>['reason'],
): DesktopIpcResponse => ({
  request_id: decide.request_id,
  channel,
  outcome: 'rejected',
  reason,
});

test('hub state: an operation failure names the row and the operation, and does not resend', () => {
  const sending = markSending(
    { ...INITIAL_HUB_STATE, claims: [CLAIM] },
    decide,
    approving,
  );
  assert.deepEqual(sending.pending, approving);
  for (const [reason, text] of [
    [
      'not_connected',
      '中枢に「合成の申請」の承認を送れませんでした。中枢との接続が戻ってから、もう一度押してください。自動では送り直しません。',
    ],
    [
      'outcome_unknown',
      '中枢に「合成の申請」の承認が届いたか確かめられませんでした。自動では送り直しません。「一覧を更新」を押して、結果を確かめてください。',
    ],
    [
      'entry_not_found',
      '一覧が古いため、「合成の申請」の承認ができませんでした。「一覧を更新」を押してから、もう一度操作してください。',
    ],
  ] as const) {
    const after = applyHubResponse(
      sending,
      'desktop.claim_decide',
      rejected('desktop.claim_decide', reason),
    );
    assert.equal(after.pending, null);
    assert.deepEqual(after.notice, notice('claims', CLAIM.ref, text));
    // 一覧は変えない。
    assert.deepEqual(after.claims, [CLAIM]);
  }
  // main と通信できない（invoke の失敗）も、押した行に出す。
  assert.deepEqual(
    applyHubFailure(sending, 'desktop.claim_decide').notice,
    notice('claims', CLAIM.ref, HUB_IPC_FAILURE_MESSAGE),
  );
});

test('hub state: applied but the list could not be refreshed is a success that removes the row', () => {
  const sending = markSending(
    { ...INITIAL_HUB_STATE, claims: [CLAIM] },
    decide,
    approving,
  );
  const after = applyHubResponse(sending, 'desktop.claim_decide', {
    request_id: decide.request_id,
    channel: 'desktop.claim_decide',
    outcome: 'ok',
    list_seq: 1,
    list_refreshed: false,
  });
  assert.deepEqual(after.claims, []);
  assert.equal(after.pending, null);
  assert.deepEqual(after.notice, {
    pane: 'claims',
    place: { kind: 'section' },
    tone: 'success',
    text: '中枢で「合成の申請」を承認しました。一覧を更新できなかったため、「一覧を更新」を押して確かめてください。',
  });
  // 失効なら、その端末の失効のボタン（参照）を外す。
  const revoking = markSending(
    { ...INITIAL_HUB_STATE, devices: [SELF, OTHER] },
    {
      channel: 'desktop.device_revoke',
      request_id: decide.request_id,
      payload: { ref: OTHER.ref ?? '' },
    },
    {
      channel: 'desktop.device_revoke',
      ref: OTHER.ref,
      name: '合成の端末',
      verb: '失効',
    },
  );
  const revoked = applyHubResponse(revoking, 'desktop.device_revoke', {
    request_id: decide.request_id,
    channel: 'desktop.device_revoke',
    outcome: 'ok',
    list_seq: 2,
    list_refreshed: false,
  });
  assert.equal(revoked.devices?.[1]?.ref, null);
  // 一覧は未更新でも、その行は失効済みとして出す（「有効」のまま残さない。R1-L5）。
  assert.equal(typeof revoked.devices?.[1]?.revoked_at, 'string');
  assert.equal(revoked.notice?.pane, 'devices');
});

test('hub state: lists replace, polling keeps an operation notice, refresh and tab switch clear it', () => {
  const failed: HubViewState = {
    ...INITIAL_HUB_STATE,
    claims: [CLAIM],
    notice: notice('claims', CLAIM.ref, '前の文言'),
  };
  // 定期の取り直しでは、操作の文言を消さない（3 秒で消えないように）。
  const polled = applyHubResponse(failed, 'desktop.claims_list', {
    request_id: decide.request_id,
    channel: 'desktop.claims_list',
    outcome: 'ok',
    list_seq: 3,
    claims: [],
  });
  assert.deepEqual(polled.claims, []);
  assert.deepEqual(polled.notice, failed.notice);
  // 「一覧を更新」は、その欄の文言を消してから取り直す。
  const { sent, actions, state } = capture();
  actions.refresh('claims');
  assert.equal(sent[0]?.channel, 'desktop.claims_list');
  assert.equal(state().notice, null);
  assert.equal(clearNotice(failed, 'devices'), failed);
  assert.equal(clearNotice(failed, 'claims').notice, null);
  assert.equal(clearNotice(failed).notice, null);
  // 一覧の取り直しの失敗は欄の先頭に出し、次に取れたら消す。
  const listFailed = applyHubResponse(
    { ...INITIAL_HUB_STATE, claims: [CLAIM] },
    'desktop.claims_list',
    rejected('desktop.claims_list', 'not_connected'),
  );
  assert.equal(listFailed.notice?.place.kind, 'section');
  assert.match(
    String(listFailed.notice?.text),
    /^一覧を更新できませんでした。/u,
  );
  assert.equal(
    applyHubResponse(listFailed, 'desktop.claims_list', {
      request_id: decide.request_id,
      channel: 'desktop.claims_list',
      outcome: 'ok',
      list_seq: 4,
      claims: [],
    }).notice,
    null,
  );
});

test('hub state: a claim made after the code was shown marks the code as used', () => {
  const opened = applyHubResponse(INITIAL_HUB_STATE, 'desktop.pairing_open', {
    request_id: decide.request_id,
    channel: 'desktop.pairing_open',
    outcome: 'ok',
    session: SESSION,
  });
  assert.equal(opened.sessionUsed, false);
  const earlier = { ...CLAIM, claimed_at: at(11, 50) };
  const before = applyHubResponse(opened, 'desktop.claims_list', {
    request_id: decide.request_id,
    channel: 'desktop.claims_list',
    outcome: 'ok',
    list_seq: 5,
    claims: [earlier],
  });
  assert.equal(before.sessionUsed, false);
  const used = applyHubResponse(before, 'desktop.claims_list', {
    request_id: decide.request_id,
    channel: 'desktop.claims_list',
    outcome: 'ok',
    list_seq: 6,
    claims: [earlier, CLAIM],
  });
  assert.equal(used.sessionUsed, true);
  // 申請が一覧から消えても、使われた印は残る。新しいコードを出したら外す。
  const decided = applyHubResponse(used, 'desktop.claims_list', {
    request_id: decide.request_id,
    channel: 'desktop.claims_list',
    outcome: 'ok',
    list_seq: 7,
    claims: [],
  });
  assert.equal(decided.sessionUsed, true);
});

test('hub tabs: claims come first when there are any; the tab names match the content', () => {
  const { actions } = capture();
  const withClaims = html(
    <HubTabs
      state={{
        ...INITIAL_HUB_STATE,
        claims: [CLAIM],
        devices: [SELF],
        session: SESSION,
      }}
      actions={actions}
      now={NOW}
      thisDevice={<p>このマシンの中身</p>}
    />,
  );
  assert.match(withClaims, /aria-label="中枢の画面"/u);
  assert.match(withClaims, /端末の登録（申請 1）/u);
  assert.match(withClaims, /このマシンの接続/u);
  // 申請があるときは、申請の一覧が「新しい端末を登録する」より先。
  assert.match(withClaims, /hub-claims-heading.*hub-open-heading/su);
  const empty = html(
    <HubTabs
      state={{ ...INITIAL_HUB_STATE, claims: [] }}
      actions={actions}
      now={NOW}
      thisDevice={null}
    />,
  );
  assert.doesNotMatch(empty, /端末の登録（/u);
  assert.match(empty, /hub-open-heading.*hub-claims-heading/su);
});

test('hub state: a successful decision or revocation is announced at the top of its section, and cleared by the next operation', () => {
  const now = new Date(2030, 9, 5, 12, 0, 5).getTime();
  const sending = markSending(
    { ...INITIAL_HUB_STATE, claims: [CLAIM] },
    decide,
    approving,
  );
  const approved = applyHubResponse(
    sending,
    'desktop.claim_decide',
    {
      request_id: decide.request_id,
      channel: 'desktop.claim_decide',
      outcome: 'ok',
      list_seq: 8,
      claims: [],
    },
    now,
  );
  assert.deepEqual(approved.notice, {
    pane: 'claims',
    place: { kind: 'section' },
    tone: 'success',
    text: '中枢で「合成の申請」を承認しました（12:00:05）。「登録済みの端末」に出ています。',
  });
  const rejectedDone = applyHubResponse(
    markSending({ ...INITIAL_HUB_STATE, claims: [CLAIM] }, decide, {
      ...approving,
      verb: '拒否',
    }),
    'desktop.claim_decide',
    {
      request_id: decide.request_id,
      channel: 'desktop.claim_decide',
      outcome: 'ok',
      list_seq: 9,
      claims: [],
    },
    now,
  );
  assert.equal(
    rejectedDone.notice?.text,
    '中枢で「合成の申請」の申請を拒否しました。',
  );
  // 成功は role="status"、失敗は role="alert"。
  const { actions } = capture();
  const shown = html(
    <HubTabs
      state={{ ...INITIAL_HUB_STATE, claims: [], notice: approved.notice }}
      actions={actions}
      now={NOW}
      thisDevice={null}
    />,
  );
  assert.match(shown, /role="status"[^>]*>中枢で「合成の申請」を承認しました/u);
  assert.doesNotMatch(shown, /role="alert"/u);
  // 次の操作を送ると消える。
  assert.equal(markSending(approved, decide, approving).notice, null);
});

test('hub tabs: while waiting for the hub the last lists stay, operations stop and the reason is shown', () => {
  const { actions } = capture();
  const paused = html(
    <HubTabs
      state={{ ...INITIAL_HUB_STATE, claims: [CLAIM], devices: [SELF] }}
      actions={actions}
      now={NOW}
      paused={{ linked: false, lastConfirmedAt: at(11, 59, 0) }}
      thisDevice={null}
    />,
  );
  assert.match(
    paused,
    /role="status"[^>]*>.*中枢との接続を待っています。接続が戻ると、申請の承認と端末の管理ができます。下の一覧は 11:59:00 の時点のものです。/su,
  );
  assert.match(paused, /合成の申請/u);
  assert.match(paused, /<button[^>]*disabled[^>]*>承認する/u);
  assert.match(paused, /<button[^>]*disabled[^>]*>一覧を更新/u);
});

test('the open-pairing button is the primary only when there is nothing else to do', () => {
  const { actions } = capture();
  const base = {
    session: null,
    sessionUsed: false,
    busy: false,
    now: NOW,
    notice: null,
    actions,
  };
  assert.match(
    html(<PairingOpenPanel {...base} />),
    /button--primary[^>]*>ペアリングを始める/u,
  );
  assert.match(
    html(<PairingOpenPanel {...base} primary={false} />),
    /button--secondary[^>]*>ペアリングを始める/u,
  );
  const tabs = html(
    <HubTabs
      state={{ ...INITIAL_HUB_STATE, claims: [CLAIM] }}
      actions={actions}
      now={NOW}
      thisDevice={null}
    />,
  );
  assert.doesNotMatch(tabs, /button--primary/u);
  const stopped = html(
    <HubTabs
      state={{ ...INITIAL_HUB_STATE, claims: [] }}
      actions={actions}
      now={NOW}
      stopped
      thisDevice={null}
    />,
  );
  assert.doesNotMatch(stopped, /button--primary/u);
  // ロックでコードを消したときは、その理由を出す。
  assert.match(
    html(<PairingOpenPanel {...base} sessionCleared="lock" />),
    /画面をロックしたため、コードの表示を消しました。/u,
  );
  // コードを出したら、端末で入力する宛先とポートも出す（R1-M2）。
  const opened = html(<PairingOpenPanel {...base} session={SESSION} />);
  assert.match(
    opened,
    /<span class="font-mono" id="hub-open-host">100\.64\.0\.1<\/span>/u,
  );
  assert.match(opened, /id="hub-open-port">47443<\/span>/u);
});

test('hub state: a declined confirmation shows nothing; a held row cannot be pressed until a newer list of the same kind', () => {
  const sending = markSending(
    { ...INITIAL_HUB_STATE, claims: [CLAIM] },
    decide,
    approving,
  );
  const declined = applyHubResponse(
    sending,
    'desktop.claim_decide',
    rejected('desktop.claim_decide', 'confirmation_declined'),
  );
  assert.equal(declined.notice, null);
  assert.equal(declined.pending, null);
  // main が保留を付けた時点の通し番号は 7。
  const unknown = applyHubResponse(sending, 'desktop.claim_decide', {
    request_id: decide.request_id,
    channel: 'desktop.claim_decide',
    outcome: 'rejected',
    reason: 'outcome_unknown',
    list_seq: 7,
  });
  assert.deepEqual(unknown.held, {
    claims: [{ ref: CLAIM.ref, after: 7 }],
    devices: [],
  });
  const { actions } = capture();
  assert.match(
    html(
      <ClaimsPanel
        claims={[CLAIM]}
        busy={false}
        held={unknown.held.claims.map((held) => held.ref)}
        now={NOW}
        notice={null}
        actions={actions}
      />,
    ),
    /<button[^>]*disabled[^>]*>承認する/u,
  );
  const claimsList = (seq: number): DesktopIpcResponse => ({
    request_id: decide.request_id,
    channel: 'desktop.claims_list',
    outcome: 'ok',
    claims: [CLAIM],
    list_seq: seq,
  });
  // 別の種類（端末）の一覧では解かない。
  const otherPane = applyHubResponse(unknown, 'desktop.devices_list', {
    request_id: decide.request_id,
    channel: 'desktop.devices_list',
    outcome: 'ok',
    devices: [],
    list_seq: 9,
  });
  assert.deepEqual(otherPane.held.claims, [{ ref: CLAIM.ref, after: 7 }]);
  // 結果が分かる前に main が始めた申請の一覧（6）でも解かない。
  const early = applyHubResponse(
    otherPane,
    'desktop.claims_list',
    claimsList(6),
  );
  assert.deepEqual(early.held.claims, [{ ref: CLAIM.ref, after: 7 }]);
  // 結果が分かった後に始めた申請の一覧（8）で解く。
  const refreshed = applyHubResponse(
    early,
    'desktop.claims_list',
    claimsList(8),
  );
  assert.deepEqual(refreshed.held, { claims: [], devices: [] });
});

test('hub state: a list started during a change is dropped even when the refresh after the change failed', () => {
  const device = OTHER;
  const revoke: DesktopIpcRequest = {
    channel: 'desktop.device_revoke',
    request_id: '00000000-0000-4000-8000-000000000d09',
    payload: { ref: OTHER.ref ?? '' },
  };
  const sending = markSending(
    { ...INITIAL_HUB_STATE, devices: [device] },
    revoke,
    {
      channel: 'desktop.device_revoke',
      ref: device.ref,
      name: '合成の端末',
      verb: '失効',
    },
  );
  // main: 失効の前の境目 1 → その最中に一覧 2 → 失効の結果が分かった境目 3（取り直しは失敗）。
  const applied = applyHubResponse(sending, 'desktop.device_revoke', {
    request_id: revoke.request_id,
    channel: 'desktop.device_revoke',
    outcome: 'ok',
    list_refreshed: false,
    list_seq: 3,
  });
  assert.equal(applied.devices?.[0]?.ref, null);
  // 失効の前の内容を取った一覧（2）が遅れて届いても、操作できる行を戻さない。
  const late = applyHubResponse(applied, 'desktop.devices_list', {
    request_id: revoke.request_id,
    channel: 'desktop.devices_list',
    outcome: 'ok',
    devices: [device],
    list_seq: 2,
  });
  assert.equal(late.devices?.[0]?.ref, null);
});

// Codex の確認 2 回目: main が変更の後に取り直した一覧 A（4）の応答より後に、本人の更新の一覧 B（5）が届いても捨てない。
test('hub state: a newer list started after the refresh inside a change is kept even when the change response arrives first', () => {
  const revoke: DesktopIpcRequest = {
    channel: 'desktop.device_revoke',
    request_id: '00000000-0000-4000-8000-000000000d0a',
    payload: { ref: OTHER.ref ?? '' },
  };
  const sending = markSending(
    { ...INITIAL_HUB_STATE, devices: [OTHER] },
    revoke,
    {
      channel: 'desktop.device_revoke',
      ref: OTHER.ref,
      name: '合成の端末',
      verb: '失効',
    },
  );
  const revokedOther = { ...OTHER, ref: null, revoked_at: at(12, 0) };
  const added: DesktopDeviceEntry = {
    ...OTHER,
    ref: '00000000-0000-4000-8000-000000000d0b',
    device_name: '合成の新しい端末',
  };
  const applied = applyHubResponse(sending, 'desktop.device_revoke', {
    request_id: revoke.request_id,
    channel: 'desktop.device_revoke',
    outcome: 'ok',
    devices: [revokedOther],
    list_seq: 4,
  });
  assert.equal(applied.pending, null);
  const newer = applyHubResponse(applied, 'desktop.devices_list', {
    request_id: revoke.request_id,
    channel: 'desktop.devices_list',
    outcome: 'ok',
    devices: [revokedOther, added],
    list_seq: 5,
  });
  assert.deepEqual(newer.devices, [revokedOther, added]);
  // 逆の順（B が先、A が後）でも、新しい B を残す。操作の待ちは外し、成功を知らせる。
  const first = applyHubResponse(sending, 'desktop.devices_list', {
    request_id: revoke.request_id,
    channel: 'desktop.devices_list',
    outcome: 'ok',
    devices: [revokedOther, added],
    list_seq: 5,
  });
  const second = applyHubResponse(first, 'desktop.device_revoke', {
    request_id: revoke.request_id,
    channel: 'desktop.device_revoke',
    outcome: 'ok',
    devices: [revokedOther],
    list_seq: 4,
  });
  assert.deepEqual(second.devices, [revokedOther, added]);
  assert.equal(second.pending, null);
  assert.equal(second.notice?.tone, 'success');
});

test('hub state: a list with an older main sequence number does not overwrite the newer result', () => {
  const list = (
    claims: DesktopClaimEntry[],
    seq: number,
  ): DesktopIpcResponse => ({
    request_id: decide.request_id,
    channel: 'desktop.claims_list',
    outcome: 'ok',
    claims,
    list_seq: seq,
  });
  // 一覧 1（古い）を送った後に一覧 2 が先に届く → 一覧 1 が遅れて届いても戻さない。
  const newer = applyHubResponse(
    INITIAL_HUB_STATE,
    'desktop.claims_list',
    list([], 2),
  );
  assert.deepEqual(
    applyHubResponse(newer, 'desktop.claims_list', list([CLAIM], 1)).claims,
    [],
  );
  // 承認の後に main が取り直した一覧（4）より前の一覧（3）は、承認の後の一覧を戻さない。
  const sending = markSending(
    { ...INITIAL_HUB_STATE, claims: [CLAIM] },
    decide,
    approving,
  );
  const decided = applyHubResponse(sending, 'desktop.claim_decide', {
    request_id: decide.request_id,
    channel: 'desktop.claim_decide',
    outcome: 'ok',
    claims: [],
    list_seq: 4,
  });
  assert.deepEqual(
    applyHubResponse(decided, 'desktop.claims_list', list([CLAIM], 3)).claims,
    [],
  );
  // main が古いとして捨てた一覧（list_superseded）は何も出さない。
  assert.equal(
    applyHubResponse(
      decided,
      'desktop.claims_list',
      rejected('desktop.claims_list', 'list_superseded'),
    ).notice,
    decided.notice,
  );
  // ロック・切断をまたいだ応答は捨て、重い操作の待ちだけを外す。
  assert.equal(
    dropStaleResponse(sending, 'desktop.claim_decide').pending,
    null,
  );
  assert.equal(dropStaleResponse(newer, 'desktop.claims_list'), newer);
});

test('hub tabs: the success notice for the claims stays at the top of the tab even when the order changes', () => {
  const { actions } = capture();
  const tabs = html(
    <HubTabs
      state={{
        ...INITIAL_HUB_STATE,
        claims: [],
        notice: {
          pane: 'claims',
          place: { kind: 'section' },
          tone: 'success',
          text: '中枢で「合成の申請」を承認しました（12:00:05）。',
        },
      }}
      actions={actions}
      now={NOW}
      thisDevice={null}
    />,
  );
  // 申請が 0 件で「新しい端末を登録する」が先に来ても、知らせはその上（タブの本文の先頭）。
  assert.match(
    tabs,
    /role="status"[^>]*>中枢で「合成の申請」を承認しました.*hub-open-heading.*hub-claims-heading/su,
  );
});
