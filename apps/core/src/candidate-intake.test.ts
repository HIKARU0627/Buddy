// 気づき（候補）の生成（B11-04 P1、ADR 0119）。期待値は手で書く（実装と同じ関数から作らない）。
// 題の文字列・候補にしない理由・重複した作成の拒否・封筒の中身と所有者の結び付き・予定の重複の題を見る。
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  Deadline,
  ExtractedRequest,
  ExtractionResult,
} from '@buddy/contracts';
import { findScheduleOverlaps } from '@buddy/domain';
import type { CalendarOccurrence } from '@buddy/domain';
import {
  applyMigrations,
  executeCandidateOp,
  openBlob,
  openWriteConnection,
} from '@buddy/storage';
import type {
  CandidateOp,
  CandidateOpValues,
  DataKeyMaterial,
  SqliteDatabase,
} from '@buddy/storage';
import {
  mailCandidateDrafts,
  mailCandidateTitle,
  persistCandidateDrafts,
  scheduleOverlapDrafts,
} from './candidate-intake.js';
import type {
  CandidatePersistPorts,
  MailCandidateContext,
} from './candidate-intake.js';

const ZONE = 'Asia/Tokyo';
const KEY: DataKeyMaterial = { keyId: 'k-test', key: randomBytes(32) };
const sha256Hex = (material: string): string =>
  createHash('sha256').update(material).digest('hex');
const ACCOUNT = 'a2000000-0000-4000-8000-000000000001';
const ENTITY = 'b1000000-0000-4000-8000-000000000001';

const instant = (local: string, text = '10月7日 17時まで'): Deadline => ({
  kind: 'instant',
  local_datetime: local,
  zone: ZONE,
  original_text: text,
});
const dateOnly = (date: string, text = '10月7日まで'): Deadline => ({
  kind: 'date',
  date,
  original_text: text,
});

function request(over: Partial<ExtractedRequest> = {}): ExtractedRequest {
  return {
    request_index: 0,
    kind: 'reply_required',
    summary: '参加可否の返信',
    deadline: dateOnly('2030-10-07'),
    fields: [
      {
        field: 'summary',
        status: 'explicit',
        refs: [
          {
            source_id: 'msg-1',
            source_revision: 'rev-1',
            quote: '参加可否をご返信ください。',
            start: 0,
            end: 13,
          },
        ],
        rule_id: null,
      },
    ],
    in_quoted_text: false,
    confidence_observed: 'high',
    addressed_to_me: true,
    from_automated_sender: false,
    request_entity_id: ENTITY,
    request_revision: '2',
    ...over,
  };
}

function extraction(
  requests: ExtractedRequest[],
  over: Partial<ExtractionResult> = {},
): ExtractionResult {
  return {
    schema: 'buddy.extraction.v2',
    source_account_id: ACCOUNT,
    thread_id: 'thread-1',
    message_id: 'msg-1',
    source_revision: 'rev-1',
    profile_id: 'a1000000-0000-4000-8000-000000000001',
    prompt_hash: 'b'.repeat(64),
    schema_hash: 'c'.repeat(64),
    requests,
    changes: [],
    completeness: {
      source_revisions: [{ source_id: 'msg-1', source_revision: 'rev-1' }],
      unread_source_ids: [],
      truncated_source_ids: [],
    },
    ...over,
  };
}

const CONTEXT: MailCandidateContext = {
  zone: ZONE,
  received_at: '2030-10-05T01:00:00Z',
  initial_import: false,
  sender_label: '山田さん',
};

