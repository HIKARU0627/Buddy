// 気づきの OS 通知の判定と知らせ・入・切の経路（ADR 0196）。保存はマイグレーション済みの SQLite（worker を介さない）で、
// 書けた後の知らせは DbWorkerClient.onCandidateWrite と同じ条件（作成・遷移が ok のとき）で受け手へ渡す。
// 期待値（知らせの数・中身・配信の記録・理由）は ADR 0073・0117・0196 の決めから手で書いた値で、実装の関数から作っていない。

import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DbWorkerClient,
  applyMigrations,
  executeCandidateOp,
  openWriteConnection,
} from '@buddy/storage';
import type {
  CandidateCreateInput,
  CandidateOp,
  CandidateOpResult,
  CandidateOpValues,
  CandidateWriteOp,
  SqliteDatabase,
} from '@buddy/storage';
import {
  createCandidateAlertRoutes,
  createCandidateAlerts,
} from './candidate-alerts.js';
import type { CandidateAlerts } from './candidate-alerts.js';
import { persistCandidateDrafts } from './candidate-intake.js';
import type { CandidateDraft } from './candidate-intake.js';
import type { StreamNoticeMessage } from './notice-relay.js';

const NOW = new Date('2031-01-01T00:00:00Z');
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);

const sealed = () => ({
  blob_id: randomUUID(),
  format_version: 1,
  key_id: 'k-test',
  nonce: randomBytes(12),
  ciphertext: randomBytes(8),
  tag: randomBytes(16),
});

function input(
  key: string,
  over: Partial<CandidateCreateInput> = {},
): CandidateCreateInput {
  return {
    candidate_id: randomUUID(),
    candidate_kind: 'schedule_overlap',
    notification_key: key,
    request_entity_id: null,
    request_revision: null,
    source_revision: null,
    deadline: { kind: 'date', date: '2031-01-10' },
    initial_import: false,
    unread_partial: false,
    related_analysis: null,
    received_at: '2031-01-01T00:00:00Z',
    created_at: '2031-01-01T00:00:00Z',
    title: sealed(),
    excerpt: null,
    origins: [{ source_kind: 'source_item', source_id: 'evt-1' }],
    ...over,
  };
}

interface World {
  readonly db: SqliteDatabase;
  readonly alerts: CandidateAlerts;
  readonly sent: StreamNoticeMessage[];
  readonly logs: string[];
  // 保存層の命令（書けた後の知らせを受け手へ渡す。DbWorkerClient.onCandidateWrite と同じ条件）。
  run(op: CandidateOp): Promise<CandidateOpResult>;
  setPrivate(value: boolean): void;
  setSubscribers(count: number): void;
}

