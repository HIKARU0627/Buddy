// 返信の下書きの保存（RemoteMutation、B04-07・Issue #106）を、同じプロセスの Core（127.0.0.1 の HTTPS）・模擬 provider
// （127.0.0.1 の HTTP、状態は Core と別のディレクトリ）・アダプター・故障注入で確かめる。
// 期待値（宛先・件名・本文・目印・content_hash・要求と変更の回数・最終状態）は、この試験に手で書いた値。
// content_hash は手で書いた正規形の文字列（キーの辞書順・空白なし）の SHA-256 で、実装の正規化を使っていない。
// 待ち合わせは故障点の関門と runner.idle() で行い、固定時間の sleep を使わない。模擬だけで、実機・実 API は未実施。

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { FaultInjector } from '@buddy/connectors/testing';
import {
  approve,
  approveBody,
  cancel,
  postJson,
} from './event-test-support.js';
import { draftSaveObserved } from './operation-runner.js';
import {
  DRAFT_TEXT,
  approveOperation,
  createOperation,
  idle,
  operationOf,
  preview,
  reached,
  reconcile,
  recordOf,
  session,
  startCore,
  snapshotOperations,
  startRig,
  turn,
} from './operation-runner-test-support.js';
import { createMockInterpreter } from './turn-ports.js';
import { withTimeout } from './api-test-support.js';

const TIMEOUT = 60_000;

// 発言の DB の照会（turn.find）を 1 回だけ止める関門。止まったことを reached で知らせ、release で再開する。
function holdTurnFind(t: test.TestContext, store: object) {
  const target = store as {
    conversation: (op: { readonly kind: string }) => Promise<unknown>;
  };
  const original = target.conversation.bind(target);
  let armed: { reached: () => void; released: Promise<void> } | null = null;
  t.mock.method(target, 'conversation', async (op: { kind: string }) => {
    if (op.kind === 'turn.find' && armed !== null) {
      const gate = armed;
      armed = null;
      gate.reached();
      await gate.released;
    }
    return original(op);
  });
  return () => {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    armed = { reached, released };
    return {
      reached: withTimeout(reachedPromise, 20_000, 'turn.find の関門'),
      release,
    };
  };
}

test(
  'label and draft: when another request updates the remembered permission while the message waits for the DB, the message is asked back (revision and account)',
  { timeout: TIMEOUT },
  async (t) => {
    const LABEL_TEXT = 'mail-001 に follow-up を付けて';
    for (const text of [DRAFT_TEXT, LABEL_TEXT])
      for (const change of ['revision', 'account'] as const) {
        const name = `${text} / ${change}`;
        const rig = await startRig(t);
        const core = await startCore(t, rig);
        const who = await session(core);
        const arm = holdTurnFind(t, core.handle.store);
        const gate = arm();
        // 発言を受け、DB の照会（turn.find）で止める。入力の時点の値は口座 A・版 1。
        const held = turn(core, who, text);
        await gate.reached;
        // 待っている間に、版（1 → 2）か接続先のアカウント（A → B）が変わり、別の要求が覚えている値を更新する。
        if (change === 'revision')
          rig.provider.truth.setPermission({ permission_revision: '2' });
        else rig.ports.accountOverride = '00000000-0000-4000-8000-0000000000bb';
        const other = await turn(core, who, LABEL_TEXT);
        assert.equal(other['status'], 'clarification', name);
        gate.release();
        const asked = await held;
        assert.equal(asked['status'], 'clarification', name);
        assert.equal(
          asked['reply_text'],
          '今は進められません。少し待ってからもう一度お願いします。',
          name,
        );
        assert.equal(await snapshotOperations(core, who), 0, name);
        assert.equal(rig.provider.truth.requestCount(), 0, name);
      }
  },
);