test('the title is the request, its deadline and the sender, within 60 characters', () => {
  const title = (over: {
    summary?: string;
    deadline?: Deadline;
    sender_label?: string | null;
    kind?: 'mail_reply' | 'mail_deadline';
  }): string | null =>
    mailCandidateTitle({
      kind: over.kind ?? 'mail_reply',
      summary: over.summary ?? '参加可否の返信',
      deadline: over.deadline ?? dateOnly('2030-10-07'),
      sender_label:
        over.sender_label === undefined ? '山田さん' : over.sender_label,
    });
  // 設計 11 §4 の例。
  assert.equal(
    title({ deadline: instant('2030-10-07T17:00') }),
    '参加可否の返信：10/7 17:00まで（山田さん）',
  );
  assert.equal(
    title({ summary: '見積の提出', deadline: dateOnly('2030-10-09') }),
    '見積の提出：10/9まで（山田さん）',
  );
  assert.equal(
    title({ summary: '見積の提出', deadline: { kind: 'none' } }),
    '見積の提出（山田さん）',
  );
  assert.equal(
    title({
      summary: '見積の提出',
      deadline: {
        kind: 'unresolved',
        reason: 'relative',
        original_text: '来週',
      },
      sender_label: null,
    }),
    '見積の提出',
  );
  // 長い要約は削って、期限と差出人を残す（60 文字ちょうど）。
  const long = title({
    summary: 'あ'.repeat(80),
    deadline: dateOnly('2030-10-09'),
    sender_label: '山田',
  });
  assert.equal(long, `${'あ'.repeat(48)}…：10/9まで（山田）`);
  assert.equal([...(long ?? '')].length, 60);
  // 時刻は 0 を詰めず、分は 2 桁。
  assert.equal(
    title({
      summary: '面談',
      deadline: instant('2030-01-02T09:05:00'),
      sender_label: null,
    }),
    '面談：1/2 9:05まで',
  );
  // 差出人の表示名は 12 文字までで、アドレスの形（@）は使わない。
  assert.equal(
    title({
      summary: '面談',
      deadline: { kind: 'none' },
      sender_label: 'あ'.repeat(20),
    }),
    `面談（${'あ'.repeat(11)}…）`,
  );
  assert.equal(
    title({
      summary: '面談',
      deadline: { kind: 'none' },
      sender_label: 'taro@example.com',
    }),
    '面談',
  );
});

test('a title that says the reply is missing is replaced by a fixed one', () => {
  const kinds = [
    ['山田さんへ未返信です', 'mail_reply', '返信の依頼：10/7まで（山田さん）'],
    ['返信がありません', 'mail_reply', '返信の依頼：10/7まで（山田さん）'],
    ['未対応の件', 'mail_deadline', '対応の依頼：10/7まで（山田さん）'],
    ['', 'mail_deadline', '対応の依頼：10/7まで（山田さん）'],
    ['   \n  ', 'mail_reply', '返信の依頼：10/7まで（山田さん）'],
  ] as const;
  for (const [summary, kind, expected] of kinds)
    assert.equal(
      mailCandidateTitle({
        kind,
        summary,
        deadline: dateOnly('2030-10-07'),
        sender_label: '山田さん',
      }),
      expected,
      summary,
    );
  // 空白と改行は 1 つにまとめる。
  assert.equal(
    mailCandidateTitle({
      kind: 'mail_reply',
      summary: '参加可否\n  の返信',
      deadline: { kind: 'none' },
      sender_label: null,
    }),
    '参加可否 の返信',
  );
});

test('only a reply or an action addressed to me, outside quotes, with a resolved id becomes a draft', () => {
  const result = extraction([
    request({
      request_index: 4,
      kind: 'action_required',
      summary: '見積の提出',
      request_entity_id: 'req-4',
      request_revision: '1',
    }),
    request({ request_index: 0 }),
    request({ request_index: 1, kind: 'fyi', request_entity_id: 'req-2' }),
    request({
      request_index: 2,
      addressed_to_me: false,
      request_entity_id: 'req-3',
    }),
    request({
      request_index: 3,
      in_quoted_text: true,
      request_entity_id: 'req-5',
    }),
    request({
      request_index: 5,
      request_entity_id: null,
      request_revision: null,
    }),
    request({
      request_index: 6,
      request_entity_id: 'req-7',
      request_revision: null,
    }),
    // 同じ依頼（ID と版が同じ）が重ねて出ても 1 つ。
    request({ request_index: 7 }),
  ]);
  const { drafts, skipped } = mailCandidateDrafts(result, CONTEXT);
  assert.deepEqual(
    drafts.map((d) => [d.candidate_kind, d.request_entity_id, d.title]),
    [
      ['mail_reply', ENTITY, '参加可否の返信：10/7まで（山田さん）'],
      ['mail_deadline', 'req-4', '見積の提出：10/7まで（山田さん）'],
    ],
  );
  assert.deepEqual(skipped, [
    { source: 'request:1', reason: 'not_a_request' },
    { source: 'request:2', reason: 'not_addressed_to_me' },
    { source: 'request:3', reason: 'in_quoted_text' },
    { source: 'request:5', reason: 'entity_unresolved' },
    { source: 'request:6', reason: 'revision_missing' },
    { source: 'request:7', reason: 'duplicate_in_batch' },
  ]);
});

