// 予算の確認（超過枠の承認・M 超過の確認・不明な費用の手での精算。B07-05、ADR 0039）を、127.0.0.1 の Core と main の部品
// （DesktopCoreLink・BudgetBridge・限定 IPC の受付）で通す統合の試験（two-clients.test.ts と同じ形）。
// - 中枢は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬、予算の設定は合成の通貨 XTS・縮めた上限）。有料の provider は
//   試験の中の模擬（usage を返す・返さない）。端末は中枢の DB に直接登録し、トークンは模擬の safeStorage に保存する。
// - OS の確認ダイアログは模擬（confirmAdmin が値を控えて答える）。Electron は起動しない。実機・実 API・実請求は未実施。
// - 期待値（金額・状態・件数・理由）は手で書いた値。M = 入力 10 ＋ 出力の上限 30 = 40 token ×（1 token = XTS 1.00）= XTS 40.00。
// 確かめること: 承認は main の確認を 1 回だけ経る・やめれば何も送らない・二度押しでも承認は 1 件・承認のない超過枠の使用は 0 回・
// 確認の最中に承認が失効すれば送らない・ロックで項目を捨てる・M 超過の確認と手での精算が中枢の記録と予算保留へ届く。

import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createDeviceToken, deviceTokenHash } from '@buddy/core';
import type { BudgetGate } from '@buddy/core';
import type { DesktopIpcResponse } from '@buddy/contracts';
import type { DesktopIoState } from '@buddy/domain';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { BUDGET_POLL_INTERVAL_MS, DesktopCoreLink } from './core-link.js';
import type { AdminConfirmRequest } from './core-link.js';
import { SecretText, saveCredential } from './credential-store.js';
import {
  freePort,
  mockProtector,
  onCleanup,
  startHub,
  tempDir,
  waitUntil,
} from './hub-test-support.js';
import type { TestHub } from './hub-test-support.js';
import { createHubTransport } from './hub-transport.js';
import type { PinnedHub } from './hub-transport.js';
import { systemClock } from './system-clock.js';

const contract = createDesktopContract(loadContractSchema());
const UNLOCKED: DesktopIoState = {
  lockState: 'unlocked',
  stopScope: 'none',
  ioEpoch: '0',
};
const SCREEN = { trustedSender: true, windowFocused: true };
const OCT_15 = Date.parse('2030-10-15T00:00:00.000Z');
const MINUTE = 60_000;
const xts = (amount: string) => ({ currency: 'XTS', amount });
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

// 合成の予算の設定（通貨 XTS。1 token = XTS 1.00。枠は total 200・llm 100・llm.background 50・search 40・voice 50・
// overage 60（承認が要る））。金額は通貨単位の百万分の一の整数。個人の金額ではない。
const money = (amount: string) => ({ currency: 'XTS', amount });
const rate = (
  category: string,
  unitPrice: string,
  minimum: string,
  max: string | null,
) => ({
  category,
  unit_price: unitPrice,
  per_quantity: '1',
  minimum_quantity: minimum,
  max_quantity_per_request: max,
});
const SAME = {
  conversion_version: 'xts.same.v1',
  to_currency: 'XTS',
  rate: '1',
  safety_factor: '1',
};
const pool = (
  id: string,
  parent: string | null,
  limit: string,
  approval = false,
) => ({
  pool_id: id,
  parent_pool_id: parent,
  limit: money(limit),
  requires_approval: approval,
});
const autonomous = { llm: 'llm.background', search: 'search', voice: null };
const CONFIG = {
  schema: 'buddy.budget-runtime.v1',
  time_zone: 'Asia/Tokyo',
  budget: {
    schema: 'buddy.budget-config.v1',
    currency: 'XTS',
    pools: [
      pool('total', null, '200000000'),
      pool('llm', 'total', '100000000'),
      pool('llm.background', 'llm', '50000000'),
      pool('search', 'total', '40000000'),
      pool('voice', null, '50000000'),
      pool('overage', null, '60000000', true),
    ],
    verified_price_versions: ['xts.text.v1', 'xts.live.v1'],
  },
  price_versions: [
    {
      price_version: 'xts.text.v1',
      price_key: 'synthetic.text',
      currency: 'XTS',
      effective_from: '2030-01-01T00:00:00.000Z',
      effective_to: null,
      rates: [
        rate('input_tokens', '1000000', '0', null),
        rate('output_tokens', '1000000', '0', '100'),
      ],
      conversion: SAME,
    },
    {
      price_version: 'xts.live.v1',
      price_key: 'synthetic.live',
      currency: 'XTS',
      effective_from: '2030-01-01T00:00:00.000Z',
      effective_to: null,
      rates: [rate('live_seconds', '1000000', '15', '60')],
      conversion: SAME,
    },
  ],
  routing: {
    routes: {
      owner_request: { llm: 'llm', search: 'search', voice: 'voice' },
      autonomous_analysis: { ...autonomous },
      auto_execution: { ...autonomous },
      initial_import: { ...autonomous },
      shadow_mode: { llm: 'llm.background', search: null, voice: null },
    },
    overage_pool_id: 'overage',
  },
};