test(
  'label and draft: a permission revision that changes from 1 to 2 while the message is interpreted is asked back and makes no operation',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    // 解釈の間に許可の版を 1 → 2 に変える（範囲は変えない）。
    const mock = createMockInterpreter();
    let changeDuring: string | null = null;
    const core = await startCore(t, rig, {
      interpreter: {
        interpret: (context) => {
          if (changeDuring !== null)
            rig.provider.truth.setPermission({
              permission_revision: changeDuring,
            });
          return mock.interpret(context);
        },
      },
    });
    const who = await session(core);
    for (const [made, text, revision] of [
      [0, DRAFT_TEXT, '2'],
      [1, 'mail-001 に follow-up を付けて', '3'],
    ] as const) {
      changeDuring = revision;
      const asked = await turn(core, who, text);
      assert.equal(asked['status'], 'clarification', text);
      assert.equal(
        asked['reply_text'],
        '今は進められません。少し待ってからもう一度お願いします。',
        text,
      );
      // 聞き返しでは操作を増やさない（前の言い直しで作った操作だけ）。
      assert.equal(await snapshotOperations(core, who), made, text);
      // 版が変わらなければ（同じ発言の言い直し）、新しい版で操作を作れる。
      changeDuring = null;
      const again = await turn(core, who, text);
      assert.equal(again['status'], 'answered', text);
      const shown = await preview(
        core,
        who,
        String(
          (
            (again['result_view'] as Record<string, unknown>)['item_refs'] as {
              id: string;
            }[]
          )[0]?.id,
        ),
      );
      assert.equal(
        (shown.json?.['intent'] as Record<string, unknown>)[
          'permission_revision'
        ],
        revision,
        text,
      );
    }
    assert.equal(await snapshotOperations(core, who), 2);
    assert.equal(rig.provider.truth.requestCount(), 0);
  },
);
const ACCOUNT = '00000000-0000-4000-8000-000000000002';

// 手で決めた下書きの内容（返信元は合成の mail-001）。
const EXPECTED_DRAFT = {
  in_reply_to: 'mail-001',
  to: ['synthetic-sender@example.com'],
  cc: [],
  subject: 'Re: （合成）来週の打ち合わせの日程',
  body: '（合成）承知しました。',
};

// 手で書いた確定 intent の正規形（JCS: キーの辞書順・空白なし・非 ASCII はそのまま）。
const canonicalIntent = (operationId: string, contentVersion = '1') =>
  `{"account_id":"${ACCOUNT}","action":{"body":"（合成）承知しました。","cc":[],"kind":"mail.draft.create","subject":"Re: （合成）来週の打ち合わせの日程","to":["synthetic-sender@example.com"]},"content_version":"${contentVersion}","effects":{"external_recipients":[],"reconcile_scope":"operation_marker"},"operation_id":"${operationId}","permission_revision":"1","provider":"mock","schema":"buddy.operation.v1","target":{"remote_id":"mail-001","source_revision":"r1"}}`;

const sha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const draftsOf = (rig: Awaited<ReturnType<typeof startRig>>) =>
  Object.values(rig.provider.truth.snapshot().drafts).map((draft) => ({
    marker: draft.marker,
    in_reply_to: draft.in_reply_to,
    to: draft.to,
    cc: draft.cc,
    subject: draft.subject,
    body: draft.body,
    status: draft.status,
  }));

const expectedDraft = (operationId: string) => ({
  marker: `buddy-op:${operationId}:1`,
  ...EXPECTED_DRAFT,
  status: 'draft',
});

