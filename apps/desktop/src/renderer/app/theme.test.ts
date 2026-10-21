// OS の配色への追従の試験（ADR 0024）。HeroUI のテーマは html の class と data-theme で切り替わる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followSystemColorScheme } from './theme.js';

function fakeRoot() {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const root = {
    classList: {
      toggle(name: string, force: boolean) {
        if (force) classes.add(name);
        else classes.delete(name);
        return force;
      },
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
  };
  return { root: root as unknown as Element, classes, attributes };
}

function fakeQuery(matches: boolean) {
  const listeners = new Set<() => void>();
  return {
    matches,
    listeners,
    addEventListener(_type: 'change', listener: () => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: 'change', listener: () => void) {
      listeners.delete(listener);
    },
  };
}

test('the dark OS setting applies the dark theme at start', () => {
  const { root, classes, attributes } = fakeRoot();
  followSystemColorScheme(root, fakeQuery(true));
  assert.deepEqual([...classes], ['dark']);
  assert.equal(attributes.get('data-theme'), 'dark');
});

test('the light OS setting applies the light theme and follows changes until stopped', () => {
  const { root, classes, attributes } = fakeRoot();
  const query = fakeQuery(false);
  const stop = followSystemColorScheme(root, query);
  assert.deepEqual([...classes], ['light']);
  assert.equal(attributes.get('data-theme'), 'light');

  query.matches = true;
  for (const listener of query.listeners) listener();
  assert.deepEqual([...classes], ['dark']);
  assert.equal(attributes.get('data-theme'), 'dark');

  stop();
  assert.equal(query.listeners.size, 0);
});
