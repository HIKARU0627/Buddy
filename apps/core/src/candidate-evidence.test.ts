// 気づきの根拠を許可範囲から取り直す（Issue #271 の残り (1)、ADR 0201）。期待値は手で書く（実装と同じ関数から作らない）。
// 基準は 2030-10-09T03:00:00Z（日本時間 10 月 9 日 水曜 12:00）・Asia/Tokyo。実際の DB（マイグレーション済みの SQLite）の
// 候補・由来の位置と結び、提供元は模擬の応答だけを返す（実 API・実データは使わない）。
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GoogleApiError } from '@buddy/connectors';
import type {
  GoogleCalendarEvent,
  GoogleGmailMessage,
  GoogleGmailMessageFormat,
} from '@buddy/connectors';
import {
  applyMigrations,
  deleteForgetNode,
  executeCandidateOp,
  openWriteConnection,
  sealBlob,
} from '@buddy/storage';
import type {
  CandidateCreateInput,
  CandidateOp,
  CandidateOpValues,
  CandidateOriginLocationInput,
  CandidateRow,
  ConnectionRecord,
  DataKeyMaterial,
  SqliteDatabase,
} from '@buddy/storage';
import { createCandidateRoutes } from './api-candidates.js';
import { createCandidateEvidenceSource } from './candidate-evidence.js';
import type { EvidenceTarget } from './candidate-evidence.js';
import { runCandidateMaintenance } from './candidate-maintenance.js';

const KEY: DataKeyMaterial = { keyId: 'k-test', key: randomBytes(32) };
const NOW = '2030-10-09T03:00:00Z';
const ZONE = 'Asia/Tokyo';
const OVERLAP = 'a1000000-0000-4000-8000-000000000001';
const MAIL = 'a1000000-0000-4000-8000-000000000002';
const BARE = 'a1000000-0000-4000-8000-000000000003';
const SCOPE_CAL = 'sc-cal';
const SCOPE_MAIL = 'sc-mail';

const CONNECTION: ConnectionRecord = {
  connection_id: 'c-1',
  provider: 'google',
  status: 'active',
  access: 'read',
  granted_scopes: [],
  targets: {
    calendar_ids: ['cal-a'],
    mail_container_ids: ['INBOX'],
    attachment_kinds: [],
    mail_lookback_days: 30,
    calendar_past_days: 1,
    calendar_future_days: 14,
    attachment_max_bytes: 1000,
  },
  targets_state: 'complete',
  permission_revision: '1',
  scope_revision: '1',
};
const TARGETS: readonly EvidenceTarget[] = [
  { account_id: 'acct-1', scope_id: SCOPE_MAIL, resource: 'mail' },
  { account_id: 'acct-1', scope_id: SCOPE_CAL, resource: 'calendar' },
];

// 予定（日本時間で書いた時刻を +09:00 のずれ付きで渡す）。
function event(
  id: string,
  start: string,
  end: string,
  over: Partial<GoogleCalendarEvent> = {},
): GoogleCalendarEvent {
  return {
    id,
    status: 'confirmed',
    etag: `"${id}-etag"`,
    summary: `合成の予定${id}`,
    iCalUID: `${id}-uid`,
    start: { dateTime: `${start}+09:00` },
    end: { dateTime: `${end}+09:00` },
    ...over,
  };
}
// 10/10 10:00–11:00 と 10:30–11:30 が重なる（重なりは UTC で 01:30–02:00）。
const E1 = event('e1', '2030-10-10T10:00:00', '2030-10-10T11:00:00');
const E2 = event('e2', '2030-10-10T10:30:00', '2030-10-10T11:30:00');
// 手で書いた識別子の材料（ADR 0117。SHA-256 は別に計算する）。
const OVERLAP_KEY = createHash('sha256')
  .update(
    [
      'buddy.notification-key.v1',
      'kind=schedule_overlap',
      `event_refs=${JSON.stringify(['ical:e1-uid#', 'ical:e2-uid#'])}`,
      'period=timed:2030-10-10T01:30:00Z/2030-10-10T02:00:00Z',
    ].join('\n'),
  )
  .digest('hex');

// メール（受信は 10/8 09:00 UTC、版は historyId）。本文の 4〜10 文字目（コードポイント）が控えた引用。
const BODY =
  'お世話になります。明日までにご返信ください。よろしくお願いします。';