test(
  'draft save: the message makes an awaiting operation whose preview shows the account, the reply source and the body; one approval saves it once',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);
    const operationId = await createOperation(core, who, DRAFT_TEXT);
    // 作っただけでは外部へ何も送らない。
    assert.equal(rig.ports.counts.write, 0);
    assert.equal(rig.provider.truth.requestCount(), 0);
    const created = await operationOf(core, who, operationId);
    assert.equal(created['state'], 'awaiting_approval');
    assert.equal(created['operation_kind'], 'mail.draft.create');

    const shown = await preview(core, who, operationId);
    assert.equal(shown.status, 200, shown.text);
    assert.equal(
      shown.json?.['content_hash'],
      sha256(canonicalIntent(operationId)),
    );
    assert.deepEqual(shown.json?.['intent'], {
      schema: 'buddy.operation.v1',
      operation_id: operationId,
      content_version: '1',
      permission_revision: '1',
      provider: 'mock',
      account_id: ACCOUNT,
      target: { remote_id: 'mail-001', source_revision: 'r1' },
      action: {
        kind: 'mail.draft.create',
        to: ['synthetic-sender@example.com'],
        cc: [],
        subject: 'Re: （合成）来週の打ち合わせの日程',
        body: '（合成）承知しました。',
      },
      effects: { external_recipients: [], reconcile_scope: 'operation_marker' },
    });
    // 保存先のアカウントと返信元のメール（表示用。hash に含めない）。
    assert.deepEqual(shown.json?.['display'], {
      account_label: 'synthetic-user@example.com',
      target: {
        subject: '（合成）来週の打ち合わせの日程',
        sender: 'synthetic-sender@example.com',
        received_at: '2026-10-04T18:30:00+09:00',
      },
    });

    const { body } = await approveOperation(core, who, operationId);
    await idle(core);
    const done = await operationOf(core, who, operationId);
    assert.equal(done['state'], 'succeeded');
    const result = done['result'] as Record<string, unknown>;
    assert.equal(result['status'], 'confirmed_success');
    assert.equal(result['provider_receipt_id'], 'draft-001');
    // 送出の境界: 1 工程（1-create_draft）を送出意図つきで記録し、成功で確定。
    assert.deepEqual(await recordOf(core, operationId), {
      state: 'succeeded',
      approvals: 1,
      attempts: 1,
      steps: [
        {
          step_id: '1-create_draft',
          intent: true,
          result_status: 'confirmed_success',
        },
      ],
    });
    assert.equal(rig.provider.truth.requestCount(), 1);
    assert.equal(rig.provider.truth.stateChangeCount(), 1);
    assert.deepEqual(draftsOf(rig), [expectedDraft(operationId)]);
    const receipt = rig.provider.truth.receipts()[0];
    assert.equal(receipt?.operation_id, operationId);
    assert.equal(receipt?.step_id, '1-create_draft');
    // 応答を受け取れたので照合（目印の読み取り）はしない。
    assert.equal(rig.ports.counts.find, 0);
    // 同じ承認の再送は保存済みの結果で、外部へ増やさない。
    const replay = await approve(core, who.device, operationId, body);
    assert.equal(replay.status, 202, replay.text);
    await idle(core);
    assert.equal(rig.provider.truth.requestCount(), 1);
  },
);

test(
  'draft save: a lost response is reconciled once by the marker and succeeds without resending',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);
    const operationId = await createOperation(core, who, DRAFT_TEXT);
    rig.injector.arm('after_external_apply_before_response', {
      mode: 'drop_response',
    });
    await approveOperation(core, who, operationId);
    await idle(core);
    const view = await operationOf(core, who, operationId);
    assert.equal(view['state'], 'succeeded');
    assert.equal(
      (view['result'] as Record<string, unknown>)['provider_receipt_id'],
      'draft-001',
    );
    assert.equal(rig.provider.truth.requestCount(), 1);
    assert.equal(rig.provider.truth.stateChangeCount(), 1);
    assert.equal(rig.provider.truth.receipts()[0]?.responded, false);
    // 自動の照合は 1 回だけ（D4）。書込みは 1 回。
    assert.equal(rig.ports.counts.find, 1);
    assert.equal(rig.ports.counts.write, 1);
    assert.deepEqual(draftsOf(rig), [expectedDraft(operationId)]);
  },
);

test(
  'draft save: a timeout is held as unknown, the late save is not resent, and only the user reconcile confirms it',
  { timeout: TIMEOUT },
  async (t) => {
    const timeout = new AbortController();
    const rig = await startRig(t, { writeSignal: timeout.signal });
    const core = await startCore(t, rig);
    const who = await session(core);
    const operationId = await createOperation(core, who, DRAFT_TEXT);
    rig.injector.arm('response_timeout_then_late_apply', {
      mode: 'hold_then_apply',
    });
    await approveOperation(core, who, operationId);
    await reached(rig.injector, 'response_timeout_then_late_apply');
    timeout.abort();
    await idle(core);
    const held = await operationOf(core, who, operationId);
    assert.equal(held['state'], 'unknown_held');
    assert.deepEqual(held['allowed_actions'], ['reconcile']);
    // 自動の照合は 1 回（まだ適用されていないので見つからない）。未実行とは断定しない。
    assert.equal(rig.ports.counts.find, 1);
    assert.equal(rig.provider.truth.requestCount(), 1);
    assert.equal(rig.provider.truth.stateChangeCount(), 0);
    // 遅れて保存されても、自動では照合も再送もしない。
    assert.equal(rig.provider.truth.releaseLateApplies(), 1);
    await idle(core);
    assert.equal(
      (await operationOf(core, who, operationId))['state'],
      'unknown_held',
    );
    assert.equal(rig.ports.counts.find, 1);
    // 本人の照合（参照だけ）で、目印の下書きを 1 件見つけて成功にする。
    const reconciled = await reconcile(core, who, operationId);
    assert.equal(reconciled.status, 202, reconciled.text);
    await idle(core);
    assert.equal(
      (await operationOf(core, who, operationId))['state'],
      'succeeded',
    );
    assert.equal(rig.ports.counts.find, 2);
    assert.equal(rig.ports.counts.write, 1);
    assert.equal(rig.provider.truth.requestCount(), 1);
    assert.deepEqual(draftsOf(rig), [expectedDraft(operationId)]);
  },
);