const paid = (requestId: string) => ({
  request_id: requestId,
  origin: 'owner_request' as const,
  service: 'llm' as const,
  profile_id: 'intent.synthetic.v1',
  profile_revision: '1',
  price_key: 'synthetic.text',
  quantities: { input_tokens: '10', output_tokens: '30' },
  timeout_ms: 60_000,
});

// 模擬の有料 provider: 受信した回数と、答え（usage を返す・応答が届かない）。
function provider() {
  const received: string[] = [];
  const plans = new Map<string, string | 'unknown'>();
  return {
    received,
    plan: (requestId: string, actual: string | 'unknown') =>
      plans.set(requestId, actual),
    send: (context: { request_id: string }) => {
      received.push(context.request_id);
      const plan = plans.get(context.request_id) ?? '1000000';
      return Promise.resolve(
        plan === 'unknown'
          ? ({ kind: 'unknown' } as const)
          : ({
              kind: 'usage',
              provider: 'mockpaid',
              reconciliation_id: `rcpt-${context.request_id}`,
              actual_gross: plan,
            } as const),
      );
    },
  };
}

interface Rig {
  readonly hub: TestHub;
  readonly gate: BudgetGate;
  readonly link: DesktopCoreLink;
  readonly clock: { now: number };
  readonly provider: ReturnType<typeof provider>;
  // 中枢へ送った要求（方法とパス）と、main が出した確認の値。
  readonly requests: string[];
  readonly confirms: AdminConfirmRequest[];
  // 確認への答え（既定は確定）。確認の最中に何かを起こすときは、ここで起こす。
  answer: { current: (request: AdminConfirmRequest) => Promise<boolean> };
  ipc(channel: string, payload: unknown): Promise<DesktopIpcResponse>;
  view(): ReturnType<DesktopCoreLink['view']>;
  // 予算の読み直しの次の予約（30 秒の timer）が、今いくつ残っているか。
  pollTimers(): number;
}

