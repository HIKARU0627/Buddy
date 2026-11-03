import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CANDIDATE_EVENTS,
  CANDIDATE_STATES,
  candidateRetention,
  candidateTransition,
} from '../packages/domain/dist/index.js';
import { loadContracts, parseStrictJson, root } from './contract-tools.mjs';

// B11-01 の気づき（候補）の状態・保持・一覧・根拠（ADR 0073、設計 11 §4）。
// 形式は contracts:check が確かめる。ここでは状態の遷移と保持の境界を手書きの fixture と照合する。
const { validators, schema } = await loadContracts();
const cases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/candidate-cases.json', root),
    'utf8',
  ),
);

test('candidate states match the snapshot enum', () => {
  assert.deepEqual(
    [...CANDIDATE_STATES],
    schema.$defs.CandidateSnapshot.properties.state.enum,
  );
  assert.deepEqual(
    [...CANDIDATE_EVENTS],
    ['open', 'act', 'dismiss', 'snooze', 'resolve'],
  );
});

test('the hand-written state transitions are kept', () => {
  for (const entry of cases.transitions)
    assert.equal(
      candidateTransition(entry.from, entry.event),
      entry.to,
      entry.id,
    );
});

test('the retention boundaries are active, seven days, then ninety-seven days', () => {
  for (const entry of cases.retention) {
    assert.deepEqual(
      candidateRetention(entry.state, entry.changed_at),
      {
        active: entry.active,
        content_until: entry.content_until,
        identifier_until: entry.identifier_until,
      },
      entry.id,
    );
  }
});

test('the list and evidence never carry a full body or an unapproved field', () => {
  const list = cases.cases.find((entry) => entry.id === 'candidate-list').value;
  assert(validators['CandidateListResponse'](list));
  for (const field of ['body', 'text', 'attachments', 'subjects'])
    assert(
      !validators['CandidateListResponse']({ ...list, [field]: 'forbidden' }),
      field,
    );
  const evidence = cases.cases.find(
    (entry) => entry.id === 'candidate-evidence',
  ).value;
  assert(validators['CandidateEvidence'](evidence));
  assert(
    !validators['CandidateEvidence']({
      ...evidence,
      excerpt: 'a'.repeat(201),
    }),
  );
  assert(!validators['CandidateEvidence']({ ...evidence, body: 'full body' }));
});

test('the notification key parts name the deduplication inputs', () => {
  const mail = cases.notification_key_parts.find(
    (entry) => entry.id === 'mail-reply-key',
  );
  for (const field of [
    'kind',
    'source_account_id',
    'request_entity_id',
    'request_revision',
    'due',
  ])
    assert(mail[field] !== undefined, field);
  const overlap = cases.notification_key_parts.find(
    (entry) => entry.id === 'schedule-overlap-key',
  );
  assert(overlap.event_ids.length >= 2);
  assert.deepEqual(
    [...overlap.event_ids].sort(),
    overlap.event_ids,
    'event ids are sorted so the same overlap has one key',
  );
});
