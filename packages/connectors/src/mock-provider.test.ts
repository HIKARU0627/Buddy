// 模擬 provider とアダプターの試験。期待値は手で書いた値で、実装の処理から作らない。
import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { createMockMailConnector } from './index.js';
import { createMockProvider } from './testing.js';
import { startProvider, TEST_TIMEOUT_MS } from './test-support.js';

const OPTIONS = { timeout: TEST_TIMEOUT_MS };
const CLOCK = '2026-10-05T09:00:00+09:00';

// H01（packages/contracts/fixtures/h01.json）と同じ値を手で写した。
const H01 = {
  operation_id: '00000000-0000-4000-8000-000000000001',
  account_id: '00000000-0000-4000-8000-000000000002',
};

test(
  '合成データ: mail-001（r1・INBOX）と、13:30〜14:00 が重なる event-001・002 を読める',
  OPTIONS,
  async (t) => {
    const provider = await startProvider(t);
    const connector = createMockMailConnector({ baseUrl: provider.url });

    assert.deepEqual(await connector.readTarget('mail-001'), {
      remote_id: 'mail-001',
      source_revision: 'r1',
      mailbox: 'INBOX',
      labels: [],
      // 承認画面で対象のメールを見分ける表示用（合成の値）。
      subject: '（合成）来週の打ち合わせの日程',
      sender: 'synthetic-sender@example.com',
      received_at: '2026-10-04T18:30:00+09:00',
    });
    assert.equal(await connector.readTarget('mail-999'), null);
    assert.deepEqual(await connector.listEvents(), [
      {
        event_id: 'event-001',
        title: '（合成）定例の打ち合わせ',
        start: '2026-10-05T13:00:00+09:00',
        end: '2026-10-05T14:00:00+09:00',
      },
      {
        event_id: 'event-002',
        title: '（合成）歯科の予約',
        start: '2026-10-05T13:30:00+09:00',
        end: '2026-10-05T14:30:00+09:00',
      },
    ]);
    assert.deepEqual(await connector.readPermission(H01.account_id), {
      account_id: H01.account_id,
      account_label: 'synthetic-user@example.com',
      permission_revision: '1',
      scopes: [
        'mail.read',
        'calendar.read',
        'mail.labels.change',
        'mail.drafts.create',
        'mail.drafts.send',
      ],
    });
    assert.equal(await connector.readPermission('other-account'), null);
    // 読み取りは要求にも状態の変更にも数えない。
    assert.equal(provider.truth.requestCount(), 0);
    assert.equal(provider.truth.stateChangeCount(), 0);
  },
);

test(
  'H01 のラベルの追加を適用し、受信記録に識別・順・適用した変更・応答を残す',
  OPTIONS,
  async (t) => {
    const provider = await startProvider(t, { now: () => CLOCK });
    const connector = createMockMailConnector({ baseUrl: provider.url });

    const outcome = await connector.changeLabels(
      { operation_id: H01.operation_id, attempt_id: 'attempt-1' },
      { remote_id: 'mail-001', add: ['follow-up'], remove: [] },
    );
    assert.deepEqual(outcome, {
      kind: 'applied',
      status: 200,
      value: {
        remote_id: 'mail-001',
        source_revision: 'r1',
        mailbox: '',
        labels: ['follow-up'],
        // 書込みの結果は表示用の値を持たない。
        subject: null,
        sender: null,
        received_at: null,
      },
    });
    assert.deepEqual(provider.truth.receipts(), [
      {
        receive_order: 1,
        received_at: CLOCK,
        route: 'mail.labels.change',
        operation_id: H01.operation_id,
        attempt_id: 'attempt-1',
        step_id: null,
        applied_change: {
          kind: 'mail.labels.change',
          remote_id: 'mail-001',
          add: ['follow-up'],
          remove: [],
          labels_after: ['follow-up'],
        },
        responded: true,
        response_status: 200,
      },
    ]);
    assert.equal(provider.truth.requestCount(), 1);
    assert.equal(provider.truth.stateChangeCount(), 1);
    assert.deepEqual((await connector.readTarget('mail-001'))?.labels, [
      'follow-up',
    ]);
  },
);