async function start(
  t: test.TestContext,
  options: { readonly auto?: boolean } = {},
): Promise<Rig> {
  const dir = await tempDir(t, 'bbl-');
  const dataDir = join(dir, 'data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dataDir, 'budget-runtime.json'),
    JSON.stringify(CONFIG),
    { mode: 0o600 },
  );
  const clock = { now: OCT_15 };
  const hub = await startHub(t, {
    dataDir,
    port: await freePort(),
    budget: { tickIntervalMs: 0, now: () => clock.now },
  });
  const gate = hub.handle.budget;
  assert.equal(gate.configured, true);
  // 端末は中枢の DB に直接登録する（ペアリングは two-clients.test.ts で試験済み）。
  const protector = mockProtector();
  const token = createDeviceToken();
  const deviceId = randomUUID();
  const inserted = await hub.handle.store.device({
    kind: 'device.insert',
    device_id: deviceId,
    device_name: '合成の端末',
    platform: 'macos',
    hub_local: true,
    token_hash: deviceTokenHash(token),
    registered_at: Date.now(),
  });
  assert(inserted.ok, 'device insert failed');
  const pem = await readFile(join(hub.dataDir, 'tls-certificate.pem'), 'utf8');
  const pinned: PinnedHub = {
    host: '127.0.0.1',
    port: hub.port,
    certificatePem: pem,
    fingerprint: new X509Certificate(pem).fingerprint256
      .replaceAll(':', '')
      .toLowerCase(),
  };
  const credentialPath = join(dir, 'device-credential.bin');
  saveCredential(credentialPath, protector, {
    deviceId,
    token: new SecretText(token),
    issuedAt: '2030-10-05T00:00:00Z',
    hub: pinned,
  });
  const requests: string[] = [];
  const confirms: AdminConfirmRequest[] = [];
  // 予算の読み直しの timer の数を数える（ほかの timer は数えない）。
  const base = systemClock();
  const polls = new Set<number>();
  let nextTimer = 0;
  const countingClock: typeof base = {
    ...base,
    setTimer: (ms, run) => {
      if (ms !== BUDGET_POLL_INTERVAL_MS) return base.setTimer(ms, run);
      const id = (nextTimer += 1);
      polls.add(id);
      const cancel = base.setTimer(ms, () => {
        polls.delete(id);
        run();
      });
      return () => {
        polls.delete(id);
        cancel();
      };
    },
  };
  const answer: Rig['answer'] = { current: () => Promise.resolve(true) };
  const link = new DesktopCoreLink({
    contract,
    credentialPath,
    protector,
    clock: countingClock,
    platform: 'macos',
    collectHome: () =>
      Promise.resolve({ gateway_mac: null, subnet: null, ssid: null }),
    networkSignature: () => 'fixed',
    onChange: () => undefined,
    log: () => undefined,
    // 読み取りは試験が決めた時だけ（中枢への要求を数えるため）。
    budgetAuto: options.auto === true,
    backoff: { baseMs: 50, maxMs: 200, jitterRatio: 0 },
    confirmAdmin: (request) => {
      confirms.push(request);
      return answer.current(request);
    },
    transportFor: (target, bearer) => {
      const transport = createHubTransport({ hub: target, token: bearer });
      return {
        request: (request) => {
          requests.push(`${request.method} ${request.path}`);
          return transport.request(request);
        },
        openStream: (cursor, lockState, listener) =>
          transport.openStream(cursor, lockState, listener),
      };
    },
  });
  onCleanup(t, () => link.stop());
  link.start('unlocked');
  await waitUntil(() => link.linkState?.phase === 'live', 'live');
  return {
    hub,
    gate,
    link,
    clock,
    provider: provider(),
    requests,
    confirms,
    answer,
    async ipc(channel, payload) {
      const { response } = await link.handleOperationIpc(
        channel,
        { channel, request_id: randomUUID(), payload },
        SCREEN,
        UNLOCKED,
      );
      return response;
    },
    pollTimers: () => polls.size,
    view() {
      const view = link.view('unlocked');
      assert.equal(view.visibility, 'shown');
      return view;
    },
  };
}

const items = (r: Rig) => {
  const view = r.view();
  assert(view.visibility === 'shown');
  return view.budget_items;
};
const reasonOf = (response: DesktopIpcResponse) =>
  response.outcome === 'rejected' ? response.reason : null;
const decisions = (r: Rig) =>
  r.requests.filter((request) => /\/decision$/u.test(request));

// 枠 llm（上限 100）の精算済みを 80（40 + 40）にする。以後、M = 40 の本人の依頼は上限で落ちる。
async function fillLlm(r: Rig): Promise<void> {
  for (const n of [1, 2]) {
    r.provider.plan(uuid(n), '40000000');
    const run = await r.gate.run(paid(uuid(n)), r.provider.send);
    assert.equal(run.kind, 'settled');
  }
}

const approvalState = async (r: Rig, approvalId: string) => {
  const found = await r.hub.handle.store.budget({
    kind: 'budget.approval_find',
    approval_id: approvalId,
  });
  assert(found.ok && found.value !== null);
  return found.value.approval.status;
};

const overageUsed = async (r: Rig): Promise<string> => {
  const usage = await r.gate.usage();
  assert(usage.ok);
  const month = usage.value.months[0];
  const overage = month?.pools.find((item) => item.pool_id === 'overage');
  assert(overage !== undefined);
  return overage.unsettled_max_liability.amount;
};