test(
  'draft save: a restart after the dispatch intent holds it as unknown and never resends; a restart while preparing sends once',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);

    // 送出意図の後・送る前に中枢だけを止める: 再起動の後は unknown_held、要求 0。
    const held = await createOperation(core, who, DRAFT_TEXT);
    rig.injector.arm('after_dispatch_intent_before_send', { mode: 'pause' });
    await approveOperation(core, who, held);
    await reached(rig.injector, 'after_dispatch_intent_before_send');

    // 対象の確かめ直しの後（送出意図の前）で止まる操作も作る（同じ中枢で、停止の前に）。
    const resumed = await createOperation(core, who, DRAFT_TEXT);
    rig.injector.arm('after_target_recheck', { mode: 'pause' });
    await approveOperation(core, who, resumed);
    await reached(rig.injector, 'after_target_recheck');

    await core.handle.stop('test');
    rig.injector.release('after_dispatch_intent_before_send');
    rig.injector.release('after_target_recheck');
    assert.equal(rig.provider.truth.requestCount(), 0);

    const restarted = await startCore(t, rig, {
      restartOf: core,
      faults: new FaultInjector(),
    });
    assert.deepEqual(restarted.handle.recovery.held, [held]);
    assert.deepEqual(restarted.handle.recovery.resumable, [resumed]);
    await idle(restarted);
    const again = await session(restarted);
    assert.equal(
      (await operationOf(restarted, again, held))['state'],
      'unknown_held',
    );
    assert.deepEqual((await recordOf(restarted, held)).steps, [
      { step_id: '1-create_draft', intent: true, result_status: 'unknown' },
    ]);
    // 確かめ直しから再開した操作は 1 回だけ送って成功する。
    assert.equal(
      (await operationOf(restarted, again, resumed))['state'],
      'succeeded',
    );
    assert.equal(rig.provider.truth.requestCount(), 1);
    assert.equal(rig.provider.truth.receipts()[0]?.operation_id, resumed);
    // 送っていない操作の本人の照合: 目印の下書きがないので保留のまま（未実行と断定しない・再送しない）。
    const reconciled = await reconcile(restarted, again, held);
    assert.equal(reconciled.status, 202, reconciled.text);
    await idle(restarted);
    assert.equal(
      (await operationOf(restarted, again, held))['state'],
      'unknown_held',
    );
    assert.equal(rig.provider.truth.requestCount(), 1);
    assert.deepEqual(draftsOf(rig), [expectedDraft(resumed)]);
  },
);

test(
  'draft save: a cancel before the dispatch intent cancels with no request; after it the cancel is only accepted and the result waits for the user reconcile',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);

    const before = await createOperation(core, who, DRAFT_TEXT);
    rig.injector.arm('after_target_recheck', { mode: 'pause' });
    await approveOperation(core, who, before);
    await reached(rig.injector, 'after_target_recheck');
    const preparing = await operationOf(core, who, before);
    assert.equal(preparing['state'], 'preparing');
    const cancelled = await cancel(core, who.device, before, {
      request_id: randomUUID(),
      command_scope_id: who.scope,
      expected_state_revision: preparing['state_revision'],
    });
    assert.equal(cancelled.status, 202, cancelled.text);
    assert.equal(cancelled.json?.['status'], 'durable');
    rig.injector.release('after_target_recheck');
    await idle(core);
    assert.equal((await operationOf(core, who, before))['state'], 'cancelled');
    assert.equal(rig.provider.truth.requestCount(), 0);

    const after = await createOperation(core, who, DRAFT_TEXT);
    rig.injector.arm('after_dispatch_intent_before_send', { mode: 'pause' });
    await approveOperation(core, who, after);
    await reached(rig.injector, 'after_dispatch_intent_before_send');
    const dispatching = await operationOf(core, who, after);
    assert.equal(dispatching['state'], 'dispatching');
    const accepted = await cancel(core, who.device, after, {
      request_id: randomUUID(),
      command_scope_id: who.scope,
      expected_state_revision: dispatching['state_revision'],
    });
    assert.equal(accepted.status, 202, accepted.text);
    assert.equal(accepted.json?.['status'], 'accepted');
    rig.injector.release('after_dispatch_intent_before_send');
    await idle(core);
    const waiting = await operationOf(core, who, after);
    assert.equal(waiting['state'], 'reconciling');
    assert.deepEqual(waiting['allowed_actions'], ['reconcile']);
    assert.equal(rig.provider.truth.requestCount(), 1);
    const reconciled = await reconcile(core, who, after);
    assert.equal(reconciled.status, 202, reconciled.text);
    await idle(core);
    assert.equal((await operationOf(core, who, after))['state'], 'succeeded');
    assert.equal(rig.provider.truth.requestCount(), 1);
    assert.deepEqual(draftsOf(rig), [expectedDraft(after)]);
  },
);

