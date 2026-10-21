// event_cursor の符号化と再生の判定（ADR 0023）。期待値は手で書いた値（base64url は Node の Buffer で別に作る）。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EVENT_CURSOR_TTL_MS,
  cursorReplayDecision,
  decodeEventCursor,
  encodeEventCursor,
} from './event-cursor.js';

const GEN = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000bb';
const DAY = 86_400_000;
const T0 = Date.UTC(2030, 9, 5);
const handMade = (body: string) =>
  `ec1_${Buffer.from(body, 'utf8').toString('base64url')}`;

test(
  'the cursor is an opaque ec1_ value that round-trips generation, sequence and issue time',
  { timeout: 10_000 },
  () => {
    assert.equal(EVENT_CURSOR_TTL_MS, 7 * DAY);
    const cursor = encodeEventCursor({
      storeGeneration: GEN,
      sequence: 42,
      issuedAt: T0,
    });
    assert.equal(cursor, handMade(`${GEN}.42.${T0}`));
    assert.deepEqual(decodeEventCursor(cursor), {
      storeGeneration: GEN,
      sequence: 42,
      issuedAt: T0,
    });
    assert.deepEqual(decodeEventCursor(handMade(`${GEN}.0.0`)), {
      storeGeneration: GEN,
      sequence: 0,
      issuedAt: 0,
    });
  },
);

test('malformed cursors are not decoded', { timeout: 10_000 }, () => {
  const bad = [
    '',
    'c-1',
    'opaque-test-cursor',
    'ec1_',
    `ec2_${Buffer.from(`${GEN}.1.1`).toString('base64url')}`,
    handMade(`${GEN}.01.1`),
    handMade(`${GEN}.-1.1`),
    handMade(`${GEN}.1`),
    handMade(`${GEN}.1.1.1`),
    handMade(`not-a-uuid.1.1`),
    handMade(`${GEN.toUpperCase()}.1.1`),
    handMade(`${GEN}.99999999999999999.1`),
    // パディング付き・標準の base64 の文字（+ /）は別の書き方なので受け付けない。
    `${handMade(`${GEN}.1.1`)}=`,
    `ec1_${Buffer.from(`${GEN}.1.1`).toString('base64')}`,
    `ec1_${'A'.repeat(200)}`,
  ];
  for (const cursor of bad)
    assert.equal(decodeEventCursor(cursor), null, cursor);
  // 余りのビットが違う別の書き方（同じバイト列に戻るが、符号化し直すと違う文字列）。
  const canonical = handMade(`${GEN}.1.1`);
  const last = canonical.at(-1) as string;
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const variants = [...alphabet]
    .filter((char) => char !== last)
    .map((char) => canonical.slice(0, -1) + char)
    .filter(
      (variant) =>
        Buffer.from(variant.slice(4), 'base64url').toString('utf8') ===
        `${GEN}.1.1`,
    );
  for (const variant of variants)
    assert.equal(decodeEventCursor(variant), null, variant);
});

test(
  'replay decisions follow generation, 7-day expiry, clock rollback and the retained range',
  { timeout: 10_000 },
  () => {
    const cursor = { storeGeneration: GEN, sequence: 10, issuedAt: T0 };
    const range: {
      storeGeneration: string;
      now: number;
      minSequence: number | null;
      maxSequence: number;
    } = {
      storeGeneration: GEN,
      now: T0 + 1000,
      minSequence: 1,
      maxSequence: 20,
    };
    const cases: [string, Partial<typeof range>, string | null][] = [
      ['ok', {}, null],
      [
        'other generation',
        { storeGeneration: OTHER },
        'store_generation_changed',
      ],
      ['just before 7 days', { now: T0 + 7 * DAY - 1 }, null],
      ['7 days', { now: T0 + 7 * DAY }, 'history_expired'],
      ['clock rolled back', { now: T0 - 1 }, 'history_expired'],
      ['next event retained', { minSequence: 11 }, null],
      ['next event deleted', { minSequence: 12 }, 'history_expired'],
      ['cursor at the end', { maxSequence: 10 }, null],
      ['cursor beyond the end', { maxSequence: 9 }, 'history_expired'],
      [
        'all events deleted',
        { minSequence: null, maxSequence: 0 },
        'history_expired',
      ],
    ];
    for (const [name, change, reason] of cases)
      assert.deepEqual(
        cursorReplayDecision(cursor, { ...range, ...change }),
        reason === null ? { ok: true } : { ok: false, reason },
        name,
      );
    assert.deepEqual(
      cursorReplayDecision(
        { storeGeneration: GEN, sequence: 0, issuedAt: T0 },
        { ...range, minSequence: null, maxSequence: 0 },
      ),
      { ok: true },
      'empty outbox from the start',
    );
  },
);
