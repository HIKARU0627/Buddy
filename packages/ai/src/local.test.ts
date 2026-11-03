import assert from 'node:assert/strict';
import test from 'node:test';
import { localAdoption } from './local.js';

const record = (
  prefix_cache: boolean,
  p50_ms: number,
  p95_ms: number,
  profile_id = 'local-p0',
) => ({ profile_id, prefix_cache, p50_ms, p95_ms });

test('QA40: a local profile without a prefix-cache measurement is not adopted', () => {
  assert.deepEqual(localAdoption('local-p0', []), {
    decision: 'not_adopted',
    reasons: ['no_measurement'],
  });
  assert.deepEqual(localAdoption('local-p0', [record(false, 120, 300)]), {
    decision: 'not_adopted',
    reasons: ['prefix_cache_missing'],
  });
});

test('QA40: records the cached and uncached latency so the difference is visible', () => {
  assert.deepEqual(
    localAdoption('local-p0', [
      record(true, 80, 150),
      record(false, 120, 300),
      // 同じ条件の複数回は、安全側（最も遅い値）を残す。
      record(true, 90, 170),
    ]),
    {
      decision: 'adopt',
      cached: { prefix_cache: true, p50_ms: 90, p95_ms: 170 },
      uncached: { prefix_cache: false, p50_ms: 120, p95_ms: 300 },
    },
  );
});

test('a cached-only measurement has no baseline for the comparison', () => {
  assert.deepEqual(localAdoption('local-p0', [record(true, 80, 150)]), {
    decision: 'not_adopted',
    reasons: ['cache_baseline_missing'],
  });
});

test('invalid measurements are rejected instead of adopted', () => {
  assert.deepEqual(
    localAdoption('local-p0', [
      record(true, 200, 100),
      record(false, 300, 400),
    ]),
    { decision: 'not_adopted', reasons: ['invalid_measurement'] },
  );
  assert.deepEqual(localAdoption('local-p0', [record(true, -1, 100)]), {
    decision: 'not_adopted',
    reasons: ['invalid_measurement'],
  });
});