async function withWorld(
  body: (world: World) => Promise<void>,
  hooks: {
    readonly afterSettingsRead?: (db: SqliteDatabase) => void;
  } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-candidate-alerts-'));
  const db = openWriteConnection(join(dir, 'buddy.sqlite'), {
    platform: 'macos',
  });
  try {
    applyMigrations(db);
    // 候補の由来（予定の元情報の行。合成）。
    db.exec(
      "INSERT INTO connections VALUES ('c-1', 'google', NULL, 'keystore:c-1', 'active', 'read_write', '[]', '{}', 1, 1)",
    );
    db.prepare(
      "INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_generation, executor_generation) VALUES ('sc-1', 'c-1', 0, 0, 0)",
    ).run();
    db.prepare(
      "INSERT INTO source_items (provider, account_id, remote_id, source_revision, scope_id, published_generation, fetched_at, body_blob_id) VALUES ('google', 'acct-1', 'evt-1', 'rev-1', 'sc-1', 0, 1000, NULL)",
    ).run();
    const sent: StreamNoticeMessage[] = [];
    const logs: string[] = [];
    let privateNow = false;
    let subscribers = 1;
    let ids = 0;
    const execute = (op: CandidateOp): CandidateOpResult => {
      const out = executeCandidateOp(db, op, {
        platform: 'macos',
        halted: false,
      }).result;
      if (op.kind === 'candidate.alert_settings_get')
        hooks.afterSettingsRead?.(db);
      return out;
    };
    let alerts: CandidateAlerts | null = null;
    const store = {
      candidate: (async (op: CandidateOp) => {
        await Promise.resolve();
        return execute(op);
      }) as never,
    };
    alerts = createCandidateAlerts({
      store,
      send: (message) => {
        sent.push(message);
        return subscribers;
      },
      privateConversation: () => privateNow,
      now: () => NOW,
      newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
      log: (line) => logs.push(line),
    });
    const world: World = {
      db,
      alerts,
      sent,
      logs,
      async run(op) {
        const result = execute(op);
        if (
          result.ok &&
          (op.kind === 'candidate.create' || op.kind === 'candidate.transition')
        )
          alerts?.observe(
            op as CandidateWriteOp,
            result.value as CandidateOpValues[CandidateWriteOp['kind']],
          );
        return result;
      },
      setPrivate: (value) => {
        privateNow = value;
      },
      setSubscribers: (count) => {
        subscribers = count;
      },
    };
    await body(world);
    await alerts.idle();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const turnOn = (db: SqliteDatabase): void => {
  db.prepare(
    "INSERT INTO candidate_alert_settings (setting_id, os_notification, settings_revision, updated_at) VALUES (1, 'on', 1, 0)",
  ).run();
};

const deliveries = (db: SqliteDatabase) =>
  db
    .prepare(
      'SELECT notification_key, reminder_id, device_id, channel, status FROM deliveries ORDER BY notification_key',
    )
    .all();

const counts = (sent: readonly StreamNoticeMessage[]) =>
  sent.map((message) =>
    message.notice.schema === 'buddy.candidate-notice.v1'
      ? message.notice.alert_count
      : -1,
  );

test('with the default off setting a new candidate sends nothing and writes no delivery', async () => {
  await withWorld(async (world) => {
    await world.run({ kind: 'candidate.create', input: input(KEY_A) });
    await world.alerts.idle();
    assert.deepEqual(world.sent, []);
    assert.deepEqual(deliveries(world.db), []);
  });
});

test('new candidates of one write burst become one notice with their number and no title, IDs or keys', async () => {
  await withWorld(async (world) => {
    turnOn(world.db);
    await world.run({ kind: 'candidate.create', input: input(KEY_A) });
    await world.run({ kind: 'candidate.create', input: input(KEY_B) });
    await world.alerts.idle();
    assert.deepEqual(world.sent, [
      {
        type: 'notice',
        notice: {
          schema: 'buddy.candidate-notice.v1',
          notice_id: '00000000-0000-4000-8000-000000000003',
          occurred_at: '2031-01-01T00:00:00.000Z',
          alert_count: 2,
        },
      },
    ]);
    // 送出意図を保存してから送り、購読へ渡せたので delivered。端末は決めない（device_id なし）。
    assert.deepEqual(deliveries(world.db), [
      {
        notification_key: KEY_A,
        reminder_id: '',
        device_id: null,
        channel: 'os_notification',
        status: 'delivered',
      },
      {
        notification_key: KEY_B,
        reminder_id: '',
        device_id: null,
        channel: 'os_notification',
        status: 'delivered',
      },
    ]);
    // 同じ識別子の作り直し（再同期）は duplicate で、知らせも記録も増えない。
    await world.run({ kind: 'candidate.create', input: input(KEY_A) });
    await world.alerts.idle();
    assert.equal(world.sent.length, 1);
    assert.equal(deliveries(world.db).length, 2);
    assert.match(world.logs.join('\n'), /出す 2 件（端末 1 台）/u);
  });
});

test('an initial import and an already delivered key only refresh the count; nothing is alerted', async () => {
  await withWorld(async (world) => {
    turnOn(world.db);
    // 前の配信の記録が残る識別子（識別子の掃除の前に候補だけが作り直された場合）。
    world.db
      .prepare(
        "INSERT INTO deliveries (delivery_id, notification_key, reminder_id, device_id, channel, status, intent_at) VALUES ('d-old', ?, '', NULL, 'os_notification', 'delivery_unknown', 0)",
      )
      .run(KEY_B);
    await world.run({
      kind: 'candidate.create',
      input: input(KEY_A, { initial_import: true }),
    });
    await world.run({ kind: 'candidate.create', input: input(KEY_B) });
    await world.alerts.idle();
    assert.deepEqual(counts(world.sent), [0]);
    assert.equal(deliveries(world.db).length, 1);
    assert.match(
      world.logs.join('\n'),
      /initial_import_listed_only 1 件・already_delivered 1 件/u,
    );
  });
});

test('with no open subscription the intent is kept as delivery_unknown and never alerted again', async () => {
  await withWorld(async (world) => {
    turnOn(world.db);
    world.setSubscribers(0);
    await world.run({ kind: 'candidate.create', input: input(KEY_A) });
    await world.alerts.idle();
    assert.deepEqual(counts(world.sent), [1]);
    assert.deepEqual(
      deliveries(world.db).map((row) => (row as { status: string }).status),
      ['delivery_unknown'],
    );
    // 購読が戻っても、状態の遷移の知らせは数 0（鳴らし直さない）。
    world.setSubscribers(1);
    const id = (
      world.db
        .prepare('SELECT candidate_id FROM notification_candidates')
        .get() as {
        candidate_id: string;
      }
    ).candidate_id;
    await world.run({
      kind: 'candidate.transition',
      input: {
        candidate_id: id,
        event: 'open',
        expected_state: 'new',
        zone: 'Asia/Tokyo',
        snooze_until: null,
        now: '2031-01-01T00:00:01Z',
      },
    });
    await world.alerts.idle();
    assert.deepEqual(counts(world.sent), [1, 0]);
  });
});

test('during a private conversation nothing is alerted or recorded, only the count notice goes out', async () => {
  await withWorld(async (world) => {
    turnOn(world.db);
    world.setPrivate(true);
    await world.run({ kind: 'candidate.create', input: input(KEY_A) });
    await world.alerts.idle();
    assert.deepEqual(counts(world.sent), [0]);
    assert.deepEqual(deliveries(world.db), []);
    assert.match(world.logs.join('\n'), /private_conversation 1 件/u);
  });
});

test('a state change sends a count notice only while on; a settings change always sends one', async () => {
  await withWorld(async (world) => {
    const created = await world.run({
      kind: 'candidate.create',
      input: input(KEY_A),
    });
    assert.equal(created.ok, true);
    const id = (
      world.db
        .prepare('SELECT candidate_id FROM notification_candidates')
        .get() as {
        candidate_id: string;
      }
    ).candidate_id;
    const dismiss = {
      kind: 'candidate.transition',
      input: {
        candidate_id: id,
        event: 'dismiss',
        expected_state: 'new',
        zone: 'Asia/Tokyo',
        snooze_until: null,
        now: '2031-01-01T00:00:01Z',
      },
    } as const;
    // 切: 遷移しても送らない。
    await world.run(dismiss);
    await world.alerts.idle();
    assert.deepEqual(world.sent, []);
    // 設定を変えた直後は、切にしたときも 1 通（端末が設定とトレイを読み直す）。
    world.alerts.settingsChanged();
    await world.alerts.idle();
    assert.deepEqual(counts(world.sent), [0]);
    turnOn(world.db);
    world.alerts.settingsChanged();
    await world.alerts.idle();
    assert.deepEqual(counts(world.sent), [0, 0]);
    // 却下した候補の識別子では、入にしても OS 通知を出さない（新しい候補だけ）。
    assert.deepEqual(deliveries(world.db), []);
  });
});

test('a setting changed between the decision and the intent stops the alert (the store checks it again)', async () => {
  await withWorld(
    async (world) => {
      turnOn(world.db);
      await world.run({ kind: 'candidate.create', input: input(KEY_C) });
      await world.alerts.idle();
      assert.deepEqual(counts(world.sent), [0]);
      assert.deepEqual(deliveries(world.db), []);
      assert.match(world.logs.join('\n'), /settings_revision_conflict 1 件/u);
    },
    {
      // 設定を読んだ直後に、別の画面が切にして入にし直した（入のままでも版が違う）。
      afterSettingsRead: (db) => {
        for (const value of ['off', 'on'])
          db.prepare(
            'UPDATE candidate_alert_settings SET os_notification = ?, settings_revision = settings_revision + 1 WHERE setting_id = 1',
          ).run(value);
      },
    },
  );
});

// --- 入・切の経路 ---

test('the setting route reads off at revision 0, changes with the revision, and refuses a stale or malformed change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-candidate-alert-routes-'));
  const db = openWriteConnection(join(dir, 'buddy.sqlite'), {
    platform: 'macos',
  });
  try {
    applyMigrations(db);
    let changed = 0;
    const routes = createCandidateAlertRoutes({
      store: {
        candidate: (async (op: CandidateOp) =>
          executeCandidateOp(db, op, { platform: 'macos', halted: false })
            .result) as never,
      },
      now: () => NOW,
      changed: () => {
        changed += 1;
      },
    });
    const call = (body: Record<string, unknown> | null) =>
      (body === null
        ? routes.handlers.getCandidateAlertSettings
        : routes.handlers.changeCandidateAlertSettings)({
        body,
      } as never);
    assert.deepEqual(await call(null), {
      status: 200,
      body: {
        schema: 'buddy.candidate-alert-settings.v1',
        os_notification: 'off',
        candidate_alert_settings_revision: '0',
      },
    });
    const change = (expected: unknown, value: unknown) =>
      call({
        request_id: '00000000-0000-4000-8000-0000000f0301',
        expected_candidate_alert_settings_revision: expected,
        os_notification: value,
      });
    assert.deepEqual(await change('0', 'on'), {
      status: 200,
      body: {
        schema: 'buddy.candidate-alert-settings.v1',
        os_notification: 'on',
        candidate_alert_settings_revision: '1',
      },
    });
    assert.equal(changed, 1);
    // 同じ版の 2 回目（古い画面・同じ要求の再送）は、切にするときも 409。
    for (const value of ['on', 'off'])
      assert.equal((await change('0', value)).status, 409, value);
    // 版は保存層と同じ 16 桁まで（17 桁は 422）。
    for (const [expected, value] of [
      ['1', 'sometimes'],
      ['01', 'off'],
      [1, 'off'],
      ['12345678901234567', 'off'],
    ])
      assert.equal(
        (await change(expected, value)).status,
        422,
        `${String(expected)} ${String(value)}`,
      );
    assert.equal(changed, 1);
    assert.deepEqual((await change('1', 'off')).body, {
      schema: 'buddy.candidate-alert-settings.v1',
      os_notification: 'off',
      candidate_alert_settings_revision: '2',
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
  // 保存層が使えない・成否不明は 503。
  const broken = createCandidateAlertRoutes({
    store: {
      candidate: (async () => ({
        ok: false,
        outcome: 'unknown',
        reasons: ['commit_failed'],
      })) as never,
    },
    now: () => NOW,
  });
  assert.equal(
    (await broken.handlers.getCandidateAlertSettings({ body: null } as never))
      .status,
    503,
  );
  assert.equal(
    (
      await broken.handlers.changeCandidateAlertSettings({
        body: {
          expected_candidate_alert_settings_revision: '0',
          os_notification: 'on',
        },
      } as never)
    ).status,
    503,
  );
});

// --- まとまり（U584。見直しの指摘 1） ---

test('writes inside one batch are judged once at its end, even when the batch throws; a state change joins the same notice', async () => {
  await withWorld(async (world) => {
    turnOn(world.db);
    await assert.rejects(
      world.alerts.batch(async () => {
        await world.run({ kind: 'candidate.create', input: input(KEY_A) });
        // まとまりの間は判定しない（次の時機を過ぎても送らない）。
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(world.sent, []);
        await world.run({ kind: 'candidate.create', input: input(KEY_B) });
        const id = (
          world.db
            .prepare(
              'SELECT candidate_id FROM notification_candidates WHERE notification_key = ?',
            )
            .get(KEY_A) as { candidate_id: string }
        ).candidate_id;
        await world.run({
          kind: 'candidate.transition',
          input: {
            candidate_id: id,
            event: 'open',
            expected_state: 'new',
            zone: 'Asia/Tokyo',
            snooze_until: null,
            now: '2031-01-01T00:00:01Z',
          },
        });
        throw new Error('intake_failed');
      }),
      /intake_failed/u,
    );
    await world.alerts.idle();
    // 2 件の新しい候補と遷移が 1 通にまとまる（開いた候補も、作ったときに新しかったので数える）。
    assert.deepEqual(counts(world.sent), [2]);
    assert.equal(deliveries(world.db).length, 2);
  });
});

test('nested batches judge once when the outer one ends', async () => {
  await withWorld(async (world) => {
    turnOn(world.db);
    await world.alerts.batch(async () => {
      await world.alerts.batch(async () => {
        await world.run({ kind: 'candidate.create', input: input(KEY_A) });
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(world.sent, []);
      await world.run({ kind: 'candidate.create', input: input(KEY_B) });
    });
    await world.alerts.idle();
    assert.deepEqual(counts(world.sent), [2]);
  });
});

// 本物の DB worker（応答は 1 件ずつ別の時機に届く）と取り込みの保存（persistCandidateDrafts。下書きを 1 件ずつ await で作る）で、
// まとまりにした 3 件の候補が 1 通の知らせになる。まとまりの外の書込みも、数え落とさずに知らせる。
test('three drafts saved through the real DB worker in one batch become one notice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-candidate-alerts-worker-'));
  const path = join(dir, 'buddy.sqlite');
  const generation = randomUUID();
  try {
    const first = await DbWorkerClient.start({
      path,
      storeGeneration: generation,
      responseTimeoutMs: 10_000,
    });
    await first.close();
    const db = openWriteConnection(path, { platform: 'macos' });
    try {
      db.exec(
        "INSERT INTO connections VALUES ('c-1', 'google', NULL, 'keystore:c-1', 'active', 'read_write', '[]', '{}', 1, 1)",
      );
      db.prepare(
        "INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_generation, executor_generation) VALUES ('sc-1', 'c-1', 0, 0, 0)",
      ).run();
      db.prepare(
        "INSERT INTO source_items (provider, account_id, remote_id, source_revision, scope_id, published_generation, fetched_at, body_blob_id) VALUES ('google', 'acct-1', 'evt-1', 'rev-1', 'sc-1', 0, 1000, NULL)",
      ).run();
      turnOn(db);
    } finally {
      db.close();
    }
    const store = await DbWorkerClient.start({
      path,
      storeGeneration: generation,
      responseTimeoutMs: 10_000,
    });
    try {
      const sent: StreamNoticeMessage[] = [];
      const alerts = createCandidateAlerts({
        store,
        send: (message) => {
          sent.push(message);
          return 1;
        },
        privateConversation: () => false,
        now: () => NOW,
        newId: () => randomUUID(),
        log: () => undefined,
      });
      const off = store.onCandidateWrite(alerts.observe);
      const ports = {
        client: store,
        dataKey: { keyId: 'k-test', key: randomBytes(32) },
        sha256Hex: (material: string) =>
          createHash('sha256').update(material, 'utf8').digest('hex'),
        newId: () => randomUUID(),
        now: () => '2031-01-01T00:00:00Z',
      };
      const draft = (n: number): CandidateDraft => ({
        candidate_kind: 'research_done',
        key_parts: {
          kind: 'research_done',
          workflow_id: `wf-${String(n)}`,
          completion_version: '1',
        },
        title: '調査の完了',
        deadline: { kind: 'none' },
        excerpt: null,
        request_entity_id: null,
        request_revision: null,
        source_revision: null,
        initial_import: false,
        unread_partial: false,
        related_analysis: null,
        received_at: '2031-01-01T00:00:00Z',
        origins: [{ source_kind: 'source_item', source_id: 'evt-1' }],
      });
      const saved = await alerts.batch(() =>
        persistCandidateDrafts(ports, [draft(1), draft(2), draft(3)]),
      );
      assert.deepEqual(
        saved.map((item) => item.outcome),
        ['created', 'created', 'created'],
      );
      await alerts.idle();
      assert.deepEqual(counts(sent), [3]);
      // まとまりの外（明示のない書込み）は書込みごとに判定する。何通に分かれても、数え落とさない。
      await persistCandidateDrafts(ports, [draft(4), draft(5)]);
      await alerts.idle();
      assert.equal(
        counts(sent)
          .slice(1)
          .reduce((sum, count) => sum + count, 0),
        2,
      );
      off();
    } finally {
      await store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
