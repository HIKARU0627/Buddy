// 記録しない会話の独立した確認の経路（PrivateConfirmationBridge。ADR 0197、U503）の試験。接続は模擬（中枢への要求を記録して
// 手で答える）。期待値（送る本文・送り先・画面操作の印・理由・画面に出す値）は手で書いた。確かめること: 記録しない会話の間だけ
// 画面に出し、確認の ID・hash を画面へ渡さない、対象を確かめられない確認は承認させない、ダイアログの間に確認が変わった・
// ロックした・停止したら送らない、結果が分からなければ送り直さずに読み直し、読み直すまで同じ確認から送らせない、中枢の拒否
// では読み直す、読めなかったら前の一覧のまま。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientConnection } from '@buddy/client';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { PrivateConfirmationBridge } from './private-confirmation-bridge.js';
import type {
  PrivateConfirmRequest,
  PrivateConfirmResult,
} from './private-confirmation-bridge.js';

const contract = createDesktopContract(loadContractSchema());
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SCOPE = uuid(0x5c);
const CONFIRMATION = uuid(0xc1);
const HASH = 'c3'.repeat(32);

type Outcome =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'unknown' }
  | { kind: 'not_sent'; reason: 'not_connected' };

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly scoped?: boolean;
  readonly screenOperation?: boolean;
}

const entry = (over: Record<string, unknown> = {}) => ({
  confirmation_id: CONFIRMATION,
  intent: 'label_mail',
  service: 'gmail',
  account_label: 'synthetic-account',
  target: {
    subject: 'B06-SYNTH 件名',
    sender: null,
    received_at: null,
  },
  add: ['B06-SYNTH-label'],
  remove: [],
  content_version: '1',
  content_hash: HASH,
  conversation_saved: false,
  ...over,
});

