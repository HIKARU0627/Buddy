import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CONCURRENT_WAKE_WINDOW_MS,
  CORE_LEASE_TTL_MAX_MS,
  LEASE_MAX_ACCEPTED_NONCES,
  arbitrateAudioClaim,
  grantedLeaseTtlMs,
  ioStopReach,
  leaseRotationRequired,
} from '../packages/domain/dist/index.js';
import { parseStrictJson, root } from './contract-tools.mjs';

// B05-03（ADR 0046）の音声所有権・リースの期限・取り直し・停止の到達の規則を、手書きの期待値で検査する。
// 期待値は domain の実装から作らない。時刻は合成値で、実際の音声・実機は使わない。
const cases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/voice-ownership-cases.json', root),
    'utf8',
  ),
);

test('設計初期値と原本に決めなしの上限を手で固定する', () => {
  assert.equal(CONCURRENT_WAKE_WINDOW_MS, 300);
  assert.equal(CORE_LEASE_TTL_MAX_MS, 6000);
  assert.equal(LEASE_MAX_ACCEPTED_NONCES, 1800);
});

for (const item of cases.claim_cases)
  test(`音声所有権の調停: ${item.id}`, () => {
    assert.deepEqual(
      arbitrateAudioClaim(item.owner, item.claim, item.display_target),
      item.expected,
    );
  });

test('音声所有権の調停: 窓の前後 1 ms（299・300・301）と表示先の有無の全部の組', () => {
  const owner = { device_id: 'A', granted_at_mono_ms: 0, valid: true };
  // 手で書いた表: [経過, 表示先, 期待する判定]
  const table = [
    [299, null, 'reject'],
    [300, null, 'reject'],
    [301, null, 'takeover'],
    [299, 'B', 'display_target_priority'],
    [300, 'B', 'display_target_priority'],
    [301, 'B', 'takeover'],
    [299, 'A', 'reject'],
    [301, 'A', 'takeover'],
  ];
  for (const [elapsed, target, expected] of table) {
    const result = arbitrateAudioClaim(
      owner,
      { device_id: 'B', at_mono_ms: elapsed },
      target,
    );
    const got = result.decision === 'reject' ? 'reject' : result.why;
    assert.equal(got, expected, `${elapsed} ${target}`);
  }
});

test('音声所有権の調停: 時計を比べられないときは閉じない（NaN・Infinity）', () => {
  for (const at of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(
      arbitrateAudioClaim(
        { device_id: 'A', granted_at_mono_ms: 0, valid: true },
        { device_id: 'B', at_mono_ms: at },
        'B',
      ),
      { decision: 'reject', code: 'audio_owned_elsewhere' },
    );
  }
});

for (const item of cases.ttl_cases)
  test(`中枢が返すリースの期限: ${item.id}`, () => {
    assert.equal(grantedLeaseTtlMs(item.requested), item.expected);
  });

for (const item of cases.rotation_cases)
  test(`リースの取り直し: ${item.id}`, () => {
    const stored =
      item.accepted_nonces === null
        ? null
        : {
            lease_id: 'lease',
            kind: 'audio',
            device_id: 'A',
            used_nonces: Array.from(
              { length: item.accepted_nonces },
              (_, index) => `n${index}`,
            ),
            last_requested_at_mono_ms: 1,
          };
    assert.equal(leaseRotationRequired(stored), item.expected);
  });

for (const item of cases.reach_cases)
  test(`停止の到達: ${item.id}`, () => {
    assert.deepEqual(
      ioStopReach(item.targets, item.now_mono_ms),
      item.expected,
    );
  });

test('停止の到達: 時計を比べられないときは失効と言わない', () => {
  assert.deepEqual(
    ioStopReach(
      [{ device_id: 'B', requester: false, lease_expires_at_mono_ms: 1 }],
      Number.NaN,
    ),
    {
      devices: [{ device_id: 'B', stop_state: 'awaiting_ack' }],
      all_confirmed: false,
    },
  );
  assert.deepEqual(ioStopReach([], 0), { devices: [], all_confirmed: false });
});