test(
  '中枢（アダプター）を作り直しても、provider を作り直しても、受信記録と状態が残る',
  OPTIONS,
  async (t) => {
    const first = await startProvider(t, { now: () => CLOCK });
    const before = createMockMailConnector({ baseUrl: first.url });
    await before.changeLabels(
      { operation_id: 'op-1', attempt_id: 'attempt-1' },
      { remote_id: 'mail-001', add: ['follow-up'], remove: [] },
    );

    // 中枢の再起動: アダプターを作り直す。provider の記録は影響を受けない。
    const afterCoreRestart = createMockMailConnector({ baseUrl: first.url });
    assert.equal(first.truth.requestCount(), 1);
    assert.deepEqual((await afterCoreRestart.readTarget('mail-001'))?.labels, [
      'follow-up',
    ]);

    // provider のプロセスの作り直し: 同じディレクトリから状態と記録を読み戻す。
    await first.close();
    const second = await startProvider(t, { dir: first.dir, now: () => CLOCK });
    assert.equal(second.truth.requestCount(), 1);
    assert.equal(second.truth.stateChangeCount(), 1);
    const [receipt] = second.truth.receipts();
    assert.equal(receipt?.operation_id, 'op-1');
    assert.equal(receipt?.attempt_id, 'attempt-1');
    assert.equal(receipt?.responded, true);

    // 続きの受信順は引き継ぐ。
    const connector = createMockMailConnector({ baseUrl: second.url });
    await connector.changeLabels(
      { operation_id: 'op-2', attempt_id: 'attempt-1' },
      { remote_id: 'mail-001', add: ['later'], remove: [] },
    );
    assert.deepEqual(
      second.truth.receipts().map((r) => [r.receive_order, r.operation_id]),
      [
        [1, 'op-1'],
        [2, 'op-2'],
      ],
    );
    assert.deepEqual((await connector.readTarget('mail-001'))?.labels, [
      'follow-up',
      'later',
    ]);
  },
);

test(
  '同じ要求を 2 回送ると、要求 2 件・状態の変更 2 件として記録し、重複を消さない',
  OPTIONS,
  async (t) => {
    const provider = await startProvider(t);
    const connector = createMockMailConnector({ baseUrl: provider.url });
    const identity = { operation_id: 'op-dup', attempt_id: 'attempt-1' };
    const change = { remote_id: 'mail-001', add: ['follow-up'], remove: [] };

    assert.equal(
      (await connector.changeLabels(identity, change)).kind,
      'applied',
    );
    assert.equal(
      (await connector.changeLabels(identity, change)).kind,
      'applied',
    );

    assert.equal(provider.truth.requestCount(), 2);
    assert.equal(provider.truth.stateChangeCount(), 2);
    assert.deepEqual(
      provider.truth
        .receipts()
        .map((r) => [r.receive_order, r.operation_id, r.attempt_id]),
      [
        [1, 'op-dup', 'attempt-1'],
        [2, 'op-dup', 'attempt-1'],
      ],
    );
    // ラベルそのものは 1 つだが、サービスは二重の送出を隠さず 2 回の変更として数える。
    assert.deepEqual(provider.truth.snapshot().mails['mail-001']?.labels, [
      'follow-up',
    ]);
  },
);

test(
  '拒否・不正な要求は、要求として記録するが状態を変えない',
  OPTIONS,
  async (t) => {
    const provider = await startProvider(t);
    const connector = createMockMailConnector({ baseUrl: provider.url });
    const identity = { operation_id: 'op-reject', attempt_id: 'attempt-1' };

    assert.deepEqual(
      await connector.changeLabels(identity, {
        remote_id: 'mail-999',
        add: ['follow-up'],
        remove: [],
      }),
      { kind: 'rejected', status: 404, code: 'not_found' },
    );

    provider.truth.setPermission({
      permission_revision: '2',
      scopes: ['mail.read'],
    });
    assert.deepEqual(
      await connector.changeLabels(identity, {
        remote_id: 'mail-001',
        add: ['follow-up'],
        remove: [],
      }),
      { kind: 'rejected', status: 403, code: 'permission_denied' },
    );

    // 識別のない不正な本文（直接送る）。
    const response = await fetch(
      `${provider.url}/v1/mail/messages/mail-001/labels`,
      { method: 'POST', body: '{broken' },
    );
    assert.equal(response.status, 400);

    assert.equal(provider.truth.requestCount(), 3);
    assert.equal(provider.truth.stateChangeCount(), 0);
    assert.deepEqual(
      provider.truth
        .receipts()
        .map((r) => [r.operation_id, r.applied_change, r.response_status]),
      [
        ['op-reject', null, 404],
        ['op-reject', null, 403],
        [null, null, 400],
      ],
    );
    assert.deepEqual(provider.truth.snapshot().mails['mail-001']?.labels, []);
  },
);

