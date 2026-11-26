// 気づきの候補を起点にした自動実行の配線（ADR 0149）。期待値は設計 11 §5・§5A・§5B（判定表・一度だけ・関連解析）、
// 04（既定 OFF・初回取り込み）、08 §9（安全停止）と、ADR 0146〜0148 の理由の名前から手で書いた値。
// DB は実物（マイグレーションを当てた SQLite）を使い、worker の代わりに同期で命令を実行する。
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Deadline } from '@buddy/contracts';
import type {
  AnalysisState,
  AutoExecutionPolicy,
  CandidateRequest,
} from '@buddy/domain';
import {
  applyMigrations,
  executeCommand,
  initStoreGeneration,
  openOperationIntent,
  openWriteConnection,
  readAutoExecutionState,
  stopSafetyBreaker,
} from '@buddy/storage';
import type {
  CreateOperationCommand,
  DataKeyMaterial,
  DbCommand,
  DbCommandOutcome,
  SqliteDatabase,
} from '@buddy/storage';
import { createApiContract } from './api-contract.js';
import {
  candidateSafetyTargetKey,
  candidateTaskDue,
  candidateTaskTitle,
  runCandidateAutoExecution,
} from './candidate-auto-execution.js';
import type {
  ProviderConnection,
  ProviderMailTarget,
  ProviderReader,
} from './turn-ports.js';
import type {
  CandidateAutoExecutionInput,
  CandidateAutoExecutionPorts,
  CandidateAutoExecutionResult,
} from './candidate-auto-execution.js';

const T0 = 1_900_000_000_000;
const NOW = new Date(T0).toISOString();
const ZONE = 'Asia/Tokyo';
const KEY: DataKeyMaterial = { keyId: 'k-test', key: randomBytes(32) };
const sha256Hex = (material: string): string =>
  createHash('sha256').update(material).digest('hex');
// 接続のアカウント ID（契約の Id の形、UUID v4）。
const ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQ = '11111111-1111-4111-8111-111111111111';
const CAND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP = 'group-1';
const HASH = 'd'.repeat(64);
const CONTRACT = createApiContract();
const GENERATION = '00000000-0000-4000-8000-0000000000ff';

const POLICY_TASK_ON: AutoExecutionPolicy = {
  policy_version: '3',
  rules: {
    'task.register': true,
    'event.create_own': false,
    'mail.apply_existing_label': false,
    'mail.save_draft': false,
  },
};
const POLICY_OFF: AutoExecutionPolicy = {
  policy_version: '3',
  rules: {
    'task.register': false,
    'event.create_own': false,
    'mail.apply_existing_label': false,
    'mail.save_draft': false,
  },
};

const dateOnly: Deadline = {
  kind: 'date',
  date: '2030-10-07',
  original_text: '10月7日まで',
};

function candidateRequest(deadline: Deadline = dateOnly): CandidateRequest {
  return {
    kind: 'action_required',
    deadline,
    fields: [
      {
        field: 'summary',
        status: 'explicit',
        refs: [{ quote: '書類を提出してください。' }],
        rule_id: null,
      },
    ],
    in_quoted_text: false,
    confidence_observed: 'medium',
    addressed_to_me: true,
    from_automated_sender: false,
  } as CandidateRequest;
}

const ANALYSIS: AnalysisState = {
  group_id: GROUP,
  analysis_revision: '2',
  source_set_hash: HASH,
  published_generation: '5',
  plan_complete: true,
  sources: [{ state: 'analyzed', rule_id: null }],
  unresolved_change_count: 0,
};

function input(
  over: Partial<CandidateAutoExecutionInput> = {},
): CandidateAutoExecutionInput {
  return {
    candidate_id: CAND,
    summary: '書類の提出',
    request: candidateRequest(),
    completeness: { unread_source_ids: [], truncated_source_ids: [] },
    received_at_local: '2030-10-05T10:00',
    zone: ZONE,
    initial_import: false,
    analysis: ANALYSIS,
    current_published_generation: '5',
    changes: [],
    account_id: ACCOUNT,
    source_id: 'msg-1',
    calendar_id: null,
    context: {
      ownCalendarSelected: false,
      labelAssigned: false,
      draftExists: false,
      budgetAvailable: true,
    },
    label_provider: 'google',
    label_id: null,
    policy_current: true,
    permission_current: true,
    ...over,
  };
}

