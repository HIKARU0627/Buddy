// 予定の重複からの気づき（候補）の取り込み（B11-04、ADR 0194）。期待値は手で書く（実装と同じ関数から作らない）。
// 基準は 2030-10-09T03:00:00Z（日本時間 10 月 9 日 水曜 12:00）・Asia/Tokyo。実際の DB の候補の保存と結ぶ。
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GoogleCalendarEvent, GooglePage } from '@buddy/connectors';
import {
  applyMigrations,
  executeCandidateOp,
  openBlob,
  openWriteConnection,
} from '@buddy/storage';
import type {
  CandidateOp,
  ConnectionRecord,
  DataKeyMaterial,
  SqliteDatabase,
} from '@buddy/storage';
import {
  calendarOccurrenceOf,
  createCalendarCandidateIntake,
} from './calendar-candidate-intake.js';
import type { CalendarCandidateIntakeOptions } from './calendar-candidate-intake.js';

const KEY: DataKeyMaterial = { keyId: 'k-test', key: randomBytes(32) };
const NOW = '2030-10-09T03:00:00Z';
const SCOPE = 'sc-cal';

const CONNECTION: ConnectionRecord = {
  connection_id: 'c-1',
  provider: 'google',
  status: 'active',
  access: 'read',
  granted_scopes: [],
  targets: {
    calendar_ids: ['cal-a'],
    mail_container_ids: [],
    attachment_kinds: [],
    mail_lookback_days: 0,
    calendar_past_days: 1,
    calendar_future_days: 14,
    attachment_max_bytes: 0,
  },
  targets_state: 'complete',
  permission_revision: '1',
  scope_revision: '1',
};

// 予定（日本時間で書いた時刻を、+09:00 のずれ付きで渡す）。題は保存されないことを確かめるために付ける。
function event(
  id: string,
  start: string,
  end: string,
  over: Partial<GoogleCalendarEvent> = {},
): GoogleCalendarEvent {
  return {
    id,
    status: 'confirmed',
    summary: `合成の会議 ${id}`,
    iCalUID: `${id}-uid`,
    start: { dateTime: `${start}+09:00` },
    end: { dateTime: `${end}+09:00` },
    ...over,
  };
}

// 10/10 10:00–11:00 と 10:30–11:30 が重なる（重なりは 10:30–11:00、UTC では 01:30–02:00）。
const E1 = event('e1', '2030-10-10T10:00:00', '2030-10-10T11:00:00');
const E2 = event('e2', '2030-10-10T10:30:00', '2030-10-10T11:30:00');
// 重なっても候補にならない予定: 辞退・空き時間・勤務場所。
const DECLINED = event('e3', '2030-10-10T10:15:00', '2030-10-10T10:45:00', {
  selfResponseStatus: 'declined',
});
const FREE = event('e4', '2030-10-10T10:15:00', '2030-10-10T10:45:00', {
  transparency: 'transparent',
});
const WORK = {
  id: 'e5',
  status: 'confirmed',
  eventType: 'workingLocation',
  start: { date: '2030-10-10' },
  end: { date: '2030-10-11' },
} satisfies GoogleCalendarEvent;

// 手で書いた識別子の材料（SHA-256 は別に計算する）。
const keyOf = (refs: string[], period: string): string =>
  createHash('sha256')
    .update(
      [
        'buddy.notification-key.v1',
        'kind=schedule_overlap',
        `event_refs=${JSON.stringify(refs)}`,
        `period=${period}`,
      ].join('\n'),
    )
    .digest('hex');
const E1_E2_KEY = keyOf(
  ['ical:e1-uid#', 'ical:e2-uid#'],
  'timed:2030-10-10T01:30:00Z/2030-10-10T02:00:00Z',
);

interface Harness {
  readonly db: SqliteDatabase;
  readonly calls: {
    calendarId: string;
    timeMin: string;
    timeMax: string;
    pageToken: string | undefined;
  }[];
  pages: GoogleCalendarEvent[][];
  clock: string;
  privateNow: boolean;
  segment: { segment_id: string; segment_generation: string };
  connection: ConnectionRecord | null;
  readFails: boolean;
}