test('a draft carries the structure of the request and nothing of the mail body except the sealed parts', () => {
  const related = {
    group_id: 'a1000000-0000-4000-8000-0000000000aa',
    analysis_revision: 3,
    source_set_hash: 'd'.repeat(64),
    published_generation: 7,
  };
  const { drafts } = mailCandidateDrafts(
    extraction([request({ deadline: instant('2030-10-07T17:00') })], {
      completeness: {
        source_revisions: [{ source_id: 'msg-1', source_revision: 'rev-1' }],
        unread_source_ids: ['att-1'],
        truncated_source_ids: [],
      },
    }),
    { ...CONTEXT, initial_import: true, related_analysis: related },
  );
  assert.equal(drafts.length, 1);
  const draft = drafts[0];
  assert.deepEqual(draft?.key_parts, {
    kind: 'mail_reply',
    source_account_id: ACCOUNT,
    request_entity_id: ENTITY,
    request_revision: '2',
    due: instant('2030-10-07T17:00'),
  });
  assert.equal(draft?.unread_partial, true);
  assert.equal(draft?.initial_import, true);
  assert.deepEqual(draft?.related_analysis, related);
  assert.equal(draft?.source_revision, 'rev-1');
  assert.equal(draft?.received_at, '2030-10-05T01:00:00Z');
  assert.deepEqual(draft?.origins, [
    { source_kind: 'source_item', source_id: 'msg-1' },
  ]);
  assert.equal(draft?.excerpt, '参加可否をご返信ください。');
  // 切り詰めた本文も一部未読として扱う。
  const truncated = mailCandidateDrafts(
    extraction([request()], {
      completeness: {
        source_revisions: [],
        unread_source_ids: [],
        truncated_source_ids: ['msg-1'],
      },
    }),
    CONTEXT,
  );
  assert.equal(truncated.drafts[0]?.unread_partial, true);
  assert.equal(
    mailCandidateDrafts(extraction([request()]), CONTEXT).drafts[0]
      ?.unread_partial,
    false,
  );
});

test('the excerpt is the quote of the summary, falls back to any quote, is squashed and cut at 200 characters', () => {
  const ref = (quote: string) => ({
    source_id: 'msg-1',
    source_revision: 'rev-1',
    quote,
    start: 0,
    end: quote.length,
  });
  const field = (name: 'summary' | 'deadline', quote: string | null) => ({
    field: name,
    status: 'explicit' as const,
    refs: quote === null ? [] : [ref(quote)],
    rule_id: null,
  });
  const excerptOf = (fields: ExtractedRequest['fields']): string | null =>
    mailCandidateDrafts(extraction([request({ fields })]), CONTEXT).drafts[0]
      ?.excerpt ?? null;
  assert.equal(
    excerptOf([
      field('deadline', '10月7日まで'),
      field('summary', '参加可否を\n ご返信ください'),
    ]),
    '参加可否を ご返信ください',
  );
  assert.equal(excerptOf([field('deadline', '10月7日まで')]), '10月7日まで');
  assert.equal(excerptOf([field('summary', null)]), null);
  assert.equal(excerptOf([]), null);
  assert.equal(excerptOf([field('summary', '   ')]), null);
  const cut = excerptOf([field('summary', 'あ'.repeat(300))]);
  assert.equal(cut, `${'あ'.repeat(199)}…`);
  assert.equal([...(cut ?? '')].length, 200);
});

// --- 予定の重複 ---

const event = (
  id: string,
  start: string,
  end: string,
  over: Partial<CalendarOccurrence> = {},
): CalendarOccurrence => ({
  calendar_id: 'cal-a',
  event_id: id,
  ical_uid: `uid-${id}`,
  recurrence_id: null,
  status: 'confirmed',
  response: 'none',
  busy: true,
  time: { kind: 'timed', start, end },
  ...over,
});
const WINDOW = { start: '2030-01-01T00:00:00Z', end: '2031-01-01T00:00:00Z' };
const originOf = (e: { calendar_id: string; event_id: string }): string =>
  `${e.calendar_id}/${e.event_id}`;