test(
  'the screen shows the pending approval with the request M and the remaining overage; one confirmation, a double press and the core leave exactly one approval; the overage is used only after it',
  { timeout: 60_000 },
  async (t) => {
    const r = await start(t);
    await fillLlm(r);
    const ask = await r.gate.requestOverage(paid(uuid(3)));
    assert(ask.ok);
    const approvalId = ask.value.approval.approval_id;
    // 読み取る前は、予算保留は不明（保留なしと見せない）。
    assert.equal(r.link.hubStatus().budgetHeld, null);
    await r.link.refreshBudget();
    // 画面へ渡す値（金額・枠・予算月・期限。ID・版は含まない）。
    const [entry] = items(r);
    assert.deepEqual(
      { ...entry, ref: 'ref' },
      {
        ref: 'ref',
        kind: 'overage_approval',
        pool_id: 'overage',
        budget_month: '2030-10',
        // 承認の対象の依頼の名前は中枢が記録していない（求めた時刻だけ）。
        origin: null,
        profile_id: null,
        occurred_at: '2030-10-15T00:00:00.000Z',
        max_liability: xts('40000000'),
        overage_remaining: xts('60000000'),
        actual_gross: null,
        expires_at: '2030-10-15T00:10:00.000Z',
        delivery_unknown: false,
      },
    );
    assert(entry !== undefined);
    const shown = JSON.stringify(r.view());
    for (const secret of [approvalId, uuid(3)])
      assert(!shown.includes(secret), 'no approval ID or budget request ID');
    assert.equal(r.link.hubStatus().budgetHeld, false);

    // 承認のない超過枠の使用は 0 回。
    const early = await r.gate.admit(paid(uuid(3)));
    assert.equal(early.ok, false);
    assert.equal(await overageUsed(r), '0');
    assert.equal(await approvalState(r, approvalId), 'pending');

    // 二度押し: 同時に 2 回押しても、確認は 1 回・中枢への送信は 1 回・承認は 1 件。
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.answer.current = async () => {
      await held;
      return true;
    };
    const first = r.ipc('desktop.budget_overage_decide', {
      ref: entry.ref,
      decision: 'approve',
    });
    await waitUntil(() => r.confirms.length === 1, 'the confirmation is shown');
    const second = await r.ipc('desktop.budget_overage_decide', {
      ref: entry.ref,
      decision: 'approve',
    });
    assert.equal(reasonOf(second), 'confirmation_pending');
    release();
    const done = await first;
    assert.deepEqual(done, {
      request_id: done.request_id,
      channel: 'desktop.budget_overage_decide',
      outcome: 'ok',
      receipt: 'durable',
    });
    // main は確認に、この依頼の M・超過枠の残り・期限を出した（main が持つ値）。
    assert.deepEqual(r.confirms, [
      {
        action: 'approve_overage',
        origin: null,
        profileId: null,
        occurredAt: '2030-10-15T00:00:00.000Z',
        poolId: 'overage',
        budgetMonth: '2030-10',
        maxLiability: xts('40000000'),
        overageRemaining: xts('60000000'),
        expiresAt: '2030-10-15T00:10:00.000Z',
        actualGross: null,
        reconciliationId: null,
      },
    ]);
    // 受け付けた後の同じ参照は、押し直しても何も送らない。
    const third = await r.ipc('desktop.budget_overage_decide', {
      ref: entry.ref,
      decision: 'approve',
    });
    assert.equal(reasonOf(third), 'entry_not_found');
    assert.equal(r.confirms.length, 1);
    assert.equal(decisions(r).length, 1);
    assert.equal(await approvalState(r, approvalId), 'approved');
    // 承認はまだ使っていない（受付の前）。
    assert.equal(await overageUsed(r), '0');
    await r.link.refreshBudget();
    assert.deepEqual(items(r), []);

    // 承認した依頼だけが超過枠を使う。別の依頼は使えない。
    const other = await r.gate.admit(paid(uuid(4)));
    assert.equal(other.ok, false);
    assert.equal(await overageUsed(r), '0');
    const used = await r.gate.admit(paid(uuid(3)));
    assert(used.ok);
    assert.equal(used.ticket.pool_id, 'overage');
    assert.equal(await overageUsed(r), '40000000');
    assert.equal(await approvalState(r, approvalId), 'consumed');
  },
);