test(
  'draft save: a different account is refused at the preview and before the dispatch, and nothing is sent',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);
    const other = '00000000-0000-4000-8000-0000000000ee';

    // preview: 接続先が確定 intent の口座と違えば出さない（409）。
    const atPreview = await createOperation(core, who, DRAFT_TEXT);
    rig.ports.accountOverride = other;
    const refused = await preview(core, who, atPreview);
    assert.equal(refused.status, 409, refused.text);
    // 内容の表示用の読み取りでも、別の口座の表示名・返信元のメールを読まない。
    const display = await postJson(
      core,
      who.device,
      `/v1/operations/${atPreview}/display`,
      { request_id: randomUUID(), command_scope_id: who.scope },
    );
    assert.equal(display.status, 200, display.text);
    assert.deepEqual(display.json?.['display'], {
      account_label: null,
      target: null,
    });
    rig.ports.accountOverride = null;

    // 承認の後に接続先が替わった: 確かめ直しで止め、送らずに準備のまま残す（本人の取消か再開を待つ）。
    const atDispatch = await createOperation(core, who, DRAFT_TEXT);
    rig.injector.arm('after_approval_save', { mode: 'pause' });
    await approveOperation(core, who, atDispatch);
    await reached(rig.injector, 'after_approval_save');
    rig.ports.accountOverride = other;
    rig.injector.release('after_approval_save');
    await idle(core);
    assert.equal(
      (await operationOf(core, who, atDispatch))['state'],
      'preparing',
    );
    assert.equal(rig.ports.counts.write, 0);
    assert.equal(rig.provider.truth.requestCount(), 0);
    assert.deepEqual(draftsOf(rig), []);
  },
);

test(
  'draft save: without the draft scope the message is asked back, and a scope removed after approval sends nothing',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);

    // 本文がなければ聞き返し（操作を作らない）。
    const noBody = await turn(core, who, 'mail-001 に返信の下書きを保存して');
    assert.equal(noBody['status'], 'clarification');
    assert.equal(noBody['reply_text'], '下書きの本文を教えてください。');

    // 承認の後に下書きの範囲だけが外れた（許可の版は同じ）: 送らずに準備のまま。
    const operationId = await createOperation(core, who, DRAFT_TEXT);
    rig.injector.arm('after_approval_save', { mode: 'pause' });
    await approveOperation(core, who, operationId);
    await reached(rig.injector, 'after_approval_save');
    rig.provider.truth.setPermission({
      scopes: ['mail.read', 'calendar.read', 'mail.labels.change'],
    });
    rig.injector.release('after_approval_save');
    await idle(core);
    assert.equal(
      (await operationOf(core, who, operationId))['state'],
      'preparing',
    );
    assert.equal(rig.provider.truth.requestCount(), 0);

    // 範囲がない間の発言は、接続が使えないとして聞き返す。
    const refused = await turn(core, who, DRAFT_TEXT);
    assert.equal(refused['status'], 'clarification');
    assert.equal(
      refused['reply_text'],
      '連携の接続が使えません。接続を確かめてください。',
    );
    // ラベルの変更は同じ接続で引き続き作れる（範囲は種類ごと）。
    const label = await turn(core, who, 'mail-001 に follow-up を付けて');
    assert.equal(label['status'], 'answered');
  },
);

