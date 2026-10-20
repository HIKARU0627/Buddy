import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import {
  approvalDecision,
  commandGuard,
  deleteAt,
  deliveryAfterAck,
  deliveryDecision,
  turnRetentionRule,
} from '../packages/domain/dist/index.js';
import { parseStrictJson, root } from './contract-tools.mjs';

// ビルド後の domain の承認・命令・通知・削除期限を、手書きの期待値（fixtures）で検査する。
const spec = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/boundary-cases.json', root),
    'utf8',
  ),
);

test('approvals record once per content version and never move to new content', () => {
  const { operation, attempt, cases } = spec.approval;
  for (const entry of cases)
    assert.deepEqual(
      approvalDecision(
        { ...operation, ...entry.operation },
        { ...attempt, ...entry.attempt },
      ),
      entry.expected,
      entry.id,
    );
});

test('DB commands re-check every version and replay a lost acknowledgement', () => {
  const { command, current, cases } = spec.command;
  for (const entry of cases)
    assert.deepEqual(
      commandGuard(
        command,
        { ...current, ...entry.current },
        {
          external: entry.external,
        },
      ),
      entry.expected,
      entry.id,
    );
});

test('alerts are not re-shown on refetch, reconnect, device move or lost acknowledgement', () => {
  const { existing, cases, ack } = spec.delivery;
  for (const entry of cases)
    assert.deepEqual(
      deliveryDecision(existing, entry.request),
      entry.expected,
      entry.id,
    );
  for (const entry of ack)
    assert.equal(
      deliveryAfterAck(entry.record, entry.ack).status,
      entry.expected,
    );
});

test('deadlines are computed once from their anchor', () => {
  for (const entry of spec.retention)
    assert.equal(
      deleteAt(entry.rule, entry.anchor),
      entry.expected,
      entry.rule,
    );
  for (const entry of spec.turn_rules)
    assert.equal(turnRetentionRule(entry.storage_mode), entry.expected);
  assert.throws(() => deleteAt('unknown', '2030-10-01T00:00:00Z'));
});

// contracts / domain の配布物に Electron・DOM・Node 専用 API を入れない（lint の依存方向検査に加えた素朴な検査）。
test('contracts and domain sources use no Electron, DOM or Node-only API', async () => {
  const forbidden = [
    /from ['"](?:node:|electron|fs|path|os|crypto|child_process|worker_threads)/u,
    /\brequire\(/u,
    /\b(?:window|document|navigator|localStorage|process|Buffer|__dirname)\b/u,
  ];
  for (const pkg of ['contracts', 'domain']) {
    const dir = new URL(`packages/${pkg}/src/`, root);
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.ts')) continue;
      const source = (await readFile(new URL(name, dir), 'utf8'))
        .split('\n')
        .filter(
          (line) =>
            !line.trimStart().startsWith('//') &&
            !line.trimStart().startsWith('*'),
        )
        .join('\n');
      for (const pattern of forbidden)
        assert(!pattern.test(source), `${pkg}/${name} matches ${pattern}`);
    }
  }
  for (const pkg of ['contracts', 'domain']) {
    const config = parseStrictJson(
      await readFile(new URL(`packages/${pkg}/tsconfig.json`, root), 'utf8'),
    );
    assert.equal(config.compilerOptions.types, undefined, pkg);
    assert.equal(config.compilerOptions.lib, undefined, pkg);
  }
  const base = parseStrictJson(
    await readFile(new URL('tsconfig.base.json', root), 'utf8'),
  );
  assert.deepEqual(base.compilerOptions.lib, ['ES2023']);
  assert.deepEqual(base.compilerOptions.types, []);
});