test(
  '下書きの作成と送信は step_id つきで記録し、operation_id で正確に lookup できる',
  OPTIONS,
  async (t) => {
    const provider = await startProvider(t);
    const connector = createMockMailConnector({ baseUrl: provider.url });

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
    assert.deepEqual(created, {
      kind: 'applied',
      status: 201,
      value: { draft_id: 'draft-001' },
    });
    assert.deepEqual(
      await connector.lookupDrafts({
        operation_id: 'op-x10',
        step_id: 'create_draft',
      }),
      [
        {
          draft_id: 'draft-001',
          operation_id: 'op-x10',
          attempt_id: 'attempt-1',
          step_id: 'create_draft',
          status: 'draft',
        },
      ],
    );
    assert.deepEqual(
      await connector.lookupDrafts({ operation_id: 'op-other' }),
      [],
    );

    const sent = await connector.sendDraft(
      { operation_id: 'op-x10', attempt_id: 'attempt-1', step_id: 'send' },
      'draft-001',
    );
    assert.deepEqual(sent, {
      kind: 'applied',
      status: 200,
      value: { draft_id: 'draft-001' },
    });
    assert.deepEqual(
      provider.truth
        .receipts()
        .map((r) => [r.receive_order, r.route, r.step_id]),
      [
        [1, 'mail.draft.create', 'create_draft'],
        [2, 'mail.draft.send', 'send'],
      ],
    );
    assert.equal(provider.truth.requestCount(), 2);
    assert.equal(provider.truth.stateChangeCount(), 2);
    const draft = provider.truth.snapshot().drafts['draft-001'];
    assert.equal(draft?.status, 'sent');
    assert.equal(draft?.send_count, 1);

    // 存在しない下書きの送信は拒否される。
    assert.deepEqual(
      await connector.sendDraft(
        { operation_id: 'op-x10', attempt_id: 'a2' },
        'draft-404',
      ),
      { kind: 'rejected', status: 404, code: 'not_found' },
    );
  },
);

test(
  '試験の状況づくり（対象の版・許可）は変更の回数に数えず、アダプターから読める',
  OPTIONS,
  async (t) => {
    const provider = await startProvider(t);
    const connector = createMockMailConnector({ baseUrl: provider.url });
    provider.truth.setSourceRevision('mail-001', 'r2');
    provider.truth.setPermission({
      permission_revision: '2',
      scopes: ['mail.read'],
    });

    assert.equal(
      (await connector.readTarget('mail-001'))?.source_revision,
      'r2',
    );
    assert.deepEqual(await connector.readPermission(H01.account_id), {
      account_id: H01.account_id,
      account_label: 'synthetic-user@example.com',
      permission_revision: '2',
      scopes: ['mail.read'],
    });
    assert.equal(provider.truth.stateChangeCount(), 0);
    assert.equal(provider.truth.requestCount(), 0);
  },
);

test(
  'アダプターは能力を持ち、真の結果を見る窓口を持たない',
  OPTIONS,
  async (t) => {
    const provider = await startProvider(t);
    const connector = createMockMailConnector({ baseUrl: provider.url });
    assert.deepEqual(
      connector.capability.writes.map((w) => [
        w.action_kind,
        w.effect_kind,
        w.automatic_http_retries,
      ]),
      [
        ['mail.labels.change', 'RemoteMutation', 0],
        ['mail.draft.create', 'RemoteMutation', 0],
        ['mail.draft.send', 'RemoteMutation', 0],
      ],
    );
    assert.ok(
      connector.capability.reads.every((r) => r.effect_kind === 'Read'),
    );
    assert.equal('truth' in connector, false);
    const exported = Object.keys(await import('./index.js'));
    assert.equal(exported.includes('createMockProvider'), false);
  },
);

test(
  '同じプロセスで同じ保存ディレクトリを二重に起動できず、閉じた後は起動し直せる',
  OPTIONS,
  async (t) => {
    const first = await startProvider(t);
    await assert.rejects(
      createMockProvider({ dir: first.dir }),
      /別の provider が使っています/,
    );
    // 拒否された起動は、先の provider の排他を壊さない。
    await assert.rejects(createMockProvider({ dir: first.dir }));
    assert.equal(
      (
        await createMockMailConnector({ baseUrl: first.url }).readTarget(
          'mail-001',
        )
      )?.remote_id,
      'mail-001',
    );
    await first.close();
    const second = await startProvider(t, { dir: first.dir });
    assert.equal(second.truth.requestCount(), 0);
  },
);

