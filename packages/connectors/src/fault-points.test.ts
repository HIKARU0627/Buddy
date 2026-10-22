// 故障点の再現の試験（tests/integration/fault-points.json の X02・X05〜X08・X10 の provider 側と Core 側の関門）。
// 期待値は fault-points.json の手書きの値を写した。Core の状態機械の合格は B04 の後続の Issue で試験する。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  FAULT_POINTS,
  FaultInjector,
  InjectedFaultError,
  createMockMailConnector,
} from './index.js';
import { PROVIDER_FAULT_POINTS } from './testing.js';
import {
  onCleanup,
  startProvider,
  TEST_TIMEOUT_MS,
  withTimeout,
} from './test-support.js';

const OPTIONS = { timeout: TEST_TIMEOUT_MS };
const LABEL = { remote_id: 'mail-001', add: ['follow-up'], remove: [] };

test('故障点の名前は fault-points.json の fault_points と同じ', OPTIONS, () => {
  const spec = JSON.parse(
    readFileSync(
      new URL('../../../tests/integration/fault-points.json', import.meta.url),
      'utf8',
    ),
  ) as {
    fault_points: Record<string, string>;
    cases: { faults: string[] }[];
  };
  assert.deepEqual(
    [...FAULT_POINTS].sort(),
    Object.keys(spec.fault_points).sort(),
  );
  for (const item of spec.cases)
    for (const fault of item.faults)
      assert.ok((FAULT_POINTS as readonly string[]).includes(fault), fault);
  assert.deepEqual(
    [...PROVIDER_FAULT_POINTS],
    [
      'after_external_apply_before_response',
      'response_timeout_then_late_apply',
    ],
  );
});

test(
  'X07: 外部適用後・応答前に切れると結果不明になり、再送せず、正確な照合で適用済みと分かる',
  OPTIONS,
  async (t) => {
    const injector = new FaultInjector();
    const provider = await startProvider(t, { injector });
    const connector = createMockMailConnector({ baseUrl: provider.url });
    injector.arm('after_external_apply_before_response', {
      mode: 'drop_response',
    });

    const outcome = await connector.changeLabels(
      { operation_id: 'op-x07', attempt_id: 'attempt-1' },
      LABEL,
    );
    assert.deepEqual(outcome, { kind: 'unknown', reason: 'connection_lost' });

    // 照合（読み取り）の後でも、要求は 1 件・変更は 1 件のまま（自動再送 0）。
    assert.deepEqual((await connector.readTarget('mail-001'))?.labels, [
      'follow-up',
    ]);
    assert.equal(provider.truth.requestCount(), 1);
    assert.equal(provider.truth.stateChangeCount(), 1);
    const [receipt] = provider.truth.receipts();
    assert.equal(receipt?.responded, false);
    assert.equal(receipt?.applied_change?.kind, 'mail.labels.change');
  },
);

test(
  'X08: 応答の時間切れの後に provider が遅れて適用する（それまでは未適用、再送 0）',
  OPTIONS,
  async (t) => {
    const injector = new FaultInjector();
    const provider = await startProvider(t, { injector });
    const connector = createMockMailConnector({
      baseUrl: provider.url,
      timeoutMs: 200,
    });
    injector.arm('response_timeout_then_late_apply', {
      mode: 'hold_then_apply',
    });

    const outcome = await connector.changeLabels(
      { operation_id: 'op-x08', attempt_id: 'attempt-1' },
      LABEL,
    );
    assert.deepEqual(outcome, { kind: 'unknown', reason: 'timeout' });
    assert.equal(provider.truth.heldCount(), 1);
    assert.equal(provider.truth.stateChangeCount(), 0);
    assert.deepEqual((await connector.readTarget('mail-001'))?.labels, []);

    assert.equal(provider.truth.releaseLateApplies(), 1);
    assert.equal(provider.truth.heldCount(), 0);
    assert.equal(provider.truth.requestCount(), 1);
    assert.equal(provider.truth.stateChangeCount(), 1);
    assert.deepEqual((await connector.readTarget('mail-001'))?.labels, [
      'follow-up',
    ]);
    assert.equal(provider.truth.receipts()[0]?.responded, false);
  },
);

test(
  'X10: 下書きの作成の工程だけに故障を注入でき、送信の工程は影響を受けない',
  OPTIONS,
  async (t) => {
    const injector = new FaultInjector();
    const provider = await startProvider(t, { injector });
    const connector = createMockMailConnector({ baseUrl: provider.url });
    injector.arm(
      'after_external_apply_before_response',
      { mode: 'drop_response' },
      { match: { step_id: 'create_draft' } },
    );

    const created = await connector.createDraft(
      {
        operation_id: 'op-x10',
        attempt_id: 'attempt-1',
        step_id: 'create_draft',
      },
      {
        to: ['synthetic-recipient'],
        subject: '（合成）件名',
        body: '（合成）本文',
      },
    );
    assert.deepEqual(created, { kind: 'unknown', reason: 'connection_lost' });
    // 正確な lookup（operation_id と step_id）で、作成済みの下書きを 1 件だけ見つける。
    const found = await connector.lookupDrafts({
      operation_id: 'op-x10',
      step_id: 'create_draft',
    });
    assert.equal(found.length, 1);
    const draftId = found[0]?.draft_id ?? '';

    const sent = await connector.sendDraft(
      { operation_id: 'op-x10', attempt_id: 'attempt-2', step_id: 'send' },
      draftId,
    );
    assert.equal(sent.kind, 'applied');
    assert.equal(provider.truth.requestCount(), 2);
    assert.equal(provider.truth.stateChangeCount(), 2);
    assert.equal(provider.truth.snapshot().drafts[draftId]?.send_count, 1);
  },
);