test(
  'declining the confirmation sends nothing and leaves the approval pending; rejecting needs no confirmation and the overage stays unused',
  { timeout: 60_000 },
  async (t) => {
    const r = await start(t);
    await fillLlm(r);
    const ask = await r.gate.requestOverage(paid(uuid(3)));
    assert(ask.ok);
    const approvalId = ask.value.approval.approval_id;
    await r.link.refreshBudget();
    const ref = items(r)[0]?.ref as string;
    r.answer.current = () => Promise.resolve(false);
    const declined = await r.ipc('desktop.budget_overage_decide', {
      ref,
      decision: 'approve',
    });
    assert.equal(reasonOf(declined), 'confirmation_declined');
    assert.equal(r.confirms.length, 1);
    assert.equal(decisions(r).length, 0);
    assert.equal(await approvalState(r, approvalId), 'pending');
    // 見送り: 確認なしで中枢へ 1 回。承認は増えず、超過枠は使えない。
    const rejected = await r.ipc('desktop.budget_overage_decide', {
      ref,
      decision: 'reject',
    });
    assert.equal(rejected.outcome, 'ok');
    assert.equal(r.confirms.length, 1);
    assert.equal(decisions(r).length, 1);
    assert.equal(await approvalState(r, approvalId), 'rejected');
    const blocked = await r.gate.admit(paid(uuid(3)));
    assert.equal(blocked.ok, false);
    assert.equal(await overageUsed(r), '0');
  },
);

test(
  'an approval that expires while the confirmation is open is not sent, and a stopped device cannot approve',
  { timeout: 60_000 },
  async (t) => {
    const r = await start(t);
    await fillLlm(r);
    const ask = await r.gate.requestOverage(paid(uuid(3)));
    assert(ask.ok);
    const approvalId = ask.value.approval.approval_id;
    await r.link.refreshBudget();
    const ref = items(r)[0]?.ref as string;
    // 確認の最中に承認の期限が過ぎ、最新の読み取りが承認を載せなくなる。
    r.answer.current = async () => {
      r.clock.now = OCT_15 + 10 * MINUTE;
      await r.link.refreshBudget();
      return true;
    };
    const stale = await r.ipc('desktop.budget_overage_decide', {
      ref,
      decision: 'approve',
    });
    assert.equal(reasonOf(stale), 'preview_stale');
    assert.equal(decisions(r).length, 0);
    assert.equal(await approvalState(r, approvalId), 'pending');
    assert.deepEqual(items(r), []);

    // 入出力が止まっている端末は承認できない（受付で断る。確認も出さない）。
    r.clock.now = OCT_15 + 11 * MINUTE;
    const again = await r.gate.requestOverage(paid(uuid(5)));
    assert(again.ok);
    await r.link.refreshBudget();
    const nextRef = items(r)[0]?.ref as string;
    r.answer.current = () => Promise.resolve(true);
    const confirmsBefore = r.confirms.length;
    const stopped = await r.link.handleOperationIpc(
      'desktop.budget_overage_decide',
      {
        channel: 'desktop.budget_overage_decide',
        request_id: randomUUID(),
        payload: { ref: nextRef, decision: 'approve' },
      },
      SCREEN,
      { ...UNLOCKED, stopScope: 'local' },
    );
    assert.equal(reasonOf(stopped.response), 'input_stopped');
    assert.equal(r.confirms.length, confirmsBefore);
    assert.equal(decisions(r).length, 0);
  },
);

test(
  'locking drops the items and refs; unlocking reads them again under new refs',
  { timeout: 60_000 },
  async (t) => {
    const r = await start(t);
    await fillLlm(r);
    const ask = await r.gate.requestOverage(paid(uuid(3)));
    assert(ask.ok);
    await r.link.refreshBudget();
    const oldRef = items(r)[0]?.ref as string;
    r.link.setLockState('locked');
    assert.deepEqual(r.link.view('locked'), {
      visibility: 'hidden',
      lock_state: 'locked',
    });
    // ロック中は読み取りもしない。
    const readsBefore = r.requests.filter((item) =>
      item.endsWith('/v1/budget/usage'),
    ).length;
    await r.link.refreshBudget();
    assert.equal(
      r.requests.filter((item) => item.endsWith('/v1/budget/usage')).length,
      readsBefore,
    );
    r.link.setLockState('unlocked');
    assert.deepEqual(items(r), [], 'nothing is kept across the lock');
    const stale = await r.ipc('desktop.budget_overage_decide', {
      ref: oldRef,
      decision: 'approve',
    });
    assert.equal(reasonOf(stale), 'entry_not_found');
    assert.equal(r.confirms.length, 0);
    await r.link.refreshBudget();
    assert.equal(items(r).length, 1);
    assert.notEqual(items(r)[0]?.ref, oldRef);
  },
);

