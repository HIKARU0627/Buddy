// 気づき（候補）の一覧を開くたびの状態の見直し（B11-05 P1、ADR 0132）。期待値は手で書く。
// 一覧の前に保守が走ること、zone が null・時計が確かめられないときは回らないこと、保守の失敗で一覧が止まらないこと、
// 同時の要求が 1 回の保守にまとまることを確かめる。保守は差し替え（実際の DB の保守は candidate-maintenance.test.ts）。
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiHandlerRequest, ApiRouteHandler } from './api-server.js';
import { createCandidateListRefresh } from './candidate-list-refresh.js';
import type { CandidateListRefreshOptions } from './candidate-list-refresh.js';
import type {
  CandidateMaintenancePorts,
  MaintenanceReport,
} from './candidate-maintenance.js';

const NOW = '2030-10-09T03:00:00.000Z';

const emptyReport = (
  over: Partial<MaintenanceReport> = {},
): MaintenanceReport => ({
  deadline_passed: [],
  snooze_elapsed: [],
  evidence_resolved: [],
  evidence_standing: [],
  purge_requested: [],
  swept: { content_deleted: [], deleted: [] },
  skipped: [],
  truncated: false,
  resume_after: null,
  ...over,
});

const request = {} as ApiHandlerRequest;

interface Harness {
  readonly events: string[];
  readonly logs: string[];
  readonly ports: CandidateMaintenancePorts[];
  readonly list: ApiRouteHandler;
}

function harness(): Harness {
  const events: string[] = [];
  return {
    events,
    logs: [],
    ports: [],
    list: async () => {
      events.push('list');
      return { status: 200, body: { candidates: [] } };
    },
  };
}

function build(
  h: Harness,
  over: Partial<CandidateListRefreshOptions> = {},
): ReturnType<typeof createCandidateListRefresh> {
  return createCandidateListRefresh({
    client: { candidate: async () => ({ ok: false, reasons: ['unused'] }) },
    zone: () => 'Asia/Tokyo',
    clock: async () => ({ ok: true, now: NOW }),
    log: (message) => h.logs.push(message),
    maintain: async (ports) => {
      h.events.push('maintain');
      h.ports.push(ports);
      return emptyReport();
    },
    ...over,
  } as CandidateListRefreshOptions);
}

test('一覧の前に保守が 1 回走り、確かめた時刻と本人のタイムゾーンを渡す（根拠の再確認は渡さない）', async () => {
  const h = harness();
  const refresh = build(h);
  const result = await refresh.wrap(h.list)(request);
  assert.deepEqual(result, { status: 200, body: { candidates: [] } });
  assert.deepEqual(h.events, ['maintain', 'list']);
  assert.equal(h.ports.length, 1);
  assert.equal(h.ports[0]?.zone, 'Asia/Tokyo');
  assert.equal(h.ports[0]?.now(), NOW);
  assert.equal(h.ports[0]?.checkEvidence, undefined);
  assert.deepEqual(h.logs, []);
});

test('zone が null のときは保守を回さず、一覧の処理へそのまま渡す', async () => {
  const h = harness();
  let clockCalls = 0;
  const refresh = build(h, {
    zone: () => null,
    clock: async () => {
      clockCalls += 1;
      return { ok: true, now: NOW };
    },
  });
  await refresh.wrap(h.list)(request);
  assert.deepEqual(h.events, ['list']);
  assert.equal(clockCalls, 0);
  assert.deepEqual(await refresh.refresh(), {
    kind: 'skipped',
    reason: 'zone_unavailable',
  });
});

test('zone の読み取りが例外でも保守を回さず一覧を返す', async () => {
  const h = harness();
  const refresh = build(h, {
    zone: () => {
      throw new Error('tz');
    },
  });
  const result = await refresh.wrap(h.list)(request);
  assert.equal(result.status, 200);
  assert.deepEqual(h.events, ['list']);
});

test('時計が確かめられない（巻き戻り）ときは保守を保留し、理由のコードだけを記録して一覧を返す', async () => {
  const h = harness();
  const refresh = build(h, {
    clock: async () => ({ ok: false, reason: 'clock_regression' }),
  });
  const result = await refresh.wrap(h.list)(request);
  assert.equal(result.status, 200);
  assert.deepEqual(h.events, ['list']);
  assert.deepEqual(h.logs, ['candidate_refresh_skipped:clock_regression']);
});