async function withIntake(
  body: (
    h: Harness,
    intake: ReturnType<typeof createCalendarCandidateIntake>,
  ) => Promise<void>,
  over: Partial<CalendarCandidateIntakeOptions> = {},
  sourceIds: readonly string[] = ['e1', 'e2', 'e6', 'e7'],
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-calendar-intake-'));
  const db = openWriteConnection(join(dir, 'buddy.sqlite'), {
    platform: 'macos',
  });
  try {
    applyMigrations(db);
    db.exec(
      "INSERT INTO connections VALUES ('c-1', 'google', NULL, 'keystore:c-1', 'active', 'read', '[]', '{}', 1, 1)",
    );
    db.prepare(
      "INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_generation, executor_generation) VALUES (?, 'c-1', 1, 2, 0)",
    ).run(SCOPE);
    for (const remote of sourceIds)
      db.prepare(
        "INSERT INTO source_items (provider, account_id, remote_id, source_revision, scope_id, published_generation, fetched_at, body_blob_id) VALUES ('google', 'acct-1', ?, 'rev-1', ?, 2, 1000, NULL)",
      ).run(remote, SCOPE);
    const h: Harness = {
      db,
      calls: [],
      pages: [
        [E1, DECLINED, FREE],
        [WORK, E2],
      ],
      clock: NOW,
      privateNow: false,
      segment: { segment_id: 'seg-1', segment_generation: '3' },
      connection: CONNECTION,
      readFails: false,
    };
    const intake = createCalendarCandidateIntake({
      store: {
        candidate: ((op: CandidateOp) =>
          Promise.resolve(
            executeCandidateOp(db, op, { platform: 'macos', halted: false })
              .result,
          )) as never,
        connectionTargets: (() =>
          Promise.resolve({ ok: true, value: h.connection })) as never,
      },
      calendarFor: () => ({
        listEventsPage: (request) => {
          h.calls.push({
            calendarId: request.calendarId,
            timeMin: request.timeMin,
            timeMax: request.timeMax,
            pageToken: request.pageToken,
          });
          if (h.readFails) return Promise.reject(new Error('network'));
          const index =
            request.pageToken === undefined ? 0 : Number(request.pageToken);
          const page: GooglePage<GoogleCalendarEvent> = {
            items: h.pages[index] ?? [],
            ...(index + 1 < h.pages.length
              ? { nextPageToken: String(index + 1) }
              : {}),
          };
          return Promise.resolve(page);
        },
      }),
      dataKey: () => Promise.resolve(KEY),
      zone: () => 'Asia/Tokyo',
      storage: {
        privateConversation: () => h.privateNow,
        origin: () => h.segment,
      },
      now: () => new Date(h.clock),
      newId: randomUUID,
      ...over,
    });
    await body(h, intake);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const rows = (db: SqliteDatabase) =>
  db
    .prepare(
      'SELECT candidate_id, kind, notification_key, state, initial_import, deadline_kind, deadline_local, deadline_zone, received_at FROM notification_candidates ORDER BY deadline_local',
    )
    .all() as {
    candidate_id: string;
    kind: string;
    notification_key: string;
    state: string;
    initial_import: number;
    deadline_kind: string;
    deadline_local: string;
    deadline_zone: string;
    received_at: number;
  }[];

const target = (generation = '2') => ({
  connection_id: 'c-1',
  scope_id: SCOPE,
  published_generation: generation,
});

test('an overlap of two busy events becomes one candidate whose title holds only the times, read from the selected calendar from now to the window end', async () => {
  await withIntake(async (h, intake) => {
    const result = await intake.run(target());
    assert.deepEqual(result, {
      outcome: 'done',
      reason: null,
      created: 1,
      duplicate: 0,
      rejected: 0,
      unknown: 0,
      resolved: [],
      retry: false,
    });
    // 選んだカレンダーだけを、いまから窓の終わり（14 日後）まで、頁を追って読む。
    assert.deepEqual(h.calls, [
      {
        calendarId: 'cal-a',
        timeMin: '2030-10-09T03:00:00.000Z',
        timeMax: '2030-10-23T03:00:00.000Z',
        pageToken: undefined,
      },
      {
        calendarId: 'cal-a',
        timeMin: '2030-10-09T03:00:00.000Z',
        timeMax: '2030-10-23T03:00:00.000Z',
        pageToken: '1',
      },
    ]);
    const saved = rows(h.db);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.kind, 'schedule_overlap');
    assert.equal(saved[0]?.notification_key, E1_E2_KEY);
    assert.equal(saved[0]?.state, 'new');
    assert.equal(saved[0]?.initial_import, 0);
    assert.equal(saved[0]?.deadline_kind, 'instant');
    assert.equal(saved[0]?.deadline_local, '2030-10-10T10:30:00');
    assert.equal(saved[0]?.deadline_zone, 'Asia/Tokyo');
    assert.equal(saved[0]?.received_at, Date.parse(NOW));
    // 由来は 2 つの予定（同期が保存した remote_id）。
    const origins = h.db
      .prepare(
        "SELECT source_kind, source_id FROM derivations WHERE artifact_kind = 'notification_candidate' ORDER BY source_id",
      )
      .all();
    assert.deepEqual(
      origins.map((o) => ({ ...(o as object) })),
      [
        { source_kind: 'source_item', source_id: 'e1' },
        { source_kind: 'source_item', source_id: 'e2' },
      ],
    );
    // 題の封筒は時刻だけ。予定の題は DB のどこにも残らない。
    const blob = h.db
      .prepare(
        "SELECT format_version, key_id, nonce, ciphertext, tag FROM sealed_blobs WHERE owner_table = 'notification_candidates' AND purpose = 'candidate_title'",
      )
      .get() as {
      format_version: number;
      key_id: string;
      nonce: Buffer;
      ciphertext: Buffer;
      tag: Buffer;
    };
    const opened = openBlob(
      KEY,
      {
        formatVersion: blob.format_version,
        keyId: blob.key_id,
        nonce: blob.nonce,
        ciphertext: blob.ciphertext,
        tag: blob.tag,
      },
      {
        ownerTable: 'notification_candidates',
        ownerId: saved[0]?.candidate_id ?? '',
        ownerVersion: 0,
        purpose: 'candidate_title',
      },
    );
    assert.deepEqual(
      JSON.parse(opened.ok ? opened.plaintext.toString('utf8') : '{}'),
      {
        title: '予定の重複：10/10 10:30–11:00',
        deadline_original_text: '予定の重複',
      },
    );
    const dump = JSON.stringify(
      h.db.prepare('SELECT * FROM notification_candidates').all(),
    );
    assert.equal(dump.includes('合成の会議'), false);
  });
});

test('a second sync does not create the same candidate twice, and a first publish marks the candidate as an initial import', async () => {
  await withIntake(async (h, intake) => {
    assert.equal(intake.shouldRun(SCOPE, 0), true);
    const first = await intake.run(target('1'));
    assert.equal(first.created, 1);
    // 終わった取得集合は、差分が無い公開では読み直さない。差分があれば読み直す。
    assert.equal(intake.shouldRun(SCOPE, 0), false);
    assert.equal(intake.shouldRun(SCOPE, 3), true);
    assert.equal(intake.shouldRun('sc-other', 0), true);
    const second = await intake.run(target('2'));
    assert.equal(second.created, 0);
    assert.equal(second.duplicate, 1);
    const saved = rows(h.db);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.initial_import, 1);
    // 却下した後の再同期でも作り直さない。
    h.db
      .prepare(
        "UPDATE notification_candidates SET state = 'dismissed', closed_at = ?, key_delete_at = ?, state_changed_at = ?",
      )
      .run(Date.parse(NOW), Date.parse(NOW) + 97 * 86_400_000, Date.parse(NOW));
    const third = await intake.run(target('3'));
    assert.equal(third.created, 0);
    assert.equal(third.duplicate, 1);
    assert.equal(rows(h.db).length, 1);
  });
});