test(
  'the overrun review and the manual settlement reach the core through one confirmation each, and the budget hold follows',
  { timeout: 60_000 },
  async (t) => {
    const r = await start(t);
    // 応答が届かなかった費用は usage 不明で保持する。実費 55 が M 40 を超えた（確認まで枠 llm の新しい受付を止める）。
    r.provider.plan(uuid(1), 'unknown');
    const unknown = await r.gate.run(paid(uuid(1)), r.provider.send);
    assert.equal(unknown.kind, 'usage_unknown');
    r.provider.plan(uuid(2), '55000000');
    const overrun = await r.gate.run(paid(uuid(2)), r.provider.send);
    assert(overrun.kind === 'settled' && overrun.overrun);
    await r.link.refreshBudget();
    // 保留の記号: 中枢のスナップショットの予算保留（枠 llm の M 超過の確認待ち）。
    assert.equal(r.link.hubStatus().budgetHeld, true);
    assert.deepEqual(
      items(r).map((entry) => [entry.kind, entry.pool_id, entry.budget_month]),
      [
        ['overrun_review', 'llm', '2030-10'],
        ['manual_settlement', 'llm', '2030-10'],
      ],
    );
    const review = items(r)[0];
    const manual = items(r)[1];
    assert(review !== undefined && manual !== undefined);
    assert.deepEqual(review.actual_gross, xts('55000000'));
    assert.deepEqual(review.max_liability, xts('40000000'));

    // M 超過の確認: 確認に実費と M を出し、中枢へ 1 回。
    const reviewed = await r.ipc('desktop.budget_overrun_review', {
      ref: review.ref,
    });
    assert.equal(reviewed.outcome, 'ok');
    assert.deepEqual(r.confirms[0], {
      action: 'review_overrun',
      origin: 'owner_request',
      profileId: 'intent.synthetic.v1',
      occurredAt: '2030-10-15T00:00:00.000Z',
      poolId: 'llm',
      budgetMonth: '2030-10',
      maxLiability: xts('40000000'),
      overageRemaining: null,
      expiresAt: null,
      actualGross: xts('55000000'),
      reconciliationId: null,
    });
    const reviewedAgain = await r.ipc('desktop.budget_overrun_review', {
      ref: review.ref,
    });
    assert.equal(reasonOf(reviewedAgain), 'entry_not_found');
    assert.equal(
      r.requests.filter((item) => /overrun-review$/u.test(item)).length,
      1,
    );

    // 手での精算: 形（manual: で始まる ID・整数の金額）に合わない入力は、受付で断り、何も送らない。
    const confirmsBefore = r.confirms.length;
    for (const payload of [
      {
        ref: manual.ref,
        reconciliation_id: 'rcpt-1',
        actual_amount: '3000000',
      },
      {
        ref: manual.ref,
        reconciliation_id: 'manual:invoice-a',
        actual_amount: '3.5',
      },
    ])
      assert.equal(
        reasonOf(await r.ipc('desktop.budget_manual_settle', payload)),
        'invalid_request',
      );
    assert.equal(r.confirms.length, confirmsBefore);
    const settled = await r.ipc('desktop.budget_manual_settle', {
      ref: manual.ref,
      reconciliation_id: 'manual:invoice-2030-10-a',
      actual_amount: '3000000',
    });
    assert.equal(settled.outcome, 'ok');
    assert.deepEqual(r.confirms[1], {
      action: 'settle_manual',
      origin: 'owner_request',
      profileId: 'intent.synthetic.v1',
      occurredAt: '2030-10-15T00:00:00.000Z',
      poolId: 'llm',
      budgetMonth: '2030-10',
      maxLiability: xts('40000000'),
      overageRemaining: null,
      expiresAt: null,
      actualGross: xts('3000000'),
      reconciliationId: 'manual:invoice-2030-10-a',
    });
    // 中枢の記録: 元の月に実費 3.00 で一度だけ精算し、照合 ID は manual:。
    await r.link.refreshBudget();
    assert.deepEqual(items(r), []);
    const found = await r.hub.handle.store.budget({
      kind: 'budget.reservation_find',
      reservation_id: null,
      request_id: uuid(1),
    });
    assert(found.ok && found.value !== null);
    assert.equal(found.value.status, 'settled');
    assert.equal(found.value.actualGross, '3000000');
    assert.equal(
      found.value.providerReconciliationId,
      'manual:invoice-2030-10-a',
    );
    assert.equal(found.value.budgetMonth, '2030-10');
    // 確認の後、予算保留は解ける。
    assert.equal(r.link.hubStatus().budgetHeld, false);
  },
);

