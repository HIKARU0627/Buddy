// メールの抽出の結果からの気づき（候補）の取り込みの入口（B11-04、ADR 0194）。期待値は手で書く。
// 実際の DB の候補の保存と結び、抽出できなかったメール・記録しない会話・区切りの変化で作らないことと、再同期で二重に
// 作らないことを見る。
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ExtractedRequest, ExtractionResult } from '@buddy/contracts';
import type { PrefilterRecord } from '@buddy/domain';
import {
  applyMigrations,
  executeCandidateOp,
  openWriteConnection,
} from '@buddy/storage';
import type {
  CandidateOp,
  DataKeyMaterial,
  SqliteDatabase,
} from '@buddy/storage';
import { intakeMailExtraction } from './mail-candidate-intake.js';
import type {
  MailCandidateIntakePorts,
  StorageSegment,
} from './mail-candidate-intake.js';
import type { MailExtractionOutcome } from './mail-extraction.js';

const KEY: DataKeyMaterial = { keyId: 'k-test', key: randomBytes(32) };
const ACCOUNT = 'a2000000-0000-4000-8000-000000000001';
const ENTITY = 'b1000000-0000-4000-8000-000000000001';
const SEGMENT: StorageSegment = {
  segment_id: 'seg-1',
  segment_generation: '3',
};

const RECORD: PrefilterRecord = {
  source_account_id: ACCOUNT,
  message_id: 'msg-1',
  source_revision: 'rev-1',
  decision: 'analyzed',
  reasons: [],
  rule_id: null,
  decided_at: '2030-10-05T01:00:00Z',
};

function request(over: Partial<ExtractedRequest> = {}): ExtractedRequest {
  return {
    request_index: 0,
    kind: 'action_required',
    summary: '資料の提出',
    deadline: { kind: 'date', date: '2030-10-07', original_text: '7日まで' },
    fields: [],
    in_quoted_text: false,
    confidence_observed: 'high',
    addressed_to_me: true,
    from_automated_sender: false,
    request_entity_id: ENTITY,
    request_revision: '1',
    ...over,
  };
}

function extracted(requests: ExtractedRequest[]): MailExtractionOutcome {
  const result: ExtractionResult = {
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
  };
  return {
    status: 'extraction',
    record: RECORD,
    extraction: {
      status: 'extracted',
      result,
      diagnostics: {} as never,
      usage: {} as never,
    },
  };
}

const CONTEXT = {
  zone: 'Asia/Tokyo',
  received_at: '2030-10-05T01:00:00Z',
  initial_import: false,
  sender_label: '山田さん',
};