function rig() {
  const calls: Call[] = [];
  const logs: string[] = [];
  let refs = 0;
  const state = {
    list: [entry()] as unknown[],
    readable: true,
    decide: (): Outcome => ({
      kind: 'response',
      status: 202,
      body: {
        request_id: uuid(0x901),
        confirmation_id: CONFIRMATION,
        result: 'recorded',
      },
    }),
    mode: 'private' as 'private' | 'normal' | null,
    io: { permitted: true, epoch: '0' },
    // 確認のダイアログの答えと、答える前に行う処理。
    confirm: (): Promise<PrivateConfirmResult> =>
      Promise.resolve({ scope: SCOPE }),
    confirms: [] as PrivateConfirmRequest[],
  };
  const connection = {
    get state() {
      return { commandScopeId: SCOPE, phase: 'live' };
    },
    request: (call: Call): Promise<Outcome> => {
      calls.push(call);
      if (call.method === 'GET')
        return Promise.resolve(
          state.readable
            ? {
                kind: 'response',
                status: 200,
                body: { confirmations: state.list },
              }
            : { kind: 'response', status: 503, body: {} },
        );
      return Promise.resolve(state.decide());
    },
  } as unknown as ClientConnection;
  const bridge = new PrivateConfirmationBridge({
    contract,
    connection: () => connection,
    newRef: () => uuid(0x700 + ++refs),
    storageMode: () => state.mode,
    confirm: (request) => {
      state.confirms.push(request);
      return state.confirm();
    },
    io: () => state.io,
    changed: () => undefined,
    log: (code) => logs.push(code),
  });
  return { bridge, calls, state, logs };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const posts = (calls: readonly Call[]) =>
  calls.filter((call) => call.method === 'POST');

test('lists only during a private conversation and gives the screen a reference and what to change, never the id or the hash', async () => {
  const { bridge, state } = rig();
  await bridge.refresh();
  assert.deepEqual(bridge.entries(), [
    {
      ref: uuid(0x701),
      service: 'gmail',
      account_label: 'synthetic-account',
      target: { subject: 'B06-SYNTH 件名', sender: null, received_at: null },
      labels_add: ['B06-SYNTH-label'],
      labels_remove: [],
      approvable: true,
      delivery_unknown: false,
    },
  ]);
  assert(!JSON.stringify(bridge.entries()).includes(CONFIRMATION));
  assert(!JSON.stringify(bridge.entries()).includes(HASH));
  // 記録しない会話の外・保存モード不明では出さない（送らない）。
  state.mode = 'normal';
  assert.deepEqual(bridge.entries(), []);
  assert.deepEqual(await bridge.decide(uuid(0x701), 'approve'), {
    ok: false,
    reason: 'entry_not_found',
  });
  state.mode = null;
  assert.deepEqual(bridge.entries(), []);
  // 読めなかったら前の一覧のまま（「確認なし」とみなさない）。
  state.mode = 'private';
  state.readable = false;
  await bridge.refresh();
  assert.equal(bridge.entries().length, 1);
});

test('one approval sends content version and hash once, as a screen operation, after one dialog', async () => {
  const { bridge, calls, state } = rig();
  await bridge.refresh();
  // 中枢は承認した確認を一覧から外す。
  const recorded = state.decide;
  state.decide = () => {
    state.list = [];
    return recorded();
  };
  assert.deepEqual(await bridge.decide(uuid(0x701), 'approve'), {
    ok: true,
    value: 'recorded',
  });
  assert.deepEqual(state.confirms, [
    {
      action: 'approve_private_confirmation',
      service: 'gmail',
      accountLabel: 'synthetic-account',
      target: { subject: 'B06-SYNTH 件名', sender: null, received_at: null },
      labelsAdd: ['B06-SYNTH-label'],
      labelsRemove: [],
    },
  ]);
  assert.deepEqual(posts(calls), [
    {
      method: 'POST',
      path: `/v1/private-confirmations/${CONFIRMATION}/approve`,
      body: { content_version: '1', content_hash: HASH },
      scoped: true,
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
  // 受け付けた確認は隠し（読み直しで中枢の一覧からも消える）、二度押しでは送らない。
  assert.deepEqual(bridge.entries(), []);
  await settle();
  assert.deepEqual(bridge.entries(), []);
  assert.deepEqual(await bridge.decide(uuid(0x701), 'approve'), {
    ok: false,
    reason: 'entry_not_found',
  });
  assert.equal(posts(calls).length, 1);
});

test('an unidentified target is not approvable, stopped I/O refuses approval but not decline, and declining has no dialog', async () => {
  const { bridge, calls, state } = rig();
  state.list = [entry({ account_label: null })];
  await bridge.refresh();
  assert.equal(bridge.entries()[0]?.approvable, false);
  assert.deepEqual(await bridge.decide(uuid(0x701), 'approve'), {
    ok: false,
    reason: 'core_rejected',
  });
  state.list = [entry()];
  await bridge.refresh();
  state.io = { permitted: false, epoch: '0' };
  assert.deepEqual(await bridge.decide(uuid(0x701), 'approve'), {
    ok: false,
    reason: 'input_stopped',
  });
  assert.equal(posts(calls).length, 0);
  state.decide = () => ({
    kind: 'response',
    status: 202,
    body: {
      request_id: uuid(0x901),
      confirmation_id: CONFIRMATION,
      result: 'declined',
    },
  });
  assert.deepEqual(await bridge.decide(uuid(0x701), 'decline'), {
    ok: true,
    value: 'declined',
  });
  assert.equal(state.confirms.length, 0);
  assert.deepEqual(posts(calls)[0]?.body, {});
  assert.equal(posts(calls)[0]?.path.endsWith('/decline'), true);
});

test('a change, a lock or a stop while the dialog is open sends nothing', async () => {
  const { bridge, calls, state } = rig();
  await bridge.refresh();
  // ダイアログの間に中枢の確認が変わった（別の内容の確認に置き換わった）。
  state.confirm = async () => {
    state.list = [entry({ content_hash: 'd4'.repeat(32) })];
    await bridge.refresh();
    return { scope: SCOPE };
  };
  assert.deepEqual(await bridge.decide(uuid(0x701), 'approve'), {
    ok: false,
    reason: 'preview_stale',
  });
  // ダイアログの間にロック・切断（世代が進んだ）。
  state.confirm = () => {
    bridge.reset();
    return Promise.resolve({ scope: SCOPE });
  };
  await bridge.refresh();
  const ref = bridge.entries()[0]?.ref as string;
  assert.deepEqual(await bridge.decide(ref, 'approve'), {
    ok: false,
    reason: 'not_connected',
  });
  // ダイアログの間に入出力が止まった。
  await bridge.refresh();
  const again = bridge.entries()[0]?.ref as string;
  state.confirm = () => {
    state.io = { permitted: false, epoch: '0' };
    return Promise.resolve({ scope: SCOPE });
  };
  assert.deepEqual(await bridge.decide(again, 'approve'), {
    ok: false,
    reason: 'input_stopped',
  });
  // ダイアログで「やめる」。
  state.io = { permitted: true, epoch: '0' };
  state.confirm = () => Promise.resolve('confirmation_declined');
  assert.deepEqual(await bridge.decide(again, 'approve'), {
    ok: false,
    reason: 'confirmation_declined',
  });
  assert.equal(posts(calls).length, 0);
});

test('an unknown outcome is not resent: the entry is held until a later read, and a rejection reads the list again', async () => {
  const { bridge, calls, state, logs } = rig();
  await bridge.refresh();
  state.decide = () => ({ kind: 'unknown' });
  // 読み直しの応答を一時止めて、保留の間の表示と操作を確かめる。
  state.readable = false;
  assert.deepEqual(await bridge.decide(uuid(0x701), 'approve'), {
    ok: false,
    reason: 'outcome_unknown',
  });
  await settle();
  assert.equal(bridge.entries()[0]?.delivery_unknown, true);
  assert.deepEqual(await bridge.decide(uuid(0x701), 'decline'), {
    ok: false,
    reason: 'entry_not_found',
  });
  assert.equal(posts(calls).length, 1);
  assert(logs.includes('private_confirmation_outcome_unknown'));
  // 後の読み取りが成功したら保留を解く（中枢の一覧にまだあれば、本人がもう一度押せる）。
  state.readable = true;
  await bridge.refresh();
  assert.equal(bridge.entries()[0]?.delivery_unknown, false);
  // 中枢の拒否（取り下げ済みなど）は読み直す。
  state.decide = () => ({
    kind: 'response',
    status: 409,
    body: { code: 'conflict' },
  });
  const gets = calls.filter((call) => call.method === 'GET').length;
  assert.deepEqual(await bridge.decide(uuid(0x701), 'decline'), {
    ok: false,
    reason: 'core_rejected',
  });
  await settle();
  assert.equal(calls.filter((call) => call.method === 'GET').length, gets + 1);
  assert(logs.includes('private_confirmation_rejected:409'));
});