test('an overlap that has already started is not created, and an ongoing one is not resolved', async () => {
  await withIntake(async (h, intake) => {
    // 日本時間 11:30–12:30 と 11:45–12:15（重なりは 11:45–12:15、UTC 02:45–03:15）。
    const e6 = event('e6', '2030-10-09T11:30:00', '2030-10-09T12:30:00');
    const e7 = event('e7', '2030-10-09T11:45:00', '2030-10-09T12:15:00');
    h.pages = [[e6, e7]];
    // 11:00（重なりの前）に作る。
    h.clock = '2030-10-09T02:00:00Z';
    const before = await intake.run(target());
    assert.equal(before.created, 1);
    // 12:00（重なりの途中）では、始まった重なりを下書きにせず（作成も重複も 0）、続いている重なりの候補を解決しない。
    h.clock = NOW;
    const during = await intake.run(target());
    assert.deepEqual(
      { created: during.created, duplicate: during.duplicate },
      { created: 0, duplicate: 0 },
    );
    assert.deepEqual(during.resolved, []);
    assert.equal(rows(h.db)[0]?.state, 'new');
  });
  // 初めから始まっていた重なりは候補にしない。
  await withIntake(async (h, intake) => {
    h.pages = [
      [
        event('e6', '2030-10-09T11:30:00', '2030-10-09T12:30:00'),
        event('e7', '2030-10-09T11:45:00', '2030-10-09T12:15:00'),
      ],
    ];
    const result = await intake.run(target());
    assert.equal(result.created, 0);
    assert.equal(rows(h.db).length, 0);
  });
});