test(
  'X02: approval_barrier は 3 件がそろうまで全員を待たせ、そろった瞬間に一斉に解放する',
  OPTIONS,
  async () => {
    const injector = new FaultInjector();
    injector.arm('approval_barrier', { mode: 'barrier', parties: 3 });
    const released: string[] = [];
    const enter = (name: string): Promise<void> =>
      injector.hit('approval_barrier').then(() => {
        released.push(name);
      });

    const a = enter('device_a');
    const b = enter('device_b');
    await withTimeout(
      injector.waitReached('approval_barrier', 2),
      5_000,
      'reach 2',
    );
    // 2 件が来ても、3 件目が来るまでは誰も進めない。
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(released, []);

    const c = enter('device_a_double_click');
    await withTimeout(Promise.all([a, b, c]), 5_000, 'release all');
    assert.deepEqual([...released].sort(), [
      'device_a',
      'device_a_double_click',
      'device_b',
    ]);
    assert.equal(injector.hitCount('approval_barrier'), 3);
  },
);

test(
  'X05・X06: Core の地点で止める（pause）・打ち切る（throw）・条件に一致したものだけに効く',
  OPTIONS,
  async () => {
    const injector = new FaultInjector();
    injector.arm(
      'after_dispatch_intent_before_send',
      { mode: 'pause' },
      {
        match: { operation_id: 'op-target' },
      },
    );
    injector.arm('before_result_save', { mode: 'throw' });

    // 条件に一致しない operation_id は止まらない。
    await injector.hit('after_dispatch_intent_before_send', {
      operation_id: 'op-other',
    });

    let resumed = false;
    const paused = injector
      .hit('after_dispatch_intent_before_send', { operation_id: 'op-target' })
      .then(() => {
        resumed = true;
      });
    await withTimeout(
      injector.waitReached('after_dispatch_intent_before_send', 2),
      5_000,
      'paused',
    );
    await Promise.resolve();
    assert.equal(resumed, false);
    injector.release('after_dispatch_intent_before_send');
    await withTimeout(paused, 5_000, 'resume');
    assert.equal(resumed, true);

    await assert.rejects(
      injector.hit('before_result_save'),
      (error: unknown) =>
        error instanceof InjectedFaultError &&
        error.point === 'before_result_save',
    );
    // 注入は 1 回だけ。2 回目は通る。
    await injector.hit('before_result_save');
    assert.equal(injector.hitCount('before_result_save'), 2);
  },
);

test(
  'provider 用の指定を Core の地点に使うと、黙って通さず失敗する',
  OPTIONS,
  async () => {
    const injector = new FaultInjector();
    injector.arm('after_target_recheck', { mode: 'drop_response' });
    await assert.rejects(injector.hit('after_target_recheck'), /使えない指定/);
  },
);

async function countingServer(
  t: test.TestContext,
  onRequest: (count: number, req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ readonly url: string; readonly count: () => number }> {
  let count = 0;
  const server: Server = createServer((req, res) => {
    count += 1;
    onRequest(count, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onCleanup(
    t,
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, count: () => count };
}

test(
  'アダプターは書込みを再送しない: 切断・5xx・時間切れのどれでも送るのは 1 回',
  OPTIONS,
  async (t) => {
    const reset = await countingServer(t, (_count, req) =>
      req.socket.destroy(),
    );
    const failing = await countingServer(t, (_count, _req, res) => {
      res.writeHead(503).end('{}');
    });
    const silent = await countingServer(t, () => undefined);
    const identity = { operation_id: 'op-retry', attempt_id: 'attempt-1' };

    const a = await createMockMailConnector({
      baseUrl: reset.url,
    }).changeLabels(identity, LABEL);
    assert.deepEqual(a, { kind: 'unknown', reason: 'connection_lost' });
    const b = await createMockMailConnector({
      baseUrl: failing.url,
    }).changeLabels(identity, LABEL);
    assert.deepEqual(b, { kind: 'unknown', reason: 'server_error' });
    const c = await createMockMailConnector({
      baseUrl: silent.url,
      timeoutMs: 200,
    }).changeLabels(identity, LABEL);
    assert.deepEqual(c, { kind: 'unknown', reason: 'timeout' });

    // 戻った時点で再送は終わっている（再送があれば、戻る前に同じ呼び出しの中で起きる）。
    assert.deepEqual(
      [reset.count(), failing.count(), silent.count()],
      [1, 1, 1],
    );
    // 少し後でも増えない。読み取り 1 回を挟み、別の接続の処理が一巡した後で確かめる。
    await createMockMailConnector({ baseUrl: failing.url })
      .listEvents()
      .catch(() => undefined);
    assert.equal(reset.count(), 1);
    assert.equal(silent.count(), 1);
    assert.equal(failing.count(), 2);
  },
);

test(
  '接続できないときは not_sent（要求は送られていない）を返し、再試行しない',
  OPTIONS,
  async (t) => {
    const provider = await startProvider(t);
    const connector = createMockMailConnector({ baseUrl: provider.url });
    await provider.close();
    assert.deepEqual(
      await connector.changeLabels(
        { operation_id: 'op-down', attempt_id: 'attempt-1' },
        LABEL,
      ),
      { kind: 'not_sent' },
    );
  },
);