test(
  'two unknown costs with the same pool, month and M are told apart by when they happened, and the settlement goes to the one that was confirmed',
  { timeout: 60_000 },
  async (t) => {
    const r = await start(t);
    r.provider.plan(uuid(1), 'unknown');
    assert.equal(
      (await r.gate.run(paid(uuid(1)), r.provider.send)).kind,
      'usage_unknown',
    );
    // 1 時間後（同じ月）に、同じ枠・同じ M の 2 つ目。
    r.clock.now = OCT_15 + 60 * MINUTE;
    r.provider.plan(uuid(2), 'unknown');
    assert.equal(
      (await r.gate.run(paid(uuid(2)), r.provider.send)).kind,
      'usage_unknown',
    );
    await r.link.refreshBudget();
    const listed = items(r);
    assert.deepEqual(
      listed.map((entry) => [
        entry.kind,
        entry.pool_id,
        entry.max_liability,
        entry.occurred_at,
      ]),
      [
        [
          'manual_settlement',
          'llm',
          xts('40000000'),
          '2030-10-15T00:00:00.000Z',
        ],
        [
          'manual_settlement',
          'llm',
          xts('40000000'),
          '2030-10-15T01:00:00.000Z',
        ],
      ],
    );
    const second = listed[1];
    assert(second !== undefined);
    const settled = await r.ipc('desktop.budget_manual_settle', {
      ref: second.ref,
      reconciliation_id: 'manual:invoice-b',
      actual_amount: '2000000',
    });
    assert.equal(settled.outcome, 'ok');
    // 確認には 2 つ目の日時を出した。精算されたのは 2 つ目だけで、1 つ目は usage 不明のまま。
    const confirmed = r.confirms[0];
    assert(confirmed !== undefined && 'poolId' in confirmed);
    assert.equal(confirmed.occurredAt, '2030-10-15T01:00:00.000Z');
    const find = async (requestId: string) => {
      const found = await r.hub.handle.store.budget({
        kind: 'budget.reservation_find',
        reservation_id: null,
        request_id: requestId,
      });
      assert(found.ok && found.value !== null);
      return found.value;
    };
    const one = await find(uuid(1));
    const two = await find(uuid(2));
    assert.equal(one.status, 'usage_unknown');
    assert.equal(two.status, 'settled');
    assert.equal(two.providerReconciliationId, 'manual:invoice-b');
    await r.link.refreshBudget();
    assert.deepEqual(
      items(r).map((entry) => entry.occurred_at),
      ['2030-10-15T00:00:00.000Z'],
    );
  },
);

test(
  'overlapping reads leave exactly one next-read timer, and locking leaves none',
  { timeout: 60_000 },
  async (t) => {
    const r = await start(t, { auto: true });
    // 接続したときの自動の読み取りが済んで、予約が 1 つになるまで待つ。
    await waitUntil(
      () => r.pollTimers() === 1,
      'the first read arms one timer',
    );
    // 読み取りを重ねて呼ぶ（パネルを開く・接続の直後など）。どの順に終わっても、次の予約は 1 つ。
    await Promise.all([
      r.link.refreshBudget(),
      r.link.refreshBudget(),
      r.link.refreshBudget(),
    ]);
    assert.equal(r.pollTimers(), 1);
    await r.link.refreshBudget();
    assert.equal(r.pollTimers(), 1);
    // ロックすると予約を取り消す（ロック中は読まない）。
    r.link.setLockState('locked');
    assert.equal(r.pollTimers(), 0);
    await r.link.refreshBudget();
    assert.equal(r.pollTimers(), 0);
    // 解除すると読み取りを再開し、予約は 1 つに戻る。
    r.link.setLockState('unlocked');
    await waitUntil(
      () => r.pollTimers() === 1,
      'the read resumes after unlock',
    );
    await Promise.all([r.link.refreshBudget(), r.link.refreshBudget()]);
    assert.equal(r.pollTimers(), 1);
  },
);