test('a candidate is resolved when its events no longer overlap or one is cancelled, and left alone when its events were not read', async () => {
  // 予定の時刻が変わって重ならなくなった: overlap_resolved で resolved。
  await withIntake(async (h, intake) => {
    await intake.run(target());
    const [created] = rows(h.db);
    h.pages = [[E1, event('e2', '2030-10-10T11:00:00', '2030-10-10T12:00:00')]];
    const moved = await intake.run(target());
    assert.deepEqual(moved.resolved, [created?.candidate_id]);
    assert.equal(moved.created, 0);
    assert.equal(rows(h.db)[0]?.state, 'resolved');
  });
  // 片方が取り消された（showDeleted で cancelled として読める）: source_out_of_scope で resolved。
  await withIntake(async (h, intake) => {
    await intake.run(target());
    h.pages = [[E1, { id: 'e2', status: 'cancelled' }]];
    const cancelled = await intake.run(target());
    assert.equal(cancelled.resolved.length, 1);
    assert.equal(rows(h.db)[0]?.state, 'resolved');
  });
  // 本人が辞退に変えた: 重ならなくなるので resolved。
  await withIntake(async (h, intake) => {
    await intake.run(target());
    h.pages = [[E1, { ...E2, selfResponseStatus: 'declined' }]];
    const declined = await intake.run(target());
    assert.equal(declined.resolved.length, 1);
    assert.equal(rows(h.db)[0]?.state, 'resolved');
  });
  // 由来の予定を今回読んでいない（窓の外へ移った・カレンダーの選択を外した）: 触らない。
  await withIntake(async (h, intake) => {
    await intake.run(target());
    h.pages = [[E1]];
    const partial = await intake.run(target());
    assert.deepEqual(partial.resolved, []);
    assert.equal(rows(h.db)[0]?.state, 'new');
    h.connection = {
      ...CONNECTION,
      targets: { ...CONNECTION.targets, calendar_ids: [] },
    };
    const none = await intake.run(target());
    assert.deepEqual(none.resolved, []);
    assert.equal(rows(h.db)[0]?.state, 'new');
  });
});

test('nothing is read or created during a private conversation, and nothing is saved when the segment changes while reading', async () => {
  await withIntake(async (h, intake) => {
    h.privateNow = true;
    const result = await intake.run(target());
    assert.equal(result.outcome, 'skipped');
    assert.equal(result.reason, 'private_conversation');
    assert.equal(h.calls.length, 0);
    assert.equal(rows(h.db).length, 0);
    // 作らずに終わったので、次の公開では差分が無くても回す。
    assert.equal(intake.shouldRun(SCOPE, 0), true);
    // 記録しない会話を出た後の公開で作る。
    h.privateNow = false;
    assert.equal((await intake.run(target())).created, 1);
  });
  // 読み取りの途中で区切りが変わった（記録しない会話に入って出た）: 保存しない。
  let harness: Harness | null = null;
  await withIntake(
    async (h, intake) => {
      harness = h;
      const result = await intake.run(target());
      assert.equal(result.outcome, 'skipped');
      assert.equal(result.reason, 'storage_boundary_changed');
      assert.equal(rows(h.db).length, 0);
    },
    {
      calendarFor: () => ({
        listEventsPage: () => {
          if (harness !== null)
            harness.segment = { segment_id: 'seg-2', segment_generation: '4' };
          return Promise.resolve({ items: [E1, E2] });
        },
      }),
    },
  );
});

