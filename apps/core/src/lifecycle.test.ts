import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Lifecycle,
  controlOpDisposition,
  nextLifecycleState,
} from './lifecycle.js';
import type { LifecycleEvent, LifecycleState } from './lifecycle.js';

// 期待値は手書きの表。実装の LIFECYCLE_TRANSITIONS から作らない。
const EXPECTED: ReadonlyArray<
  [LifecycleState, LifecycleEvent, LifecycleState | null]
> = [
  ['starting', 'started', 'running'],
  ['starting', 'stop_requested', 'stopping'],
  ['starting', 'failed', 'stopping'],
  ['starting', 'released', null],
  ['running', 'started', null],
  ['running', 'stop_requested', 'stopping'],
  ['running', 'failed', 'stopping'],
  ['running', 'released', null],
  ['stopping', 'started', null],
  ['stopping', 'stop_requested', null],
  ['stopping', 'failed', null],
  ['stopping', 'released', 'stopped'],
  ['stopped', 'started', null],
  ['stopped', 'stop_requested', null],
  ['stopped', 'failed', null],
  ['stopped', 'released', null],
];

test('lifecycle transitions follow the hand-written table for every state and event', () => {
  for (const [state, event, next] of EXPECTED)
    assert.equal(nextLifecycleState(state, event), next, `${state} + ${event}`);
});

test('control ops: status answers until stopped, stop starts shutdown only once', () => {
  assert.equal(controlOpDisposition('starting', 'status'), 'answer');
  assert.equal(controlOpDisposition('running', 'status'), 'answer');
  assert.equal(controlOpDisposition('stopping', 'status'), 'answer');
  assert.equal(controlOpDisposition('stopped', 'status'), 'unavailable');
  assert.equal(controlOpDisposition('starting', 'stop'), 'begin_stop');
  assert.equal(controlOpDisposition('running', 'stop'), 'begin_stop');
  assert.equal(controlOpDisposition('stopping', 'stop'), 'already_stopping');
  assert.equal(controlOpDisposition('stopped', 'stop'), 'unavailable');
});

test('Lifecycle accepts new work only while running and ignores invalid events', () => {
  const lifecycle = new Lifecycle();
  const seen: LifecycleState[] = [];
  lifecycle.onChange((state) => seen.push(state));
  assert.equal(lifecycle.state, 'starting');
  assert.equal(lifecycle.acceptsNewWork, false);
  assert.equal(lifecycle.apply('released'), false);
  assert.equal(lifecycle.apply('started'), true);
  assert.equal(lifecycle.acceptsNewWork, true);
  assert.equal(lifecycle.apply('stop_requested'), true);
  assert.equal(lifecycle.acceptsNewWork, false);
  // 終了処理中の二度目の停止は遷移にしない。
  assert.equal(lifecycle.apply('stop_requested'), false);
  assert.equal(lifecycle.apply('released'), true);
  assert.equal(lifecycle.state, 'stopped');
  assert.deepEqual(seen, ['running', 'stopping', 'stopped']);
});