test('an overlap draft has a fixed title made from the local time, and no title or attendee of the events', () => {
  const found = findScheduleOverlaps(
    [
      event('a', '2030-10-09T09:00:00Z', '2030-10-09T10:00:00Z'),
      event('b', '2030-10-09T09:30:00Z', '2030-10-09T10:30:00Z'),
      // 日付だけの予定どうし
      event('d1', '', '', {
        time: {
          kind: 'all_day',
          start_date: '2030-10-11',
          end_date: '2030-10-13',
        },
      }),
      event('d2', '', '', {
        time: {
          kind: 'all_day',
          start_date: '2030-10-12',
          end_date: '2030-10-14',
        },
        ical_uid: null,
      }),
    ],
    WINDOW,
    ZONE,
  );
  assert.equal(found.ok, true);
  if (!found.ok) return;
  const { drafts, skipped } = scheduleOverlapDrafts(found.overlaps, {
    zone: ZONE,
    now: '2030-10-09T03:00:00Z',
    initial_import: false,
    originOf,
  });
  assert.deepEqual(skipped, []);
  assert.deepEqual(
    drafts.map((d) => [d.candidate_kind, d.title, d.excerpt, d.received_at]),
    [
      [
        'schedule_overlap',
        '予定の重複：10/9 18:30–19:00',
        null,
        '2030-10-09T03:00:00Z',
      ],
      [
        'schedule_overlap',
        '予定の重複：10/12',
        '同じ予定の写しかどうかを確認できません（重複候補）',
        '2030-10-09T03:00:00Z',
      ],
    ],
  );
  assert.deepEqual(drafts[0]?.deadline, {
    kind: 'instant',
    local_datetime: '2030-10-09T18:30:00',
    zone: ZONE,
    original_text: '予定の重複',
  });
  assert.deepEqual(drafts[1]?.deadline, {
    kind: 'date',
    date: '2030-10-12',
    original_text: '予定の重複',
  });
  assert.deepEqual(drafts[0]?.origins, [
    { source_kind: 'source_item', source_id: 'cal-a/a' },
    { source_kind: 'source_item', source_id: 'cal-a/b' },
  ]);
  assert.deepEqual(drafts[0]?.key_parts, {
    kind: 'schedule_overlap',
    event_refs: ['ical:uid-a#', 'ical:uid-b#'],
    period: {
      kind: 'timed',
      start: '2030-10-09T09:30:00Z',
      end: '2030-10-09T10:00:00Z',
    },
  });
  assert.equal(drafts[0]?.request_entity_id, null);
  // 同じ組・同じ時間帯を重ねて渡しても 1 つ。
  const again = scheduleOverlapDrafts([...found.overlaps, ...found.overlaps], {
    zone: ZONE,
    now: '2030-10-09T03:00:00Z',
    initial_import: false,
    originOf,
  });
  assert.equal(again.drafts.length, 2);
  assert.equal(again.skipped.length, 2);
  assert.ok(again.skipped.every((s) => s.reason === 'duplicate_in_batch'));
});

// --- 保存（実際の DB の候補の保存と結ぶ） ---