async function withPorts(
  body: (
    db: SqliteDatabase,
    ports: MailCandidateIntakePorts,
    state: { private: boolean; segment: StorageSegment },
  ) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-mail-candidate-intake-'));
  const db = openWriteConnection(join(dir, 'buddy.sqlite'), {
    platform: 'macos',
  });
  try {
    applyMigrations(db);
    db.exec(
      "INSERT INTO connections VALUES ('c-1', 'google', NULL, 'keystore:c-1', 'active', 'read', '[]', '{}', 1, 1)",
    );
    db.prepare(
      "INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_generation, executor_generation) VALUES ('sc-1', 'c-1', 1, 1, 0)",
    ).run();
    db.prepare(
      "INSERT INTO source_items (provider, account_id, remote_id, source_revision, scope_id, published_generation, fetched_at, body_blob_id) VALUES ('google', 'acct-1', 'msg-1', 'rev-1', 'sc-1', 1, 1000, NULL)",
    ).run();
    db.prepare(
      "INSERT INTO request_entities (request_entity_id, source_account_id, thread_id, origin_message_id, request_revision, state, recreation_suppressed, summary_blob_id, created_at, delete_at) VALUES (?, ?, 'thread-1', 'msg-1', 1, 'active', 0, NULL, 1000, NULL)",
    ).run(ENTITY, ACCOUNT);
    const state = { private: false, segment: SEGMENT };
    const ports: MailCandidateIntakePorts = {
      client: {
        candidate: ((op: CandidateOp) =>
          Promise.resolve(
            executeCandidateOp(db, op, { platform: 'macos', halted: false })
              .result,
          )) as never,
      },
      dataKey: KEY,
      sha256Hex: (material) =>
        createHash('sha256').update(material).digest('hex'),
      newId: randomUUID,
      now: () => '2030-10-05T01:00:05Z',
      storage: {
        privateConversation: () => state.private,
        origin: () => state.segment,
      },
    };
    await body(db, ports, state);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const count = (db: SqliteDatabase): number =>
  (
    db.prepare('SELECT COUNT(*) AS n FROM notification_candidates').get() as {
      n: number;
    }
  ).n;

test('an extracted request becomes a candidate once, and a resync of the same mail is a duplicate', async () => {
  await withPorts(async (db, ports) => {
    const first = await intakeMailExtraction(ports, {
      outcome: extracted([
        request(),
        request({ request_index: 1, kind: 'fyi' }),
      ]),
      context: CONTEXT,
      started: SEGMENT,
    });
    assert.equal(first.status, 'persisted');
    if (first.status !== 'persisted') return;
    assert.deepEqual(
      first.results.map((r) => r.outcome),
      ['created'],
    );
    assert.deepEqual(first.skipped, [
      { source: 'request:1', reason: 'not_a_request' },
    ]);
    const again = await intakeMailExtraction(ports, {
      outcome: extracted([request()]),
      context: CONTEXT,
      started: SEGMENT,
    });
    assert.equal(again.status, 'persisted');
    if (again.status !== 'persisted') return;
    assert.deepEqual(
      again.results.map((r) => r.outcome),
      ['duplicate'],
    );
    const row = db
      .prepare('SELECT kind, state, deadline_kind FROM notification_candidates')
      .get();
    assert.deepEqual(
      { ...(row as object) },
      { kind: 'mail_deadline', state: 'new', deadline_kind: 'date' },
    );
    assert.equal(count(db), 1);
  });
});

test('nothing is created from a filtered or failed extraction, during a private conversation or after the segment changed', async () => {
  await withPorts(async (db, ports, state) => {
    const filtered = await intakeMailExtraction(ports, {
      outcome: {
        status: 'filtered',
        decision: {
          kind: 'skip_automated',
          rule_id: 'prefilter_automated_no_cue_v1',
        } as never,
        record: RECORD,
      },
      context: CONTEXT,
      started: SEGMENT,
    });
    assert.deepEqual(filtered, { status: 'skipped', reason: 'filtered' });
    const failed = await intakeMailExtraction(ports, {
      outcome: {
        status: 'extraction',
        record: RECORD,
        extraction: {
          status: 'failed',
          failure: 'timeout',
          retryable: true,
          detail: null,
          reasons: [],
          usage: null,
        },
      },
      context: CONTEXT,
      started: SEGMENT,
    });
    assert.deepEqual(failed, { status: 'skipped', reason: 'not_extracted' });
    const notSent = await intakeMailExtraction(ports, {
      outcome: {
        status: 'extraction',
        record: RECORD,
        extraction: { status: 'not_sent', errors: ['nothing_readable'] },
      },
      context: CONTEXT,
      started: SEGMENT,
    });
    assert.deepEqual(notSent, { status: 'skipped', reason: 'not_extracted' });
    state.private = true;
    const inPrivate = await intakeMailExtraction(ports, {
      outcome: extracted([request()]),
      context: CONTEXT,
      started: SEGMENT,
    });
    assert.deepEqual(inPrivate, {
      status: 'skipped',
      reason: 'private_conversation',
    });
    // 記録しない会話を出た後でも、抽出を始めたときの区切りと違えば作らない。
    state.private = false;
    state.segment = { segment_id: 'seg-2', segment_generation: '4' };
    const changed = await intakeMailExtraction(ports, {
      outcome: extracted([request()]),
      context: CONTEXT,
      started: SEGMENT,
    });
    assert.deepEqual(changed, {
      status: 'skipped',
      reason: 'storage_boundary_changed',
    });
    assert.equal(count(db), 0);
  });
});

test('drafts stop as soon as the segment changes between two requests of the same mail', async () => {
  await withPorts(async (db, ports, state) => {
    const second = 'b1000000-0000-4000-8000-000000000002';
    db.prepare(
      "INSERT INTO request_entities (request_entity_id, source_account_id, thread_id, origin_message_id, request_revision, state, recreation_suppressed, summary_blob_id, created_at, delete_at) VALUES (?, ?, 'thread-1', 'msg-1', 1, 'active', 0, NULL, 1000, NULL)",
    ).run(second, ACCOUNT);
    // 1 件目を保存した後に記録しない会話に入る。
    const send = ports.client.candidate as (
      op: CandidateOp,
    ) => Promise<unknown>;
    const result = await intakeMailExtraction(
      {
        ...ports,
        client: {
          candidate: (async (op: CandidateOp) => {
            const out = await send(op);
            state.private = true;
            return out;
          }) as never,
        },
      },
      {
        outcome: extracted([
          request(),
          request({ request_index: 1, request_entity_id: second }),
        ]),
        context: CONTEXT,
        started: SEGMENT,
      },
    );
    assert.equal(result.status, 'persisted');
    if (result.status !== 'persisted') return;
    assert.deepEqual(
      result.results.map((r) => r.outcome),
      ['created', 'held'],
    );
    assert.equal(count(db), 1);
  });
});