const MESSAGE: GoogleGmailMessage = {
  id: 'm1',
  labelIds: ['INBOX', 'UNREAD'],
  historyId: '100',
  internalDate: String(Date.parse('2030-10-08T09:00:00Z')),
};

const calLocation = (sourceId: string): CandidateOriginLocationInput => ({
  source_id: sourceId,
  provider: 'google',
  connection_id: 'c-1',
  account_id: 'acct-1',
  scope_id: SCOPE_CAL,
  resource: 'calendar',
  container_id: 'cal-a',
  quote: null,
});
const MAIL_LOCATION: CandidateOriginLocationInput = {
  source_id: 'm1',
  provider: 'google',
  connection_id: 'c-1',
  account_id: 'acct-1',
  scope_id: SCOPE_MAIL,
  resource: 'mail',
  container_id: '',
  // 「明日までにご返信ください」= 9〜21（コードポイント、end は含まない）。
  quote: { part: 'body', start: 9, end: 21 },
};

interface World {
  readonly db: SqliteDatabase;
  connection: ConnectionRecord | null;
  connectionFails: boolean;
  targets: readonly EvidenceTarget[] | 'throw';
  events: Map<string, GoogleCalendarEvent | number>;
  messages: Map<string, GoogleGmailMessage | number>;
  privateNow: boolean;
  zone: string | null;
  calendar: boolean;
  readonly reads: string[];
}

function sealed(candidateId: string, purpose: string, text: string) {
  const out = sealBlob(KEY, Buffer.from(text, 'utf8'), {
    ownerTable: 'notification_candidates',
    ownerId: candidateId,
    ownerVersion: 0,
    purpose: purpose as never,
  });
  assert.ok(out.ok);
  return {
    blob_id: randomUUID(),
    format_version: out.envelope.formatVersion,
    key_id: out.envelope.keyId,
    nonce: out.envelope.nonce,
    ciphertext: out.envelope.ciphertext,
    tag: out.envelope.tag,
  };
}

function create(db: SqliteDatabase, input: CandidateCreateInput): void {
  const out = executeCandidateOp(
    db,
    { kind: 'candidate.create', input },
    { platform: 'macos', halted: false },
  ).result;
  assert.equal(out.ok, true, JSON.stringify(out));
}

const base = (
  candidateId: string,
): Omit<
  CandidateCreateInput,
  'candidate_kind' | 'notification_key' | 'origins'
> => ({
  candidate_id: candidateId,
  request_entity_id: null,
  request_revision: null,
  source_revision: null,
  deadline: { kind: 'instant', local_datetime: '2030-10-10T10:30', zone: ZONE },
  initial_import: false,
  unread_partial: false,
  related_analysis: null,
  received_at: NOW,
  created_at: NOW,
  title: sealed(
    candidateId,
    'candidate_title',
    JSON.stringify({
      title: '予定の重複：10/10 10:30–11:00',
      deadline_original_text: null,
    }),
  ),
  excerpt: null,
});