// 依頼（版 3、有効）・関連解析（版 2、ready、世代 5）・その版で作った候補。
function seed(db: SqliteDatabase): void {
  db.prepare(
    "INSERT INTO request_entities (request_entity_id, source_account_id, thread_id, origin_message_id, request_revision, state, recreation_suppressed, summary_blob_id, created_at, delete_at) VALUES (?, ?, 'thread-1', 'msg-1', 3, 'active', 0, NULL, ?, NULL)",
  ).run(REQ, ACCOUNT, T0);
  db.prepare(
    "INSERT INTO related_analyses (group_id, analysis_revision, source_set_hash, published_generation, plan_complete, status) VALUES (?, 2, ?, 5, 1, 'ready')",
  ).run(GROUP, HASH);
  db.prepare(
    "INSERT INTO notification_candidates (candidate_id, request_entity_id, request_revision, kind, notification_key, state, created_at, received_at, state_changed_at, related_group_id, related_analysis_revision, related_source_set_hash, related_published_generation) VALUES (?, ?, 3, 'mail_deadline', 'key-1', 'new', ?, ?, ?, ?, 2, ?, 5)",
  ).run(CAND, REQ, T0, T0, T0, GROUP, HASH);
}

interface Harness {
  readonly db: SqliteDatabase;
  readonly ports: CandidateAutoExecutionPorts;
  readonly submitted: CreateOperationCommand[];
  readonly started: string[];
}

// 掃除のゲートの模擬。open が偽なら閉じている。貸し出しの数と返却の数を数える。
interface RetentionFake {
  open: boolean;
  leases: number;
  released: number;
}