test('the intake refuses without a zone, an active complete Google connection, a reader, a readable calendar, a data key or a stored event', async () => {
  const expectSkip = async (
    reason: string,
    setup: (h: Harness) => void,
    over: Partial<CalendarCandidateIntakeOptions> = {},
  ): Promise<void> => {
    await withIntake(async (h, intake) => {
      setup(h);
      const result = await intake.run(target());
      assert.equal(result.outcome, 'skipped', reason);
      assert.equal(result.reason, reason);
      assert.equal(rows(h.db).length, 0, reason);
    }, over);
  };
  await expectSkip('zone_unavailable', () => undefined, { zone: () => null });
  await expectSkip('connection_unavailable', (h) => {
    h.connection = null;
  });
  await expectSkip('connection_unavailable', (h) => {
    h.connection = { ...CONNECTION, provider: 'microsoft' };
  });
  await expectSkip('connection_unavailable', (h) => {
    h.connection = { ...CONNECTION, status: 'needs_reauth' };
  });
  await expectSkip('connection_unavailable', (h) => {
    h.connection = { ...CONNECTION, targets_state: 'incomplete' };
  });
  await expectSkip('reader_unavailable', () => undefined, {
    calendarFor: () => null,
  });
  await expectSkip('window_empty', (h) => {
    h.connection = {
      ...CONNECTION,
      targets: { ...CONNECTION.targets, calendar_future_days: 0 },
    };
  });
  await expectSkip('read_failed', (h) => {
    h.readFails = true;
  });
  // 頁の上限を超えたら、一部だけで判断しない。
  await expectSkip('too_many_events', () => undefined, {
    maxPagesPerCalendar: 1,
  });
  await expectSkip('key_unavailable', () => undefined, {
    dataKey: () => Promise.resolve(null),
  });
  await expectSkip('retention_closed', () => undefined, {
    retention: {
      ready: () => Promise.resolve(),
      gate: () => ({ search: false, auto_use: false }) as never,
      lease: () => null,
    },
  });
  // 由来の予定がまだ同期に無い: 保存が拒否し、次の公開でやり直す。
  await withIntake(
    async (h, intake) => {
      const result = await intake.run(target());
      assert.equal(result.outcome, 'done');
      assert.equal(result.rejected, 1);
      assert.equal(result.retry, true);
      assert.equal(rows(h.db).length, 0);
      assert.equal(intake.shouldRun(SCOPE, 0), true);
    },
    {},
    ['e1'],
  );
});

test('Google events map to occurrences with UTC times, the own response and busy only for opaque ordinary events', () => {
  assert.deepEqual(
    calendarOccurrenceOf('cal-a', {
      id: 'r1_20301010',
      status: 'tentative',
      iCalUID: 'r1-uid',
      start: { dateTime: '2030-10-10T10:00:00+09:00' },
      end: { dateTime: '2030-10-10T10:30:00.500+09:00' },
      recurringEventId: 'r1',
      originalStartTime: { dateTime: '2030-10-10T09:00:00+09:00' },
      selfResponseStatus: 'needsAction',
    }),
    {
      calendar_id: 'cal-a',
      event_id: 'r1_20301010',
      ical_uid: 'r1-uid',
      recurrence_id: '2030-10-10T00:00:00.000Z',
      status: 'tentative',
      response: 'needs_action',
      busy: true,
      time: {
        kind: 'timed',
        start: '2030-10-10T01:00:00.000Z',
        end: '2030-10-10T01:30:00.500Z',
      },
    },
  );
  assert.deepEqual(
    calendarOccurrenceOf('cal-b', {
      id: 'd1',
      status: 'confirmed',
      start: { date: '2030-10-10' },
      end: { date: '2030-10-12' },
      originalStartTime: { date: '2030-10-10' },
      eventType: 'birthday',
    }),
    {
      calendar_id: 'cal-b',
      event_id: 'd1',
      ical_uid: null,
      recurrence_id: '2030-10-10',
      status: 'confirmed',
      response: 'none',
      busy: false,
      time: {
        kind: 'all_day',
        start_date: '2030-10-10',
        end_date: '2030-10-12',
      },
    },
  );
  // 状態・時刻の読めない予定は使わない。
  assert.equal(
    calendarOccurrenceOf('cal-a', { ...E1, status: 'unknown' }),
    null,
  );
  assert.equal(
    calendarOccurrenceOf('cal-a', { id: 'x', status: 'confirmed' }),
    null,
  );
  assert.equal(
    calendarOccurrenceOf('cal-a', {
      ...E1,
      start: { dateTime: '2030-10-10 10:00' },
    }),
    null,
  );
  assert.equal(
    calendarOccurrenceOf('cal-a', { ...E1, end: { date: '2030-10-11' } }),
    null,
  );
});
