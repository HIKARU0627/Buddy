import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FETCH_SCOPE_LIMITS,
  validateFetchScope,
} from '../packages/domain/dist/index.js';
import { loadContracts } from './contract-tools.mjs';

// B08-02 の取得対象の契約（ADR 0086・0087、U204）。形式の全体は contracts:check が確かめる。
// ここでは、契約の上下限が domain の上限と同じであること、境界の値が契約と domain で同じ結論になること、
// 上限を超える・欠ける・余計な項目を契約が拒否することを確かめる。期待値は手で書く。
const { validators, schema } = await loadContracts();
const targetsSchema = schema.$defs.ConnectionTargets;

const targets = (over = {}) => ({
  calendar_ids: ['primary'],
  mail_container_ids: ['INBOX'],
  attachment_kinds: ['pdf', 'text'],
  mail_lookback_days: 90,
  calendar_past_days: 30,
  calendar_future_days: 90,
  attachment_max_bytes: 10000000,
  ...over,
});

const request = (t) => ({
  request_id: '00000000-0000-4000-8000-000000009001',
  command_scope_id: '00000000-0000-4000-8000-000000009002',
  expected_permission_revision: '2',
  targets: t,
});

// 契約の項目名と domain の項目名の対応（手で書く）。
const FIELDS = [
  ['mail_lookback_days', 'mailLookbackDays', 1, 90],
  ['calendar_past_days', 'calendarPastDays', 0, 30],
  ['calendar_future_days', 'calendarFutureDays', 0, 90],
  ['attachment_max_bytes', 'attachmentMaxBytes', 1, 10000000],
];

test('the schema bounds are the design limits and all four fields are required', () => {
  for (const [wire, , min, max] of FIELDS) {
    const property = targetsSchema.properties[wire];
    assert.equal(property.type, 'integer', wire);
    assert.equal(property.minimum, min, wire);
    assert.equal(property.maximum, max, wire);
    assert(targetsSchema.required.includes(wire), wire);
  }
  assert.equal(targetsSchema.additionalProperties, false);
});

test('the schema maxima equal the domain limits', () => {
  for (const [wire, domain, , max] of FIELDS) {
    assert.equal(targetsSchema.properties[wire].maximum, max, wire);
    assert.equal(FETCH_SCOPE_LIMITS[domain], max, domain);
  }
});

test('the initial values and the edges are accepted by the schema and by domain', () => {
  const toDomain = (t) => ({
    calendarIds: t.calendar_ids,
    mailContainerIds: t.mail_container_ids,
    attachmentKinds: t.attachment_kinds,
    mailLookbackDays: t.mail_lookback_days,
    calendarPastDays: t.calendar_past_days,
    calendarFutureDays: t.calendar_future_days,
    attachmentMaxBytes: t.attachment_max_bytes,
  });
  const accepted = [
    targets(),
    targets({
      mail_lookback_days: 1,
      calendar_past_days: 0,
      calendar_future_days: 0,
      attachment_max_bytes: 1,
    }),
    targets({ attachment_kinds: [], calendar_ids: [], mail_container_ids: [] }),
  ];
  for (const t of accepted) {
    assert(validators['ConnectionTargets'](t), JSON.stringify(t));
    assert(validators['ConnectionTargetsRequest'](request(t)));
    assert.deepEqual(validateFetchScope(toDomain(t)), []);
  }
  // 境界の外は、契約も domain も拒否する。
  const rejected = [
    { mail_lookback_days: 0 },
    { mail_lookback_days: 91 },
    { calendar_past_days: -1 },
    { calendar_past_days: 31 },
    { calendar_future_days: -1 },
    { calendar_future_days: 91 },
    { attachment_max_bytes: 0 },
    { attachment_max_bytes: 10000001 },
  ];
  for (const over of rejected) {
    const t = targets(over);
    assert(!validators['ConnectionTargets'](t), JSON.stringify(over));
    assert.notDeepEqual(
      validateFetchScope(toDomain(t)),
      [],
      JSON.stringify(over),
    );
  }
});

test('the schema rejects fractions, strings, missing fields and extra fields', () => {
  const bad = [
    targets({ mail_lookback_days: 1.5 }),
    targets({ calendar_past_days: '30' }),
    targets({ attachment_max_bytes: null }),
    targets({ unlimited: true }),
  ];
  for (const t of bad)
    assert(!validators['ConnectionTargets'](t), JSON.stringify(t));
  for (const [wire] of FIELDS) {
    const t = targets();
    delete t[wire];
    // 既定値で補わない。欠けた項目は拒否する。
    assert(!validators['ConnectionTargets'](t), `missing ${wire}`);
    assert(
      !validators['ConnectionTargetsRequest'](request(t)),
      `missing ${wire}`,
    );
  }
});