function withStore(
  body: (
    db: SqliteDatabase,
    ports: CandidatePersistPorts,
    ops: CandidateOp[],
  ) => Promise<void> | void,
): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-candidate-intake-'));
  const db = openWriteConnection(join(dir, 'buddy.sqlite'), {
    platform: 'macos',
  });
  const ops: CandidateOp[] = [];
  try {
    applyMigrations(db);
    // 接続（同期の対象が参照する）。
    db.exec(
      "INSERT INTO connections VALUES ('c-1', 'google', NULL, 'keystore:c-1', 'active', 'read_write', '[]', '{}', 1, 1)",
    );
    db.prepare(
      "INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_generation, executor_generation) VALUES ('sc-1', 'c-1', 0, 0, 0)",
    ).run();
    for (const remote of ['msg-1', 'cal-a/a', 'cal-a/b'])
      db.prepare(
        "INSERT INTO source_items (provider, account_id, remote_id, source_revision, scope_id, published_generation, fetched_at, body_blob_id) VALUES ('google', 'acct-1', ?, 'rev-1', 'sc-1', 0, 1000, NULL)",
      ).run(remote);
    db.prepare(
      "INSERT INTO request_entities (request_entity_id, source_account_id, thread_id, origin_message_id, request_revision, state, recreation_suppressed, summary_blob_id, created_at, delete_at) VALUES (?, ?, 'thread-1', 'msg-1', 2, 'active', 0, NULL, 1000, NULL)",
    ).run(ENTITY, ACCOUNT);
    const ports: CandidatePersistPorts = {
      client: {
        candidate: (async (op: CandidateOp) => {
          ops.push(op);
          const out = executeCandidateOp(db, op, {
            platform: 'macos',
            halted: false,
          });
          return out.result;
        }) as never,
      },
      dataKey: KEY,
      sha256Hex,
      newId: randomUUID,
      now: () => '2030-10-05T01:00:05Z',
    };
    return Promise.resolve(body(db, ports, ops)).finally(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
  } catch (error) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

test('saving a draft seals the title and the quote to their own rows and keeps nothing of the body in the clear', async () => {
  await withStore(async (db, ports, ops) => {
    const { drafts } = mailCandidateDrafts(
      extraction([
        request({ deadline: instant('2030-10-07T17:00', '10月7日 17時まで') }),
      ]),
      CONTEXT,
    );
    const saved = await persistCandidateDrafts(ports, drafts);
    assert.equal(saved.length, 1);
    const first = saved[0];
    assert.equal(first?.outcome, 'created');
    if (first?.outcome !== 'created') return;
    // 識別子は手で書いた材料の SHA-256（別に計算した値）。
    assert.equal(
      first.notification_key,
      createHash('sha256')
        .update(
          [
            'buddy.notification-key.v1',
            'kind=mail_reply',
            `source_account_id=${ACCOUNT}`,
            `request_entity_id=${ENTITY}`,
            'request_revision=2',
            'due=instant:2030-10-07T17:00:00@Asia/Tokyo',
          ].join('\n'),
        )
        .digest('hex'),
    );
    const row = db
      .prepare('SELECT * FROM notification_candidates WHERE candidate_id = ?')
      .get(first.candidate_id) as Record<string, unknown>;
    assert.equal(row['kind'], 'mail_reply');
    assert.equal(row['state'], 'new');
    assert.equal(row['request_entity_id'], ENTITY);
    assert.equal(row['request_revision'], 2);
    assert.equal(row['deadline_kind'], 'instant');
    assert.equal(row['deadline_local'], '2030-10-07T17:00');
    assert.equal(row['received_at'], Date.parse('2030-10-05T01:00:00Z'));
    assert.equal(row['created_at'], Date.parse('2030-10-05T01:00:05Z'));
    // 封筒を、候補の所有者・用途で開ける。題と期限の原文は JSON、抄録は引用。
    const blobs = db
      .prepare(
        "SELECT purpose, format_version, key_id, nonce, ciphertext, tag FROM sealed_blobs WHERE owner_table = 'notification_candidates' AND owner_id = ? ORDER BY purpose",
      )
      .all(first.candidate_id) as {
      purpose: 'candidate_excerpt' | 'candidate_title';
      format_version: number;
      key_id: string;
      nonce: Buffer;
      ciphertext: Buffer;
      tag: Buffer;
    }[];
    assert.deepEqual(
      blobs.map((b) => b.purpose),
      ['candidate_excerpt', 'candidate_title'],
    );
    const open = (
      index: number,
      purpose: 'candidate_excerpt' | 'candidate_title',
      ownerId = first.candidate_id,
    ) => {
      const blob = blobs[index];
      assert.ok(blob);
      return openBlob(
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
          ownerId,
          ownerVersion: 0,
          purpose,
        },
      );
    };
    const title = open(1, 'candidate_title');
    assert.equal(title.ok, true);
    assert.deepEqual(
      JSON.parse(title.ok ? title.plaintext.toString('utf8') : '{}'),
      {
        title: '参加可否の返信：10/7 17:00まで（山田さん）',
        deadline_original_text: '10月7日 17時まで',
      },
    );
    const excerpt = open(0, 'candidate_excerpt');
    assert.equal(
      excerpt.ok ? excerpt.plaintext.toString('utf8') : null,
      '参加可否をご返信ください。',
    );
    // 別の候補・別の用途に付け替えた封筒は開けない。
    assert.equal(open(1, 'candidate_excerpt').ok, false);
    assert.equal(open(1, 'candidate_title', randomUUID()).ok, false);
    // 暗号文にも列にも、題・期限の原文・引用が平文で残らない。
    const dump = JSON.stringify(
      db.prepare('SELECT * FROM notification_candidates').all(),
    );
    for (const text of ['参加可否', '10月7日', '山田', 'ご返信'])
      assert.equal(dump.includes(text), false, text);
    for (const blob of blobs)
      assert.equal(
        blob.ciphertext.toString('utf8').includes('参加可否'),
        false,
      );
    // 渡した命令は 1 件で、題・抄録の封筒を 1 つずつ持つ。
    assert.equal(ops.length, 1);
  });
});