function withHarness(
  policy: AutoExecutionPolicy,
  run: (harness: Harness) => Promise<void>,
  provider: ProviderReader | null = null,
  retention: RetentionFake = { open: true, leases: 0, released: 0 },
  composeReply: CandidateAutoExecutionPorts['composeReply'] = null,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-auto-'));
  const db = openWriteConnection(join(dir, 'buddy.sqlite'), {
    platform: 'macos',
  });
  const submitted: CreateOperationCommand[] = [];
  const started: string[] = [];
  const ports: CandidateAutoExecutionPorts = {
    store: {
      query: async (query) => readAutoExecutionState(db, query.candidate_id),
      submit: (command: DbCommand) => {
        if (command.kind === 'operation.create') submitted.push(command);
        const result = executeCommand(db, command, {
          now: T0,
          platform: 'macos',
          storeGeneration: GENERATION,
        });
        const outcome = (
          result.outcome.outcome === 'durable'
            ? { ...result.outcome, dispatch_permit: null }
            : result.outcome
        ) as DbCommandOutcome;
        return {
          received: Promise.resolve(true),
          result: Promise.resolve(outcome),
        };
      },
    },
    dataKey: KEY,
    contract: CONTRACT,
    policy,
    current_policy_version: '3',
    task: { list_id: 'inbox', permission_revision: '0' },
    sha256Hex,
    newId: randomUUID,
    now: () => NOW,
    afterApproval: (operationId) => {
      started.push(operationId);
    },
    provider,
    retention: {
      ready: async () => {},
      gate: () => ({
        search: retention.open,
        cloud_send: retention.open,
        auto_use: retention.open,
        reasons: retention.open ? [] : ['sweep_pending'],
        use_blocked: [],
      }),
      lease: () => {
        if (!retention.open) return null;
        retention.leases += 1;
        return () => {
          retention.released += 1;
        };
      },
    },
    composeReply,
  };
  return (async () => {
    try {
      applyMigrations(db);
      initStoreGeneration(db, GENERATION);
      seed(db);
      await run({ db, ports, submitted, started });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

function judged(result: CandidateAutoExecutionResult) {
  assert.equal(result.kind, 'judged', JSON.stringify(result));
  return result.kind === 'judged' ? result.results : [];
}

// 操作ごとの「判定・理由・結果の種類」を並べる。
function summary(result: CandidateAutoExecutionResult): unknown[] {
  return judged(result).map((item) => [
    item.operation,
    item.decision,
    item.reason_codes,
    item.outcome.kind,
  ]);
}

const count = (db: SqliteDatabase, sql: string): number =>
  (db.prepare(sql).get() as { n: number }).n;

test('用事の登録だけ方針で有効なら、用事だけを方針による自動承認で作り、実行を始める', async () => {
  await withHarness(
    POLICY_TASK_ON,
    async ({ db, ports, submitted, started }) => {
      const result = await runCandidateAutoExecution(ports, input());
      assert.deepEqual(summary(result), [
        ['create_task', 'auto_eligible', [], 'created'],
        [
          'create_event',
          'notice_only',
          [
            'policy_disabled',
            'deadline_not_instant',
            'confidence_not_high',
            'own_calendar_not_selected',
          ],
          'not_eligible',
        ],
        [
          'label_mail',
          'notice_only',
          ['policy_disabled', 'label_not_assigned'],
          'not_eligible',
        ],
        [
          'draft_reply',
          'notice_only',
          ['policy_disabled', 'not_reply_required'],
          'not_eligible',
        ],
      ]);
      const created = judged(result)[0]?.outcome;
      assert.equal(created?.kind, 'created');
      const operationId =
        created?.kind === 'created' ? created.operation_id : '';
      assert.deepEqual(started, [operationId]);
      // 承認から始まり、承認は方針の経路で候補と依頼の版を持ち、一度だけの記録がある。
      assert.deepEqual(
        db
          .prepare('SELECT state, kind FROM operations WHERE operation_id = ?')
          .get(operationId),
        { state: 'approved', kind: 'task.create' },
      );
      assert.deepEqual(
        db
          .prepare(
            'SELECT route, candidate_id, request_entity_id, request_revision, analysis_revision FROM approvals WHERE operation_id = ?',
          )
          .get(operationId),
        {
          route: 'policy_auto',
          candidate_id: CAND,
          request_entity_id: REQ,
          request_revision: 3,
          analysis_revision: 2,
        },
      );
      assert.deepEqual(
        db
          .prepare(
            'SELECT request_entity_id, operation_kind, account_id, calendar_id FROM request_entity_operations WHERE operation_id = ?',
          )
          .get(operationId),
        {
          request_entity_id: REQ,
          operation_kind: 'create_task',
          account_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          calendar_id: '',
        },
      );
      // 確定 intent: 題は要約だけ、期限は日付のまま、本文は空。
      const command = submitted[0];
      assert.ok(command !== undefined);
      const opened = openOperationIntent(
        KEY,
        { operationId, contentVersion: 1 },
        {
          formatVersion: command.intent.format_version,
          keyId: command.intent.key_id,
          nonce: command.intent.nonce,
          ciphertext: command.intent.ciphertext,
          tag: command.intent.tag,
        },
        command.content_hash,
      );
      assert.equal(opened.ok, true);
      assert.deepEqual(JSON.parse(opened.ok ? opened.canonical : 'null'), {
        action: {
          body: null,
          due: '2030-10-07',
          kind: 'task.create',
          title: '書類の提出',
        },
        content_version: '1',
        effects: {
          external_recipients: [],
          reconcile_scope: 'local_transaction',
        },
        operation_id: operationId,
        permission_revision: '0',
        schema: 'buddy.operation.v1',
        target: { list_id: 'inbox' },
      });
      // 安全停止の鍵はメールの ID を平文で持たない。
      assert.equal(
        command.auto_approval?.safety_target_key.includes('msg-1'),
        false,
      );
    },
  );
});

test('既定の方針（すべて OFF）では、どの操作も作らず実行も始めない', async () => {
  await withHarness(POLICY_OFF, async ({ db, ports, started }) => {
    const result = await runCandidateAutoExecution(ports, input());
    assert.deepEqual(
      judged(result).map((item) => [
        item.operation,
        item.decision,
        item.outcome.kind,
      ]),
      [
        ['create_task', 'notice_only', 'not_eligible'],
        ['create_event', 'notice_only', 'not_eligible'],
        ['label_mail', 'notice_only', 'not_eligible'],
        ['draft_reply', 'notice_only', 'not_eligible'],
      ],
    );
    assert.deepEqual(started, []);
    assert.equal(count(db, 'SELECT count(*) AS n FROM operations'), 0);
  });
});

test('同じ候補を二度判定しても、用事は一度だけ作る（二度目は作成済みで気づきだけ）', async () => {
  await withHarness(POLICY_TASK_ON, async ({ db, ports, started }) => {
    await runCandidateAutoExecution(ports, input());
    const again = await runCandidateAutoExecution(ports, input());
    assert.deepEqual(summary(again)[0], [
      'create_task',
      'notice_only',
      ['already_created'],
      'not_eligible',
    ]);
    assert.equal(started.length, 1);
    assert.equal(count(db, 'SELECT count(*) AS n FROM operations'), 1);
  });
});

test('安全停止中は保留にし、操作を作らない', async () => {
  await withHarness(POLICY_TASK_ON, async ({ db, ports, started }) => {
    stopSafetyBreaker(db, T0 - 1000, 'rate_exceeded');
    const result = await runCandidateAutoExecution(ports, input());
    assert.deepEqual(summary(result)[0], [
      'create_task',
      'hold',
      ['safety_stopped'],
      'not_eligible',
    ]);
    assert.deepEqual(started, []);
    assert.equal(count(db, 'SELECT count(*) AS n FROM operations'), 0);
  });
});

test('初回取り込み・関連解析の未完了の候補からは作らない', async () => {
  await withHarness(POLICY_TASK_ON, async ({ ports, started }) => {
    const initial = await runCandidateAutoExecution(
      ports,
      input({ initial_import: true }),
    );
    assert.deepEqual(summary(initial)[0], [
      'create_task',
      'notice_only',
      ['initial_import'],
      'not_eligible',
    ]);
    const pending = await runCandidateAutoExecution(
      ports,
      input({ analysis: { ...ANALYSIS, plan_complete: false } }),
    );
    assert.deepEqual(summary(pending)[0], [
      'create_task',
      'hold',
      ['plan_incomplete'],
      'not_eligible',
    ]);
    assert.deepEqual(started, []);
  });
});

test('Core の判定が通っても、DB の関連解析が新しい版なら保存層が断り、作り直さない', async () => {
  await withHarness(POLICY_TASK_ON, async ({ db, ports, started }) => {
    db.prepare(
      "INSERT INTO related_analyses (group_id, analysis_revision, source_set_hash, published_generation, plan_complete, status) VALUES (?, 3, ?, 5, 1, 'ready')",
    ).run(GROUP, HASH);
    const result = await runCandidateAutoExecution(ports, input());
    const first = judged(result)[0];
    assert.equal(first?.decision, 'auto_eligible');
    assert.equal(first?.outcome.kind, 'rejected');
    assert.deepEqual(
      first?.outcome.kind === 'rejected' ? first.outcome.reasons : [],
      ['analysis_revision_changed'],
    );
    assert.deepEqual(started, []);
    assert.equal(count(db, 'SELECT count(*) AS n FROM operations'), 0);
    // 断った作成は安全停止の件数に数えない（ADR 0148）。
    assert.equal(
      count(db, 'SELECT count(*) AS n FROM safety_window_counts'),
      0,
    );
  });
});

test('候補が無い・閉じた・依頼の版が変わったときは、どの操作も判定しない', async () => {
  await withHarness(POLICY_TASK_ON, async ({ db, ports, started }) => {
    assert.deepEqual(
      await runCandidateAutoExecution(
        ports,
        input({ candidate_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
      ),
      { kind: 'skipped', reasons: ['candidate_not_found'] },
    );
    db.prepare(
      'UPDATE request_entities SET request_revision = 4 WHERE request_entity_id = ?',
    ).run(REQ);
    assert.deepEqual(await runCandidateAutoExecution(ports, input()), {
      kind: 'skipped',
      reasons: ['request_revision_changed'],
    });
    db.prepare(
      "UPDATE notification_candidates SET state = 'dismissed', closed_at = ?, key_delete_at = ? WHERE candidate_id = ?",
    ).run(T0, T0 + 604_800_000 + 7_776_000_000, CAND);
    assert.deepEqual(await runCandidateAutoExecution(ports, input()), {
      kind: 'skipped',
      reasons: ['candidate_closed', 'request_revision_changed'],
    });
    assert.deepEqual(started, []);
  });
});

const POLICY_LABEL_ON: AutoExecutionPolicy = {
  policy_version: '3',
  rules: {
    'task.register': false,
    'event.create_own': false,
    'mail.apply_existing_label': true,
    'mail.save_draft': false,
  },
};

const LABEL_CONTEXT = {
  ownCalendarSelected: false,
  labelAssigned: true,
  draftExists: false,
  budgetAvailable: true,
};

// 模擬の provider。接続・許可の版・対象のメールを差し替えられる。
function fakeProvider(
  over: {
    connection?: ProviderConnection | null;
    target?: ProviderMailTarget | null;
    findDrafts?: boolean;
  } = {},
): ProviderReader {
  const connection: ProviderConnection | null =
    over.connection === undefined
      ? {
          provider: 'mock',
          account_id: ACCOUNT,
          status: 'active',
          access: 'read_write',
        }
      : over.connection;
  const target: ProviderMailTarget | null =
    over.target === undefined
      ? {
          remote_id: 'msg-1',
          source_revision: 'rev-1',
          mailbox: 'INBOX',
          labels: ['INBOX'],
          sender: 'sender@example.com',
          subject: '書類の件',
        }
      : over.target;
  const reader: ProviderReader = {
    connection: async () => connection,
    readPermission: async (accountId) => ({
      account_id: accountId,
      permission_revision: '7',
      scopes: [],
    }),
    readTarget: async () => target,
    listEvents: async () => [],
  };
  return over.findDrafts === false
    ? reader
    : { ...reader, findDrafts: async () => [] };
}

test('ラベルの付与が方針で有効なら、元のメールにラベルを 1 つ足す操作を方針による自動承認で作る', async () => {
  await withHarness(
    POLICY_LABEL_ON,
    async ({ db, submitted, started, ports }) => {
      const result = await runCandidateAutoExecution(
        ports,
        input({
          context: LABEL_CONTEXT,
          label_provider: 'mock',
          label_id: 'Label_7',
        }),
      );
      assert.deepEqual(summary(result)[2], [
        'label_mail',
        'auto_eligible',
        [],
        'created',
      ]);
      assert.equal(submitted.length, 1);
      const command = submitted[0]!;
      assert.equal(command.operation_kind, 'mail.labels.change');
      assert.equal(command.effect_route, 'remote_mutation');
      assert.equal(command.permission_revision, '7');
      assert.equal(
        command.auto_approval?.safety_target_key,
        candidateSafetyTargetKey(
          'label_mail',
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          'msg-1',
          sha256Hex,
        ),
      );
      const opened = openOperationIntent(
        KEY,
        { operationId: command.operation_id, contentVersion: 1 },
        {
          formatVersion: command.intent.format_version,
          keyId: command.intent.key_id,
          nonce: command.intent.nonce,
          ciphertext: command.intent.ciphertext,
          tag: command.intent.tag,
        },
        command.content_hash,
      );
      assert.equal(opened.ok, true);
      // 確定 intent: 足すラベルは 1 つ、外すラベルは無し、対象は元のメールの今の版。
      assert.deepEqual(JSON.parse(opened.ok ? opened.canonical : 'null'), {
        account_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        action: {
          add: ['Label_7'],
          kind: 'mail.labels.change',
          remove: [],
        },
        content_version: '1',
        effects: { external_recipients: [], reconcile_scope: 'exact_target' },
        operation_id: command.operation_id,
        permission_revision: '7',
        provider: 'mock',
        schema: 'buddy.operation.v1',
        target: { remote_id: 'msg-1', source_revision: 'rev-1' },
      });
      assert.deepEqual(started, [command.operation_id]);
      assert.equal(
        count(
          db,
          "SELECT count(*) AS n FROM operations WHERE kind = 'mail.labels.change'",
        ),
        1,
      );
      // 依頼から作った記録は「ラベルの付与」として残り、同じ依頼から二度作らない（11 §5B）。
      assert.deepEqual(
        db
          .prepare(
            'SELECT request_entity_id, operation_kind, account_id, calendar_id FROM request_entity_operations WHERE operation_id = ?',
          )
          .get(command.operation_id),
        {
          request_entity_id: REQ,
          operation_kind: 'label_mail',
          account_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          calendar_id: '',
        },
      );
      const again = await runCandidateAutoExecution(
        ports,
        input({
          context: LABEL_CONTEXT,
          label_provider: 'mock',
          label_id: 'Label_7',
        }),
      );
      assert.equal(judged(again)[2]!.decision, 'notice_only');
      assert.deepEqual(judged(again)[2]!.reason_codes, ['already_created']);
    },
    fakeProvider(),
  );
});

test('ラベルが既に付いている・接続が使えない・メールが読めないときはラベルの操作を作らない', async () => {
  const cases: [string, ProviderReader | null, string][] = [
    [
      'already',
      fakeProvider({
        target: {
          remote_id: 'msg-1',
          source_revision: 'rev-1',
          mailbox: 'INBOX',
          labels: ['INBOX', 'Label_7'],
        },
      }),
      'no_change',
    ],
    ['no provider', null, 'connection_unavailable'],
    [
      'read only',
      fakeProvider({
        connection: {
          provider: 'mock',
          account_id: ACCOUNT,
          status: 'active',
          access: 'read',
        },
      }),
      'connection_unavailable',
    ],
    [
      'other account',
      fakeProvider({
        connection: {
          provider: 'mock',
          account_id: 'acct-2',
          status: 'active',
          access: 'read_write',
        },
      }),
      'connection_unavailable',
    ],
    [
      'provider changed',
      fakeProvider({
        connection: {
          provider: 'gmail',
          account_id: ACCOUNT,
          status: 'active',
          access: 'read_write',
        },
      }),
      'label_provider_changed',
    ],
    ['target missing', fakeProvider({ target: null }), 'target_not_found'],
  ];
  for (const [name, provider, reason] of cases) {
    await withHarness(
      POLICY_LABEL_ON,
      async ({ db, started, ports }) => {
        const result = await runCandidateAutoExecution(
          ports,
          input({
            context: LABEL_CONTEXT,
            label_provider: 'mock',
            label_id: 'Label_7',
          }),
        );
        const label = judged(result)[2]!;
        assert.deepEqual(
          label.outcome,
          { kind: 'not_created', reasons: [reason] },
          name,
        );
        assert.deepEqual(started, [], name);
        assert.equal(count(db, 'SELECT count(*) AS n FROM operations'), 0);
      },
      provider,
    );
  }
});

test('掃除が済むまではラベルのために provider を読まず、作らない。読み直しの間だけ貸し出しを持つ', async () => {
  let reads = 0;
  const base = fakeProvider();
  const counting: ProviderReader = {
    ...base,
    connection: async () => {
      reads += 1;
      return base.connection();
    },
  };
  const closed: RetentionFake = { open: false, leases: 0, released: 0 };
  await withHarness(
    POLICY_LABEL_ON,
    async ({ db, ports, started }) => {
      const result = await runCandidateAutoExecution(
        ports,
        input({
          context: LABEL_CONTEXT,
          label_provider: 'mock',
          label_id: 'Label_7',
        }),
      );
      assert.deepEqual(judged(result)[2]!.outcome, {
        kind: 'not_created',
        reasons: ['retention_blocked'],
      });
      assert.equal(reads, 0);
      assert.deepEqual(started, []);
      assert.equal(count(db, 'SELECT count(*) AS n FROM operations'), 0);
    },
    counting,
    closed,
  );
  const open: RetentionFake = { open: true, leases: 0, released: 0 };
  await withHarness(
    POLICY_LABEL_ON,
    async ({ ports }) => {
      const result = await runCandidateAutoExecution(
        ports,
        input({
          context: LABEL_CONTEXT,
          label_provider: 'mock',
          label_id: 'Label_7',
        }),
      );
      assert.equal(judged(result)[2]!.outcome.kind, 'created');
      assert.equal(reads, 1);
      assert.deepEqual([open.leases, open.released], [1, 1]);
    },
    counting,
    open,
  );
});

const POLICY_DRAFT_ON: AutoExecutionPolicy = {
  policy_version: '3',
  rules: {
    'task.register': false,
    'event.create_own': false,
    'mail.apply_existing_label': false,
    'mail.save_draft': true,
  },
};

// 返信を求める依頼（確度は中、本人宛て、自動送信の差出人ではない）。
function replyRequest(): CandidateRequest {
  return { ...candidateRequest(), kind: 'reply_required' } as CandidateRequest;
}

test('返信の下書きの保存が方針で有効なら、宛先と件名を返信元から決め、本文を作る口の文で下書きの操作を作る', async () => {
  const composed: unknown[] = [];
  await withHarness(
    POLICY_DRAFT_ON,
    async ({ db, submitted, started, ports }) => {
      const result = await runCandidateAutoExecution(
        ports,
        input({ request: replyRequest() }),
      );
      assert.deepEqual(summary(result)[3], [
        'draft_reply',
        'auto_eligible',
        [],
        'created',
      ]);
      assert.deepEqual(composed, [
        {
          account_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          source_id: 'msg-1',
          summary: '書類の提出',
        },
      ]);
      assert.equal(submitted.length, 1);
      const command = submitted[0]!;
      assert.equal(command.operation_kind, 'mail.draft.create');
      assert.equal(command.effect_route, 'remote_mutation');
      assert.equal(command.permission_revision, '7');
      const opened = openOperationIntent(
        KEY,
        { operationId: command.operation_id, contentVersion: 1 },
        {
          formatVersion: command.intent.format_version,
          keyId: command.intent.key_id,
          nonce: command.intent.nonce,
          ciphertext: command.intent.ciphertext,
          tag: command.intent.tag,
        },
        command.content_hash,
      );
      assert.equal(opened.ok, true);
      // 確定 intent: 宛先は差出人だけ、CC は空、件名は「Re: 」付き、本文は前後の空白を除いた文。
      assert.deepEqual(JSON.parse(opened.ok ? opened.canonical : 'null'), {
        account_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        action: {
          body: '承知しました。\n確認して返信します。',
          cc: [],
          kind: 'mail.draft.create',
          subject: 'Re: 書類の件',
          to: ['sender@example.com'],
        },
        content_version: '1',
        effects: {
          external_recipients: [],
          reconcile_scope: 'operation_marker',
        },
        operation_id: command.operation_id,
        permission_revision: '7',
        provider: 'mock',
        schema: 'buddy.operation.v1',
        target: { remote_id: 'msg-1', source_revision: 'rev-1' },
      });
      assert.deepEqual(started, [command.operation_id]);
      assert.deepEqual(
        db
          .prepare(
            'SELECT operation_kind FROM request_entity_operations WHERE operation_id = ?',
          )
          .get(command.operation_id),
        { operation_kind: 'draft_reply' },
      );
    },
    fakeProvider(),
    undefined,
    async (request) => {
      composed.push(request);
      return '  承知しました。\n確認して返信します。  ';
    },
  );
});

test('本文が作れない・目印で探せない・返信元が読めない・掃除が済んでいないときは下書きの操作を作らない', async () => {
  const text = async () => '確認します。';
  let calls = 0;
  const counted = async () => {
    calls += 1;
    return '確認します。';
  };
  const cases: [
    string,
    ProviderReader | null,
    CandidateAutoExecutionPorts['composeReply'],
    boolean,
    string,
  ][] = [
    ['no composer', fakeProvider(), null, true, 'composer_unavailable'],
    ['empty body', fakeProvider(), async () => '   ', true, 'body_unavailable'],
    ['null body', fakeProvider(), async () => null, true, 'body_unavailable'],
    [
      'composer throws',
      fakeProvider(),
      async () => {
        throw new Error('timeout');
      },
      true,
      'body_unavailable',
    ],
    [
      'no marker search',
      fakeProvider({ findDrafts: false }),
      text,
      true,
      'draft_unreconcilable',
    ],
    ['no provider', null, text, true, 'connection_unavailable'],
    [
      'no sender',
      fakeProvider({
        target: {
          remote_id: 'msg-1',
          source_revision: 'rev-1',
          mailbox: 'INBOX',
          labels: [],
          sender: null,
          subject: '書類の件',
        },
      }),
      text,
      true,
      'reply_fields_unreadable',
    ],
    ['sweep pending', fakeProvider(), counted, false, 'retention_blocked'],
  ];
  for (const [name, provider, compose, open, reason] of cases) {
    await withHarness(
      POLICY_DRAFT_ON,
      async ({ db, started, ports }) => {
        const result = await runCandidateAutoExecution(
          ports,
          input({ request: replyRequest() }),
        );
        assert.deepEqual(
          judged(result)[3]!.outcome,
          { kind: 'not_created', reasons: [reason] },
          name,
        );
        assert.deepEqual(started, [], name);
        assert.equal(count(db, 'SELECT count(*) AS n FROM operations'), 0);
      },
      provider,
      { open, leases: 0, released: 0 },
      compose,
    );
  }
  // 掃除が済んでいなければ、本文を作る口も呼ばない（メールを読ませない）。
  assert.equal(calls, 0);
});

test('付けるラベルの ID が無ければ、割り当て済みとはせず気づきだけにする', async () => {
  await withHarness(
    POLICY_LABEL_ON,
    async ({ db, ports }) => {
      const result = await runCandidateAutoExecution(
        ports,
        input({ context: LABEL_CONTEXT, label_provider: 'mock' }),
      );
      assert.deepEqual(summary(result)[2], [
        'label_mail',
        'notice_only',
        ['label_not_assigned'],
        'not_eligible',
      ]);
      assert.equal(count(db, 'SELECT count(*) AS n FROM operations'), 0);
    },
    fakeProvider(),
  );
});

test('予定はカレンダーが無ければ、選択済みでも気づきだけにする', async () => {
  await withHarness(
    {
      policy_version: '3',
      rules: {
        'task.register': false,
        'event.create_own': true,
        'mail.apply_existing_label': false,
        'mail.save_draft': false,
      },
    },
    async ({ ports }) => {
      const request: CandidateRequest = {
        ...candidateRequest({
          kind: 'instant',
          local_datetime: '2030-10-07T17:00',
          zone: ZONE,
          original_text: '10月7日 17時',
        }),
        confidence_observed: 'high',
      };
      const context = {
        ownCalendarSelected: true,
        labelAssigned: false,
        draftExists: false,
        budgetAvailable: true,
      };
      const without = await runCandidateAutoExecution(
        ports,
        input({ request, context, calendar_id: null }),
      );
      assert.deepEqual(summary(without)[1], [
        'create_event',
        'notice_only',
        ['own_calendar_not_selected'],
        'not_eligible',
      ]);
      const withCalendar = await runCandidateAutoExecution(
        ports,
        input({ request, context, calendar_id: 'cal-own' }),
      );
      assert.deepEqual(summary(withCalendar)[1], [
        'create_event',
        'auto_eligible',
        [],
        'not_wired',
      ]);
    },
  );
});

test('時刻のある期限は本人のタイムゾーンの地域日時で登録し、別のタイムゾーンなら作らない', async () => {
  await withHarness(POLICY_TASK_ON, async ({ db, ports, started }) => {
    const other = await runCandidateAutoExecution(
      ports,
      input({
        request: candidateRequest({
          kind: 'instant',
          local_datetime: '2030-10-07T17:00',
          zone: 'America/New_York',
          original_text: 'Oct 7 5pm',
        }),
      }),
    );
    assert.deepEqual(judged(other)[0]?.outcome, {
      kind: 'not_created',
      reasons: ['deadline_zone_mismatch'],
    });
    assert.equal(count(db, 'SELECT count(*) AS n FROM operations'), 0);
    assert.deepEqual(started, []);
  });
  assert.deepEqual(
    candidateTaskDue(
      {
        kind: 'instant',
        local_datetime: '2030-10-07T17:00',
        zone: ZONE,
        original_text: '10月7日 17時',
      },
      ZONE,
    ),
    { ok: true, due: '2030-10-07T17:00' },
  );
  assert.deepEqual(candidateTaskDue({ kind: 'none' }, ZONE), {
    ok: true,
    due: null,
  });
  assert.deepEqual(
    candidateTaskDue(
      { kind: 'unresolved', reason: 'relative', original_text: '来週中' },
      ZONE,
    ),
    { ok: false, reason: 'deadline_unresolved' },
  );
});

test('用事の題は要約から作り、期限・差出人を付けない。空の要約は固定の題にする', () => {
  assert.equal(candidateTaskTitle('  書類の\n提出  '), '書類の 提出');
  assert.equal(candidateTaskTitle(''), '対応の依頼');
});

test('安全停止の鍵は操作・アカウント・元のメールで決まり、ハッシュの形にする', () => {
  const key = candidateSafetyTargetKey(
    'create_task',
    'acct-1',
    'msg-1',
    sha256Hex,
  );
  assert.match(key, /^auto:[0-9a-f]{64}$/u);
  assert.equal(
    candidateSafetyTargetKey('create_task', 'acct-1', 'msg-1', sha256Hex),
    key,
  );
  assert.notEqual(
    candidateSafetyTargetKey('label_mail', 'acct-1', 'msg-1', sha256Hex),
    key,
  );
  assert.notEqual(
    candidateSafetyTargetKey('create_task', 'acct-1', 'msg-2', sha256Hex),
    key,
  );
});