async function withWorld(
  body: (
    w: World,
    source: ReturnType<typeof createCandidateEvidenceSource>,
  ) => Promise<void>,
  mailText = true,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-candidate-evidence-'));
  const db = openWriteConnection(join(dir, 'buddy.sqlite'), {
    platform: 'macos',
  });
  try {
    applyMigrations(db);
    db.exec(
      "INSERT INTO connections VALUES ('c-1', 'google', NULL, 'keystore:c-1', 'active', 'read', '[]', '{}', 1, 1)",
    );
    for (const scope of [SCOPE_CAL, SCOPE_MAIL])
      db.prepare(
        "INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_generation, executor_generation) VALUES (?, 'c-1', 1, 2, 0)",
      ).run(scope);
    for (const [remote, scope] of [
      ['e1', SCOPE_CAL],
      ['e2', SCOPE_CAL],
      ['m1', SCOPE_MAIL],
    ] as const)
      db.prepare(
        "INSERT INTO source_items (provider, account_id, remote_id, source_revision, scope_id, published_generation, fetched_at, body_blob_id) VALUES ('google', 'acct-1', ?, 'rev-1', ?, 2, 1000, NULL)",
      ).run(remote, scope);
    create(db, {
      ...base(OVERLAP),
      candidate_kind: 'schedule_overlap',
      notification_key: OVERLAP_KEY,
      origins: [
        { source_kind: 'source_item', source_id: 'e1' },
        { source_kind: 'source_item', source_id: 'e2' },
      ],
      locations: [calLocation('e1'), calLocation('e2')],
    });
    create(db, {
      ...base(MAIL),
      candidate_kind: 'mail_reply',
      notification_key: 'b'.repeat(64),
      source_revision: '100',
      unread_partial: true,
      deadline: { kind: 'date', date: '2030-10-10' },
      excerpt: sealed(MAIL, 'candidate_excerpt', '明日までにご返信ください'),
      origins: [{ source_kind: 'source_item', source_id: 'm1' }],
      locations: [MAIL_LOCATION],
    });
    // 由来の位置を控えていない候補（0026 より前に作られた候補と同じ）。
    create(db, {
      ...base(BARE),
      candidate_kind: 'schedule_overlap',
      notification_key: 'c'.repeat(64),
      origins: [
        { source_kind: 'source_item', source_id: 'e1' },
        { source_kind: 'source_item', source_id: 'e2' },
      ],
    });
    const w: World = {
      db,
      connection: CONNECTION,
      connectionFails: false,
      targets: TARGETS,
      events: new Map([
        ['cal-a|e1', E1],
        ['cal-a|e2', E2],
      ]),
      messages: new Map([['m1', MESSAGE]]),
      privateNow: false,
      zone: ZONE,
      calendar: true,
      reads: [],
    };
    const source = createCandidateEvidenceSource({
      store: {
        candidate: ((op: CandidateOp) =>
          Promise.resolve(
            executeCandidateOp(db, op, { platform: 'macos', halted: false })
              .result,
          )) as never,
        connectionTargets: (() =>
          Promise.resolve(
            w.connectionFails
              ? { ok: false, outcome: 'rejected', reasons: ['busy'] }
              : { ok: true, value: w.connection },
          )) as never,
      },
      targetsFor: () =>
        w.targets === 'throw'
          ? Promise.reject(new Error('identity'))
          : Promise.resolve(w.targets),
      calendarFor: () =>
        w.calendar
          ? {
              getEvent: ({ calendarId, eventId }) => {
                w.reads.push(`event:${calendarId}/${eventId}`);
                const found = w.events.get(`${calendarId}|${eventId}`);
                if (found === undefined || typeof found === 'number')
                  return Promise.reject(
                    new GoogleApiError('http_error', 1, found ?? 404),
                  );
                return Promise.resolve(found);
              },
            }
          : null,
      gmailFor: () => ({
        getMessage: ({
          id,
          format,
        }: {
          id: string;
          format: GoogleGmailMessageFormat;
        }) => {
          w.reads.push(`mail:${id}:${format}`);
          const found = w.messages.get(id);
          if (found === undefined || typeof found === 'number')
            return Promise.reject(
              new GoogleApiError('http_error', 1, found ?? 404),
            );
          return Promise.resolve(found);
        },
      }),
      zone: () => w.zone,
      storage: { privateConversation: () => w.privateNow },
      ...(mailText
        ? {
            mailText: (message: GoogleGmailMessage, part: string) =>
              message.id === 'm1' && part === 'body' ? BODY : null,
          }
        : {}),
      now: () => new Date(NOW),
    });
    await body(w, source);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function read(
  db: SqliteDatabase,
  candidateId: string,
): CandidateOpValues['candidate.get'] {
  const out = executeCandidateOp(
    db,
    { kind: 'candidate.get', candidate_id: candidateId },
    { platform: 'macos', halted: false },
  ).result;
  assert.ok(out.ok);
  return out.value as CandidateOpValues['candidate.get'];
}

async function fetchOf(
  w: World,
  source: ReturnType<typeof createCandidateEvidenceSource>,
  candidateId: string,
) {
  const got = read(w.db, candidateId);
  return source.fetchEvidence(
    got.candidate as CandidateRow,
    got.origins,
    got.locations,
  );
}

test('a live overlap is read back event by event from the noted calendar and answers with both titles', async () => {
  await withWorld(async (w, source) => {
    assert.deepEqual(await fetchOf(w, source, OVERLAP), {
      observation: 'available',
      sources: [
        {
          source_id: 'e1',
          source_revision: '"e1-etag"',
          quote: '合成の予定e1',
          start: 0,
          end: 7,
        },
        {
          source_id: 'e2',
          source_revision: '"e2-etag"',
          quote: '合成の予定e2',
          start: 0,
          end: 7,
        },
      ],
      unread: false,
    });
    // 控えたカレンダーと予定だけを 1 件ずつ読む（ほかのカレンダー・一覧を探さない）。
    assert.deepEqual(w.reads, ['event:cal-a/e1', 'event:cal-a/e2']);
    // 題の無い予定は引用に入れない（推測で埋めない）。重複は今もあるので有効。
    w.events.set('cal-a|e2', { ...E2, summary: '  ' });
    assert.deepEqual(await fetchOf(w, source, OVERLAP), {
      observation: 'available',
      sources: [
        {
          source_id: 'e1',
          source_revision: '"e1-etag"',
          quote: '合成の予定e1',
          start: 0,
          end: 7,
        },
      ],
      unread: false,
    });
    // 保守の再確認は観測だけ。
    assert.equal(
      await source.checkEvidence(read(w.db, OVERLAP).candidate as CandidateRow),
      'available',
    );
    // 引用はどこにも保存しない（DB に予定の題が無い）。
    const dump = JSON.stringify(
      w.db.prepare('SELECT * FROM candidate_origin_locations').all(),
    );
    assert.ok(!dump.includes('合成の予定'));
  });
});

test('an overlap that moved, was declined, turned free, was cancelled or deleted is no longer valid evidence', async () => {
  const cases: readonly {
    readonly name: string;
    readonly e2: GoogleCalendarEvent | number;
    readonly expected: string;
  }[] = [
    // 時刻を 11:00 からに動かした（重ならない）。
    {
      name: 'moved',
      e2: event('e2', '2030-10-10T11:00:00', '2030-10-10T12:00:00'),
      expected: 'overlap_resolved',
    },
    // 重なりの時間が変わった（識別子の期間が変わる）。
    {
      name: 'shifted',
      e2: event('e2', '2030-10-10T10:45:00', '2030-10-10T11:30:00'),
      expected: 'overlap_resolved',
    },
    {
      name: 'declined',
      e2: { ...E2, selfResponseStatus: 'declined' },
      expected: 'overlap_resolved',
    },
    {
      name: 'free',
      e2: { ...E2, transparency: 'transparent' },
      expected: 'overlap_resolved',
    },
    {
      name: 'cancelled',
      e2: { ...E2, status: 'cancelled' },
      expected: 'removed',
    },
    { name: 'deleted', e2: 404, expected: 'removed' },
    { name: 'gone', e2: 410, expected: 'removed' },
    { name: 'server error', e2: 500, expected: 'temporarily_unavailable' },
    // 時刻が読めない予定は判断しない。
    {
      name: 'time unreadable',
      e2: { ...E2, start: { dateTime: 'soon' } },
      expected: 'temporarily_unavailable',
    },
  ];
  for (const entry of cases)
    await withWorld(async (w, source) => {
      w.events.set('cal-a|e2', entry.e2);
      const got = await fetchOf(w, source, OVERLAP);
      assert.deepEqual(got, { observation: entry.expected }, entry.name);
    });
});

test('outside the allowed range the evidence is out of scope, and nothing is read when the noted place is no longer allowed', async () => {
  const cases: readonly {
    readonly name: string;
    readonly change: (w: World) => void;
    readonly expected: string;
    readonly reads: readonly string[];
  }[] = [
    {
      name: 'calendar deselected',
      change: (w) => {
        w.connection = {
          ...CONNECTION,
          targets: { ...CONNECTION.targets, calendar_ids: ['cal-b'] },
        };
      },
      expected: 'out_of_scope',
      reads: [],
    },
    {
      name: 'connection removed',
      change: (w) => {
        w.connection = null;
      },
      expected: 'out_of_scope',
      reads: [],
    },
    {
      name: 'disconnected',
      change: (w) => {
        w.connection = { ...CONNECTION, status: 'disconnected' };
      },
      expected: 'out_of_scope',
      reads: [],
    },
    // 口座の付け替え: 同じ接続が別の口座を読んでいる。
    {
      name: 'account replaced',
      change: (w) => {
        w.targets = [
          { account_id: 'acct-2', scope_id: SCOPE_CAL, resource: 'calendar' },
        ];
      },
      expected: 'out_of_scope',
      reads: [],
    },
    {
      name: 'scope recreated',
      change: (w) => {
        w.targets = [
          { account_id: 'acct-1', scope_id: 'sc-new', resource: 'calendar' },
        ];
      },
      expected: 'out_of_scope',
      reads: [],
    },
    {
      name: 'calendar no longer read',
      change: (w) => {
        w.targets = [
          { account_id: 'acct-1', scope_id: SCOPE_MAIL, resource: 'mail' },
        ];
      },
      expected: 'out_of_scope',
      reads: [],
    },
    // 予定が取得の窓（10/8 12:00〜10/23 12:00 JST）の後へ動いた。
    {
      name: 'moved past the window',
      change: (w) => {
        w.events.set(
          'cal-a|e1',
          event('e1', '2030-10-24T10:00:00', '2030-10-24T11:00:00'),
        );
      },
      expected: 'out_of_scope',
      reads: ['event:cal-a/e1'],
    },
    // 取り直せない（解決しない）側。
    {
      name: 'needs reauth',
      change: (w) => {
        w.connection = { ...CONNECTION, status: 'needs_reauth' };
      },
      expected: 'temporarily_unavailable',
      reads: [],
    },
    {
      name: 'targets incomplete',
      change: (w) => {
        w.connection = { ...CONNECTION, targets_state: 'incomplete' };
      },
      expected: 'temporarily_unavailable',
      reads: [],
    },
    {
      name: 'connection unreadable',
      change: (w) => {
        w.connectionFails = true;
      },
      expected: 'temporarily_unavailable',
      reads: [],
    },
    {
      name: 'account unreadable',
      change: (w) => {
        w.targets = [];
      },
      expected: 'temporarily_unavailable',
      reads: [],
    },
    {
      name: 'account lookup throws',
      change: (w) => {
        w.targets = 'throw';
      },
      expected: 'temporarily_unavailable',
      reads: [],
    },
    {
      name: 'no token',
      change: (w) => {
        w.calendar = false;
      },
      expected: 'temporarily_unavailable',
      reads: [],
    },
    {
      name: 'zone unknown',
      change: (w) => {
        w.zone = null;
      },
      expected: 'temporarily_unavailable',
      reads: [],
    },
  ];
  for (const entry of cases)
    await withWorld(async (w, source) => {
      entry.change(w);
      assert.deepEqual(
        await fetchOf(w, source, OVERLAP),
        { observation: entry.expected },
        entry.name,
      );
      assert.deepEqual(w.reads, entry.reads, entry.name);
    });
});

test('during a private conversation, without a noted place, or for an Outlook place nothing is read and the evidence stays unconfirmed', async () => {
  await withWorld(async (w, source) => {
    w.privateNow = true;
    assert.deepEqual(await fetchOf(w, source, OVERLAP), {
      observation: 'temporarily_unavailable',
    });
    assert.deepEqual(await fetchOf(w, source, MAIL), {
      observation: 'temporarily_unavailable',
    });
    assert.equal(
      await source.checkEvidence(read(w.db, OVERLAP).candidate as CandidateRow),
      'temporarily_unavailable',
    );
    w.privateNow = false;
    // 0026 より前の候補（位置を控えていない）。
    assert.deepEqual(await fetchOf(w, source, BARE), {
      observation: 'temporarily_unavailable',
    });
    assert.deepEqual(w.reads, []);
    // Outlook の位置は取り直す口が無い（U682）。
    const outlook = read(w.db, MAIL);
    assert.deepEqual(
      await source.fetchEvidence(
        outlook.candidate as CandidateRow,
        outlook.origins,
        [{ ...MAIL_LOCATION, provider: 'microsoft' }],
      ),
      { observation: 'temporarily_unavailable' },
    );
    assert.deepEqual(w.reads, []);
  });
});

test('a mail is read back from the noted account, checked against its labels, window and version, and the noted quote is cut from the body', async () => {
  await withWorld(async (w, source) => {
    assert.deepEqual(await fetchOf(w, source, MAIL), {
      observation: 'available',
      sources: [
        {
          source_id: 'm1',
          source_revision: '100',
          quote: '明日までにご返信ください',
          start: 9,
          end: 21,
        },
      ],
      // 未読の部分は候補を作ったときの完全性。
      unread: true,
    });
    // 保守の再確認は本文を読まない（minimal）。
    assert.equal(
      await source.checkEvidence(read(w.db, MAIL).candidate as CandidateRow),
      'available',
    );
    assert.deepEqual(w.reads, ['mail:m1:full', 'mail:m1:minimal']);
  });
  const cases: readonly {
    readonly name: string;
    readonly message: GoogleGmailMessage | number;
    readonly expected: string;
  }[] = [
    {
      name: 'version changed',
      message: { ...MESSAGE, historyId: '101' },
      expected: 'revised',
    },
    {
      name: 'label removed',
      message: { ...MESSAGE, labelIds: ['ARCHIVE'] },
      expected: 'out_of_scope',
    },
    // 受信が取得の窓（30 日）より前。
    {
      name: 'before the window',
      message: {
        ...MESSAGE,
        internalDate: String(Date.parse('2030-09-08T00:00:00Z')),
      },
      expected: 'out_of_scope',
    },
    { name: 'deleted', message: 404, expected: 'removed' },
    { name: 'server error', message: 503, expected: 'temporarily_unavailable' },
    {
      name: 'no receipt time',
      message: { id: 'm1', labelIds: ['INBOX'], historyId: '100' },
      expected: 'temporarily_unavailable',
    },
  ];
  for (const entry of cases)
    await withWorld(async (w, source) => {
      w.messages.set('m1', entry.message);
      assert.deepEqual(
        await fetchOf(w, source, MAIL),
        { observation: entry.expected },
        entry.name,
      );
    });
});

test('a mail quote that cannot be cut from the body, or without a body builder, is left out instead of guessed', async () => {
  await withWorld(async (w, source) => {
    const got = read(w.db, MAIL);
    // 控えた位置が本文の外。
    assert.deepEqual(
      await source.fetchEvidence(got.candidate as CandidateRow, got.origins, [
        { ...MAIL_LOCATION, quote: { part: 'body', start: 30, end: 80 } },
      ]),
      { observation: 'available', sources: [], unread: true },
    );
    // 件名の本文を作れない。
    assert.deepEqual(
      await source.fetchEvidence(got.candidate as CandidateRow, got.origins, [
        { ...MAIL_LOCATION, quote: { part: 'subject', start: 0, end: 2 } },
      ]),
      { observation: 'available', sources: [], unread: true },
    );
  });
  // 本文の作り方が無ければ本文を読まず、引用を入れない。
  await withWorld(async (w, source) => {
    assert.deepEqual(await fetchOf(w, source, MAIL), {
      observation: 'available',
      sources: [],
      unread: true,
    });
    assert.deepEqual(w.reads, ['mail:m1:minimal']);
  }, false);
});

test('the route answers with the titles, resolves a cancelled overlap, and a forgotten candidate is gone with its noted place', async () => {
  await withWorld(async (w, source) => {
    const routes = createCandidateRoutes({
      store: {
        candidate: ((op: CandidateOp) =>
          Promise.resolve(
            executeCandidateOp(w.db, op, { platform: 'macos', halted: false })
              .result,
          )) as never,
      },
      dataKey: () => Promise.resolve(KEY),
      zone: () => ZONE,
      now: () => NOW,
      fetchEvidence: source.fetchEvidence,
    }).handlers;
    const call = (candidateId: string) =>
      routes.getCandidateEvidence({
        params: { candidate_id: candidateId },
        body: {
          request_id: 'd4000000-0000-4000-8000-0000000000bb',
          command_scope_id: 'd4000000-0000-4000-8000-0000000000cc',
        },
      } as never);
    const ok = await call(OVERLAP);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, {
      candidate_id: OVERLAP,
      request_entity_id: null,
      request_revision: null,
      sources: [
        {
          source_id: 'e1',
          source_revision: '"e1-etag"',
          quote: '合成の予定e1',
          start: 0,
          end: 7,
        },
        {
          source_id: 'e2',
          source_revision: '"e2-etag"',
          quote: '合成の予定e2',
          start: 0,
          end: 7,
        },
      ],
      unread: false,
      excerpt: null,
    });
    // メールは保存した抄録も返す。
    const mail = await call(MAIL);
    assert.equal(mail.status, 200);
    assert.equal(
      (mail.body as Record<string, unknown>)['excerpt'],
      '明日までにご返信ください',
    );
    // 取り直せない: 状態を変えず 503（未確認）。
    w.privateNow = true;
    assert.equal((await call(OVERLAP)).status, 503);
    w.privateNow = false;
    // 予定が取り消された: resolved にして 409。
    w.events.set('cal-a|e2', { ...E2, status: 'cancelled' });
    assert.equal((await call(OVERLAP)).status, 409);
    assert.equal(read(w.db, OVERLAP).candidate?.state, 'resolved');
    // 忘却の削除で候補と取り直す先が消えたら、根拠は無い（422）。
    assert.equal(
      deleteForgetNode(w.db, { kind: 'notification_candidate', id: MAIL }),
      1,
    );
    assert.equal((await call(MAIL)).status, 422);
    assert.equal(
      w.db
        .prepare(
          'SELECT count(*) FROM candidate_origin_locations WHERE candidate_id = ?',
        )
        .pluck()
        .get(MAIL),
      0,
    );
  });
});

test('the maintenance re-check resolves a deleted event and only reports an unreadable one', async () => {
  await withWorld(async (w, source) => {
    w.events.set('cal-a|e1', 404);
    w.messages.set('m1', 503);
    const report = await runCandidateMaintenance({
      client: {
        candidate: ((op: CandidateOp) =>
          Promise.resolve(
            executeCandidateOp(w.db, op, { platform: 'macos', halted: false })
              .result,
          )) as never,
      },
      zone: ZONE,
      now: () => NOW,
      checkEvidence: source.checkEvidence,
    });
    assert.deepEqual(report.evidence_resolved, [OVERLAP]);
    // メールは読めなかった（未確認）。位置の無い候補も未確認で、どちらも状態は変えない。
    assert.deepEqual(
      [...report.evidence_standing].sort((a, b) =>
        a.candidate_id.localeCompare(b.candidate_id),
      ),
      [
        { candidate_id: MAIL, evidence: 'unconfirmed' },
        { candidate_id: BARE, evidence: 'unconfirmed' },
      ],
    );
    assert.equal(read(w.db, OVERLAP).candidate?.state, 'resolved');
    assert.equal(read(w.db, MAIL).candidate?.state, 'new');
  });
});

test('until the retention sweep is done nothing is read and the evidence stays unconfirmed; the lease is held only while reading (ADR 0053)', async () => {
  const run = async (open: boolean) => {
    const events: string[] = [];
    let out: unknown;
    await withWorld(async (w) => {
      const source = createCandidateEvidenceSource({
        store: {
          candidate: ((op: CandidateOp) =>
            Promise.resolve(
              executeCandidateOp(w.db, op, { platform: 'macos', halted: false })
                .result,
            )) as never,
          connectionTargets: (() =>
            Promise.resolve({ ok: true, value: CONNECTION })) as never,
        },
        targetsFor: () => TARGETS,
        calendarFor: () => ({
          getEvent: ({ eventId }) => {
            events.push(`read:${eventId}`);
            return Promise.resolve(eventId === 'e1' ? E1 : E2);
          },
        }),
        gmailFor: () => null,
        zone: () => ZONE,
        storage: { privateConversation: () => false },
        now: () => new Date(NOW),
        retention: {
          ready: () => {
            events.push('ready');
            return Promise.resolve();
          },
          gate: () => ({ search: open, auto_use: open, reasons: [] }) as never,
          lease: () => {
            events.push('lease');
            return () => events.push('release');
          },
        },
      });
      const got = read(w.db, OVERLAP);
      out = (
        await source.fetchEvidence(
          got.candidate as CandidateRow,
          got.origins,
          got.locations,
        )
      ).observation;
    });
    return { events, out };
  };
  assert.deepEqual(await run(true), {
    events: ['ready', 'lease', 'read:e1', 'read:e2', 'release'],
    out: 'available',
  });
  assert.deepEqual(await run(false), {
    events: ['ready'],
    out: 'temporarily_unavailable',
  });
});