test('the same extraction saved again, or through a reconnect, creates no second candidate', async () => {
  await withStore(async (db, ports) => {
    const { drafts } = mailCandidateDrafts(extraction([request()]), CONTEXT);
    const first = await persistCandidateDrafts(ports, drafts);
    const second = await persistCandidateDrafts(ports, drafts);
    assert.equal(first[0]?.outcome, 'created');
    assert.equal(second[0]?.outcome, 'duplicate');
    assert.equal(
      second[0]?.outcome === 'duplicate' && first[0]?.outcome === 'created'
        ? second[0].candidate_id === first[0].candidate_id
        : false,
      true,
    );
    assert.equal(
      (
        db
          .prepare('SELECT count(*) AS n FROM notification_candidates')
          .get() as { n: number }
      ).n,
      1,
    );
    // 封筒も増えない（作らなかった候補の封筒を残さない）。
    assert.equal(
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM sealed_blobs WHERE owner_table = 'notification_candidates'",
          )
          .get() as { n: number }
      ).n,
      2,
    );
    // 却下した後の再同期でも作らない（識別子が残る間）。
    const id = first[0]?.outcome === 'created' ? first[0].candidate_id : '';
    const ops: CandidateOp[] = [
      {
        kind: 'candidate.transition',
        input: {
          candidate_id: id,
          event: 'dismiss',
          expected_state: 'new',
          zone: ZONE,
          snooze_until: null,
          now: '2030-10-05T02:00:00Z',
        },
      },
    ];
    for (const op of ops)
      assert.equal((await ports.client.candidate(op)).ok, true);
    const third = await persistCandidateDrafts(ports, drafts);
    assert.deepEqual(third[0], {
      outcome: 'duplicate',
      candidate_id: id,
      notification_key:
        third[0]?.outcome === 'duplicate' ? third[0].notification_key : '',
      state: 'dismissed',
    });
    // 依頼の版が上がる（期限の訂正）と別の識別子で、新しい候補になる。
    const revised = mailCandidateDrafts(
      extraction([
        request({ request_revision: '3', deadline: dateOnly('2030-10-08') }),
      ]),
      CONTEXT,
    );
    const fourth = await persistCandidateDrafts(ports, revised.drafts);
    assert.equal(fourth[0]?.outcome, 'created');
  });
});

test('a draft that cannot be saved is reported and does not stop the others', async () => {
  await withStore(async (db, ports) => {
    const good = mailCandidateDrafts(extraction([request()]), CONTEXT)
      .drafts[0];
    assert.ok(good);
    // 元情報が忘却・期限切れで無い、識別子の材料が不正、封をできない鍵。
    const gone = {
      ...good,
      origins: [
        { source_kind: 'source_item' as const, source_id: 'forgotten-msg' },
      ],
    };
    const badKey = {
      ...good,
      key_parts: {
        ...good.key_parts,
        request_entity_id: 'req 1',
      } as typeof good.key_parts,
    };
    const results = await persistCandidateDrafts(ports, [gone, badKey, good]);
    assert.deepEqual(
      results.map((r) => r.outcome),
      ['rejected', 'rejected', 'created'],
    );
    assert.deepEqual(results[0], {
      outcome: 'rejected',
      index: 0,
      reasons: ['origin_not_found'],
    });
    assert.deepEqual(results[1], {
      outcome: 'rejected',
      index: 1,
      reasons: ['key_invalid'],
    });
    const unsealable = await persistCandidateDrafts(
      { ...ports, dataKey: { keyId: 'k-test', key: randomBytes(16) } },
      [good],
    );
    assert.deepEqual(unsealable, [
      { outcome: 'rejected', index: 0, reasons: ['seal_failed'] },
    ]);
    // 書けたのは 1 件だけ。失敗した分の封筒を残さない。
    assert.equal(
      (
        db
          .prepare('SELECT count(*) AS n FROM notification_candidates')
          .get() as { n: number }
      ).n,
      1,
    );
    assert.equal(
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM sealed_blobs WHERE owner_table = 'notification_candidates'",
          )
          .get() as { n: number }
      ).n,
      2,
    );
  });
});