// 返信元の差出人・件名が変わった後の内容版 2 の正規形（手で書いた値。宛先と件名を作り直し、本文はそのまま）。
const canonicalRevised = (operationId: string) =>
  `{"account_id":"${ACCOUNT}","action":{"body":"（合成）承知しました。","cc":[],"kind":"mail.draft.create","subject":"Re: （合成）日程の再調整","to":["synthetic-other@example.com"]},"content_version":"2","effects":{"external_recipients":[],"reconcile_scope":"operation_marker"},"operation_id":"${operationId}","permission_revision":"1","provider":"mock","schema":"buddy.operation.v1","target":{"remote_id":"mail-001","source_revision":"r2"}}`;

test(
  'draft save: a reply source changed after approval sends nothing and returns to approval with content version 2, the new recipient and subject, and a new marker',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);
    const operationId = await createOperation(core, who, DRAFT_TEXT);
    rig.injector.arm('after_approval_save', { mode: 'pause' });
    await approveOperation(core, who, operationId);
    await reached(rig.injector, 'after_approval_save');
    // 返信元の版・差出人・件名が変わる。
    rig.provider.truth.updateMail('mail-001', {
      source_revision: 'r2',
      from: 'synthetic-other@example.com',
      subject: '（合成）日程の再調整',
    });
    rig.injector.release('after_approval_save');
    await idle(core);
    const revised = await operationOf(core, who, operationId);
    assert.equal(revised['state'], 'awaiting_approval');
    assert.equal(revised['content_version'], '2');
    assert.equal(rig.provider.truth.requestCount(), 0);
    // 新しい内容版の preview: 宛先・件名は読み直した返信元から作り直した値。hash は手で書いた正規形。
    const shown = await preview(core, who, operationId);
    assert.equal(shown.status, 200, shown.text);
    assert.equal(
      shown.json?.['content_hash'],
      sha256(canonicalRevised(operationId)),
    );
    const intent = shown.json?.['intent'] as Record<string, unknown>;
    assert.deepEqual(intent['action'], {
      kind: 'mail.draft.create',
      to: ['synthetic-other@example.com'],
      cc: [],
      subject: 'Re: （合成）日程の再調整',
      body: '（合成）承知しました。',
    });
    assert.deepEqual(intent['target'], {
      remote_id: 'mail-001',
      source_revision: 'r2',
    });
    assert.deepEqual(shown.json?.['display'], {
      account_label: 'synthetic-user@example.com',
      target: {
        subject: '（合成）日程の再調整',
        sender: 'synthetic-other@example.com',
        received_at: '2026-10-04T18:30:00+09:00',
      },
    });
    // approveBody は内容版 1 を入れるので、内容版 2 に書き換える。
    const retried = await approve(core, who.device, operationId, {
      ...approveBody(who.scope, {
        previewId: String(shown.json?.['preview_id']),
        hash: String(shown.json?.['content_hash']),
        expected: String(revised['state_revision']),
      }),
      content_version: '2',
    });
    assert.equal(retried.status, 202, retried.text);
    await idle(core);
    assert.equal(
      (await operationOf(core, who, operationId))['state'],
      'succeeded',
    );
    assert.equal(rig.provider.truth.requestCount(), 1);
    assert.deepEqual(draftsOf(rig), [
      {
        marker: `buddy-op:${operationId}:2`,
        in_reply_to: 'mail-001',
        to: ['synthetic-other@example.com'],
        cc: [],
        subject: 'Re: （合成）日程の再調整',
        body: '（合成）承知しました。',
        status: 'draft',
      },
    ]);
  },
);