test('時計の読み取りが例外のときも保守を回さず一覧を返す', async () => {
  const h = harness();
  const refresh = build(h, {
    clock: async () => {
      throw new Error('clock');
    },
  });
  await refresh.wrap(h.list)(request);
  assert.deepEqual(h.events, ['list']);
  assert.deepEqual(h.logs, ['candidate_refresh_skipped:clock_unreadable']);
});

test('保守が失敗しても一覧は止まらない（ログに題・ID を出さない）', async () => {
  const h = harness();
  const refresh = build(h, {
    maintain: async () => {
      h.events.push('maintain');
      throw new Error('cand-secret-id 題: 秘密');
    },
  });
  const result = await refresh.wrap(h.list)(request);
  assert.deepEqual(result, { status: 200, body: { candidates: [] } });
  assert.deepEqual(h.events, ['maintain', 'list']);
  assert.deepEqual(h.logs, ['candidate_refresh_skipped:maintenance_failed']);
});

test('保守が一部を書かなかったときは段階と理由のコードだけを記録し、一覧を返す', async () => {
  const h = harness();
  const refresh = build(h, {
    maintain: async () =>
      emptyReport({
        skipped: [
          {
            candidate_id: 'c1000000-0000-4000-8000-000000000001',
            step: 'due',
            reasons: ['state_mismatch'],
          },
          {
            candidate_id: 'c1000000-0000-4000-8000-000000000002',
            step: 'due',
            reasons: ['state_mismatch'],
          },
          { candidate_id: null, step: 'sweep', reasons: ['b', 'a'] },
        ],
      }),
  });
  const result = await refresh.wrap(h.list)(request);
  assert.equal(result.status, 200);
  assert.deepEqual(h.logs, [
    'candidate_refresh_partial:due:state_mismatch,sweep:a+b',
  ]);
});

test('同時に来た一覧の要求は、進行中の 1 回の保守を待って相乗りする', async () => {
  const h = harness();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const refresh = build(h, {
    maintain: async () => {
      calls += 1;
      await gate;
      return emptyReport();
    },
  });
  const wrapped = refresh.wrap(h.list);
  const first = wrapped(request);
  const second = wrapped(request);
  await Promise.resolve();
  assert.deepEqual(h.events, []);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(h.events, ['list', 'list']);
  // 済んだ後の次の要求は、新しく 1 回回す。
  await wrapped(request);
  assert.equal(calls, 2);
});

test('一覧の処理の失敗応答（503）はそのまま返す', async () => {
  const h = harness();
  const refresh = build(h, {
    zone: () => null,
  });
  const result = await refresh.wrap(async () => ({
    status: 503,
    body: { error: 'dependency_unavailable' },
  }))(request);
  assert.deepEqual(result, {
    status: 503,
    body: { error: 'dependency_unavailable' },
  });
});

test('根拠の再確認は渡されたときだけ、前の再確認を始めてから 15 分空いた回に保守へ渡す（ADR 0201、U681）', async () => {
  const h = harness();
  let now = NOW;
  const checkEvidence = async () => 'available' as const;
  const refresh = build(h, {
    clock: async () => ({ ok: true, now }),
    checkEvidence,
  });
  const passed = (): (boolean | undefined)[] =>
    h.ports.map((ports) => ports.checkEvidence === checkEvidence);
  await refresh.refresh();
  // 14 分 59 秒後は渡さない（時間による遷移と掃除だけ）。
  now = '2030-10-09T03:14:59.000Z';
  await refresh.refresh();
  // 15 分ちょうどで渡す。
  now = '2030-10-09T03:15:00.000Z';
  await refresh.refresh();
  // 時計が前の再確認より前に戻っても渡さない。
  now = '2030-10-09T03:10:00.000Z';
  await refresh.refresh();
  assert.deepEqual(passed(), [true, false, true, false]);
  // 間隔を指定できる（0 なら毎回）。
  const every = harness();
  const always = build(every, { checkEvidence, evidenceIntervalMs: 0 });
  await always.refresh();
  await always.refresh();
  assert.deepEqual(
    every.ports.map((ports) => ports.checkEvidence === checkEvidence),
    [true, true],
  );
});