test('overlap drafts are saved with one lineage edge per event and the same overlap is not saved twice', async () => {
  await withStore(async (db, ports) => {
    const found = findScheduleOverlaps(
      [
        event('a', '2030-10-09T09:00:00Z', '2030-10-09T10:00:00Z'),
        event('b', '2030-10-09T09:30:00Z', '2030-10-09T10:30:00Z'),
      ],
      WINDOW,
      ZONE,
    );
    assert.equal(found.ok, true);
    if (!found.ok) return;
    const { drafts } = scheduleOverlapDrafts(found.overlaps, {
      zone: ZONE,
      now: '2030-10-09T03:00:00Z',
      initial_import: false,
      originOf,
    });
    const first = await persistCandidateDrafts(ports, drafts);
    assert.equal(first[0]?.outcome, 'created');
    assert.equal(
      (await persistCandidateDrafts(ports, drafts))[0]?.outcome,
      'duplicate',
    );
    const edges = db
      .prepare(
        "SELECT source_id FROM derivations WHERE artifact_kind = 'notification_candidate' ORDER BY source_id",
      )
      .all();
    assert.deepEqual(edges, [
      { source_id: 'cal-a/a' },
      { source_id: 'cal-a/b' },
    ]);
    // 一覧で題を封筒のまま返す（復号は Core）。
    const list = (await ports.client.candidate({
      kind: 'candidate.list',
      limit: 10,
    })) as {
      ok: true;
      value: CandidateOpValues['candidate.list'];
    };
    assert.equal(list.value.candidates.length, 1);
    assert.equal(list.value.candidates[0]?.candidate_kind, 'schedule_overlap');
    assert.deepEqual(list.value.candidates[0]?.deadline, {
      kind: 'instant',
      local_datetime: '2030-10-09T18:30:00',
      zone: ZONE,
    });
  });
});

test('two occurrences of one recurring event that overlap are saved with a single lineage edge', async () => {
  await withStore(async (db, ports) => {
    // 同じカレンダー・同じ予定の ID で、繰り返しの回（recurrence_id）が違う 2 つが重なる。由来は元の予定 1 つ。
    const found = findScheduleOverlaps(
      [
        event('a', '2030-10-09T09:00:00Z', '2030-10-09T10:00:00Z', {
          ical_uid: 'uid-series',
          recurrence_id: '2030-10-09T09:00:00Z',
        }),
        event('a', '2030-10-09T09:30:00Z', '2030-10-09T10:30:00Z', {
          ical_uid: 'uid-series',
          recurrence_id: '2030-10-10T09:00:00Z',
          calendar_id: 'cal-a',
        }),
      ],
      WINDOW,
      ZONE,
    );
    assert.equal(found.ok, true);
    if (!found.ok) return;
    assert.equal(found.overlaps.length, 1);
    const { drafts } = scheduleOverlapDrafts(found.overlaps, {
      zone: ZONE,
      now: '2030-10-09T03:00:00Z',
      initial_import: false,
      originOf,
    });
    assert.deepEqual(drafts[0]?.origins, [
      { source_kind: 'source_item', source_id: 'cal-a/a' },
    ]);
    const saved = await persistCandidateDrafts(ports, drafts);
    assert.equal(saved[0]?.outcome, 'created');
    assert.deepEqual(
      db
        .prepare(
          "SELECT source_id FROM derivations WHERE artifact_kind = 'notification_candidate'",
        )
        .all(),
      [{ source_id: 'cal-a/a' }],
    );
  });
});