test(
  'draft save: without the mail read scope the reply source is not read, the preview is refused, and an approved draft is not sent',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);
    const approved = await createOperation(core, who, DRAFT_TEXT);
    const pending = await createOperation(core, who, DRAFT_TEXT);
    rig.injector.arm('after_approval_save', { mode: 'pause' });
    await approveOperation(core, who, approved);
    await reached(rig.injector, 'after_approval_save');
    // メールの読み取りの範囲だけが外れる（許可の版・書込みの範囲は同じ）。
    rig.provider.truth.setPermission({
      scopes: [
        'calendar.read',
        'mail.labels.change',
        'mail.drafts.create',
        'mail.drafts.send',
      ],
    });
    const readsBefore = rig.ports.counts.read;
    rig.injector.release('after_approval_save');
    await idle(core);
    // 送る前の確かめ直しで止まり、準備のまま。返信元は読んでいない（接続と許可の 2 回だけ）。
    assert.equal(
      (await operationOf(core, who, approved))['state'],
      'preparing',
    );
    assert.equal(rig.ports.counts.read - readsBefore, 2);
    assert.equal(rig.provider.truth.requestCount(), 0);
    // preview は出さない。内容の表示用の読み取りでも件名・差出人を読まない。
    const refused = await preview(core, who, pending);
    assert.equal(refused.status, 409, refused.text);
    const display = await postJson(
      core,
      who.device,
      `/v1/operations/${pending}/display`,
      { request_id: randomUUID(), command_scope_id: who.scope },
    );
    assert.equal(display.status, 200, display.text);
    assert.deepEqual(display.json?.['display'], {
      account_label: 'synthetic-user@example.com',
      target: null,
    });
    // 発言: 下書きもラベルも、返信元・対象を読まずに聞き返す。
    for (const text of [DRAFT_TEXT, 'mail-001 に follow-up を付けて']) {
      const before = rig.ports.counts.read;
      const asked = await turn(core, who, text);
      assert.equal(asked['status'], 'clarification', text);
      assert.equal(
        asked['reply_text'],
        '連携の接続が使えません。接続を確かめてください。',
      );
      // 意味検証の接続の 1 回だけ（入力の時点の許可の版は Core のメモリーから取る）。対象のメールは読まない。
      assert.equal(rig.ports.counts.read - before, 1, text);
    }
    assert.equal(rig.provider.truth.requestCount(), 0);
  },
);

test(
  'draft save and label: removing only that kind of write scope after the preview makes the approval 409 and nothing is sent',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);
    const all = [
      'mail.read',
      'calendar.read',
      'mail.labels.change',
      'mail.drafts.create',
      'mail.drafts.send',
    ];
    for (const [text, removed] of [
      [DRAFT_TEXT, 'mail.drafts.create'],
      ['mail-001 に follow-up を付けて', 'mail.labels.change'],
    ] as const) {
      rig.provider.truth.setPermission({ scopes: all });
      const operationId = await createOperation(core, who, text);
      const shown = await preview(core, who, operationId);
      assert.equal(shown.status, 200, shown.text);
      // その種類の書込みの範囲だけを外す（許可の版は同じ・別の種類の書込みの範囲は残る）。
      rig.provider.truth.setPermission({
        scopes: all.filter((scope) => scope !== removed),
      });
      const refused = await approve(
        core,
        who.device,
        operationId,
        approveBody(who.scope, {
          previewId: String(shown.json?.['preview_id']),
          hash: String(shown.json?.['content_hash']),
        }),
      );
      assert.equal(refused.status, 409, `${text}: ${refused.text}`);
      await idle(core);
      assert.deepEqual(await recordOf(core, operationId), {
        state: 'awaiting_approval',
        approvals: 0,
        attempts: 0,
        steps: [],
      });
    }
    assert.equal(rig.ports.counts.write, 0);
    assert.equal(rig.provider.truth.requestCount(), 0);
  },
);

test('draft save: the marker lookup counts only drafts with the same marker and the same reply source', () => {
  const marker = 'buddy-op:00000000-0000-4000-8000-0000000000a7:1';
  const intent = { marker, remote_id: 'mail-001' };
  const draft = (draft_id: string, m: string, in_reply_to: string | null) => ({
    draft_id,
    marker: m,
    in_reply_to,
  });
  assert.deepEqual(draftSaveObserved([], intent), { kind: 'not_found' });
  assert.deepEqual(
    draftSaveObserved([draft('draft-001', marker, 'mail-001')], intent),
    { kind: 'found', external_id: 'draft-001' },
  );
  // 内容版の違う目印の下書きは数えない。
  assert.deepEqual(
    draftSaveObserved(
      [
        draft(
          'draft-001',
          'buddy-op:00000000-0000-4000-8000-0000000000a7:2',
          'mail-001',
        ),
      ],
      intent,
    ),
    { kind: 'not_found' },
  );
  // 同じ目印が 2 件: 重複の可能性があり、成功にしない。
  assert.deepEqual(
    draftSaveObserved(
      [
        draft('draft-001', marker, 'mail-001'),
        draft('draft-002', marker, 'mail-001'),
      ],
      intent,
    ),
    { kind: 'multiple', count: 2 },
  );
  // 同じ目印で返信元が違う: Buddy の作成物として説明できないので確かめられない扱い。
  assert.deepEqual(
    draftSaveObserved([draft('draft-001', marker, 'mail-999')], intent),
    { kind: 'unreadable' },
  );
});