test(
  '閉じるときは、本文を受信している最中の要求の処理を終えてから排他を手放し、古い状態を保存し直さない',
  OPTIONS,
  async (t) => {
    const first = await startProvider(t, { now: () => CLOCK });
    // 本文の途中までしか送らない要求（content-length より少ない）を開いたままにする。
    const partial = request(
      {
        host: '127.0.0.1',
        port: new URL(first.url).port,
        method: 'POST',
        path: '/v1/mail/messages/mail-001/labels',
        headers: {
          'content-type': 'application/json',
          'content-length': '1000',
        },
      },
      () => undefined,
    );
    partial.on('error', () => undefined);
    partial.write('{"operation_id":"op-old"');
    // sleep ではなく、処理中の件数が 1 になるまで、イベントループを譲りながら待つ。
    // 時間切れで試験が失敗したときにループが残らないよう、ループ自体にも期限を持たせる。
    const deadline = Date.now() + 5_000;
    while (first.truth.inflightCount() < 1) {
      if (Date.now() > deadline) throw new Error('timeout: inflight');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await first.close();
    assert.equal(first.truth.inflightCount(), 0);
    const second = await startProvider(t, { dir: first.dir, now: () => CLOCK });
    const connector = createMockMailConnector({ baseUrl: second.url });
    await connector.changeLabels(
      { operation_id: 'op-new', attempt_id: 'attempt-1' },
      { remote_id: 'mail-001', add: ['follow-up'], remove: [] },
    );
    await second.close();

    // 閉じた後も、古い要求の処理は受信記録を足さず、保存した状態を戻さない。
    const third = await startProvider(t, { dir: first.dir, now: () => CLOCK });
    assert.deepEqual(
      third.truth.receipts().map((r) => [r.receive_order, r.operation_id]),
      [[1, 'op-new']],
    );
    assert.equal(third.truth.stateChangeCount(), 1);
    assert.deepEqual(third.truth.snapshot().mails['mail-001']?.labels, [
      'follow-up',
    ]);
  },
);

// B04-07: 返信の下書きの保存（目印・返信元・CC）と、目印での照合の読み取り。期待値は手で書いた値。
const DRAFT_OPERATION = '00000000-0000-4000-8000-0000000000a7';
const MARKER = 'buddy-op:00000000-0000-4000-8000-0000000000a7:1';

test(
  '返信の下書きを目印・返信元・CC つきで保存し、目印で 1 件だけ探せる（読み取りは要求に数えない）',
  OPTIONS,
  async (t) => {
    const provider = await startProvider(t, { now: () => CLOCK });
    const connector = createMockMailConnector({ baseUrl: provider.url });

    const created = await connector.createDraft(
      {
        operation_id: DRAFT_OPERATION,
        attempt_id: 'attempt-1',
        step_id: '1-create_draft',
      },
      {
        to: ['synthetic-sender@example.com'],
        cc: [],
        subject: 'Re: （合成）来週の打ち合わせの日程',
        body: '（合成）承知しました。',
        in_reply_to: 'mail-001',
        marker: MARKER,
      },
    );
    assert.deepEqual(created, {
      kind: 'applied',
      status: 201,
      value: { draft_id: 'draft-001' },
    });
    assert.deepEqual(provider.truth.snapshot().drafts['draft-001'], {
      draft_id: 'draft-001',
      operation_id: DRAFT_OPERATION,
      attempt_id: 'attempt-1',
      step_id: '1-create_draft',
      marker: MARKER,
      in_reply_to: 'mail-001',
      to: ['synthetic-sender@example.com'],
      cc: [],
      subject: 'Re: （合成）来週の打ち合わせの日程',
      body: '（合成）承知しました。',
      status: 'draft',
      send_count: 0,
    });
    assert.deepEqual(await connector.findDraftsByMarker(MARKER), [
      {
        draft_id: 'draft-001',
        marker: MARKER,
        in_reply_to: 'mail-001',
        status: 'draft',
      },
    ]);
    // 内容版が違う目印では見つからない（内容版ごとに別の作成物）。
    assert.deepEqual(
      await connector.findDraftsByMarker(
        'buddy-op:00000000-0000-4000-8000-0000000000a7:2',
      ),
      [],
    );
    assert.equal(provider.truth.requestCount(), 1);
    assert.equal(provider.truth.stateChangeCount(), 1);
    assert.deepEqual(
      provider.truth
        .receipts()
        .map((r) => [r.route, r.step_id, r.applied_change, r.responded]),
      [
        [
          'mail.draft.create',
          '1-create_draft',
          { kind: 'mail.draft.create', draft_id: 'draft-001' },
          true,
        ],
      ],
    );
  },
);

test(
  '返信元がない下書きの保存は適用前に拒否し、条件のない下書きの一覧は返さない',
  OPTIONS,
  async (t) => {
    const provider = await startProvider(t);
    const connector = createMockMailConnector({ baseUrl: provider.url });
    assert.deepEqual(
      await connector.createDraft(
        { operation_id: 'op-a', attempt_id: 'attempt-1' },
        {
          to: ['synthetic-sender@example.com'],
          subject: 'Re: x',
          body: 'y',
          in_reply_to: 'mail-404',
          marker: MARKER,
        },
      ),
      { kind: 'rejected', status: 404, code: 'not_found' },
    );
    // 受信記録には残る（要求 1・変更 0）。
    assert.equal(provider.truth.requestCount(), 1);
    assert.equal(provider.truth.stateChangeCount(), 0);
    const listed = await new Promise<number>((resolve, reject) => {
      const req = request(`${provider.url}/v1/mail/drafts`, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(listed, 400);
  },
);
