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

test('一覧の前に保守が 1 回走り、確かめた時刻と本人のタイムゾーンを渡す（根拠の再確認は保守に渡さない）', async () => {
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

// --- 根拠の再確認（後ろで回す。ADR 0201、U681） ---

// 活動中の候補の一覧と遷移だけを持つ模擬の保存（並びは受信の新しい順、続きの位置は最後の行）。
function fakeStore(count: number) {
  const rows = Array.from({ length: count }, (_, index) => ({
    candidate_id: `c1000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    // 受信は新しい順に 1 秒ずつ古くする（index 0 が最新）。
    received_at: 2_000_000_000_000 - index * 1000,
    state: 'new',
  }));
  const transitions: string[] = [];
  const client = {
    candidate: async (op: {
      kind: string;
      limit?: number;
      after?: { received_at: number; candidate_id: string };
      input?: { candidate_id: string; event: string };
    }) => {
      if (op.kind === 'candidate.transition') {
        transitions.push(
          `${op.input?.candidate_id ?? ''}:${op.input?.event ?? ''}`,
        );
        return { ok: true, value: {} };
      }
      const after = op.after;
      const rest = rows.filter(
        (row) =>
          after === undefined ||
          row.received_at < after.received_at ||
          (row.received_at === after.received_at &&
            row.candidate_id > after.candidate_id),
      );
      const limit = op.limit ?? 1000;
      const page = rest.slice(0, limit);
      const last = page[page.length - 1];
      return {
        ok: true,
        value: {
          candidates: page,
          truncated: rest.length > limit,
          next_after:
            rest.length > limit && last !== undefined
              ? {
                  received_at: last.received_at,
                  candidate_id: last.candidate_id,
                }
              : null,
        },
      };
    },
  };
  return { rows, client, transitions };
}

test('the list does not wait for the evidence re-check; it runs behind, never twice at once, and only after 15 minutes', async () => {
  const h = harness();
  const store = fakeStore(3);
  let now = NOW;
  const checked: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const refresh = build(h, {
    client: store.client as never,
    clock: async () => ({ ok: true, now }),
    checkEvidence: async (row) => {
      checked.push(row.candidate_id);
      // 1 件目の取り直しは、試験が放すまで終わらない（遅い提供元）。
      await gate;
      return 'available';
    },
  });
  // 一覧は再確認の終わりを待たずに返る。
  const listed = await refresh.wrap(h.list)(request);
  assert.deepEqual(listed, { status: 200, body: { candidates: [] } });
  assert.deepEqual(h.events, ['maintain', 'list']);
  // 一覧の前の保守には再確認を渡さない（時間による遷移と掃除だけ）。
  assert.equal(h.ports[0]?.checkEvidence, undefined);
  assert.equal(checked.length, 1);
  // 走っている間（15 分を過ぎても）は 2 つ目を始めない。
  now = '2030-10-09T03:20:00.000Z';
  await refresh.wrap(h.list)(request);
  assert.equal(checked.length, 1);
  release();
  await refresh.evidenceIdle();
  assert.equal(checked.length, 3);
  // 前の再確認を始めてから（03:00）15 分は空いたが、走っている間に来た要求では始めていない。次の要求で始める。
  await refresh.refresh();
  await refresh.evidenceIdle();
  assert.equal(checked.length, 6);
  // 14 分 59 秒後は始めない。時計が戻っても始めない。15 分ちょうどで始める。
  now = '2030-10-09T03:34:59.000Z';
  await refresh.refresh();
  now = '2030-10-09T03:10:00.000Z';
  await refresh.refresh();
  await refresh.evidenceIdle();
  assert.equal(checked.length, 6);
  now = '2030-10-09T03:35:00.000Z';
  await refresh.refresh();
  await refresh.evidenceIdle();
  assert.equal(checked.length, 9);
});

test('one re-check stops at 20 candidates or 20 seconds and the next one continues where it stopped', async () => {
  const h = harness();
  const store = fakeStore(25);
  let now = NOW;
  let clock = 0;
  const checked: string[] = [];
  const reports: string[] = [];
  const refresh = build(h, {
    client: store.client as never,
    clock: async () => ({ ok: true, now }),
    monotonic: () => clock,
    onEvidenceRecheck: (report) => reports.push(report.stopped),
    checkEvidence: async (row) => {
      checked.push(row.candidate_id);
      // 取り直しごとに 1.5 秒かかる（上限 20 秒 → 14 件目を始める前に止まる）。
      clock += 1500;
      return row.candidate_id === store.rows[2]?.candidate_id
        ? 'removed'
        : 'available';
    },
  });
  await refresh.refresh();
  await refresh.evidenceIdle();
  // 1.5 秒 × 14 = 21 秒。14 件目を終えた時点で 20 秒を過ぎ、15 件目は始めない。
  assert.equal(checked.length, 14);
  assert.deepEqual(reports, ['time_limit']);
  assert.deepEqual(store.transitions, [
    `${store.rows[2]?.candidate_id ?? ''}:source_out_of_scope`,
  ]);
  assert.deepEqual(h.logs, ['candidate_evidence_recheck_stopped:time_limit']);
  // 次の回は続き（15 件目）から。時間がかからなければ 20 件で止まる（残りは 0 件なので読み切り）。
  now = '2030-10-09T03:15:00.000Z';
  clock = 0;
  await refresh.refresh();
  await refresh.evidenceIdle();
  assert.deepEqual(
    checked.slice(14),
    store.rows.slice(14).map((row) => row.candidate_id),
  );
  assert.deepEqual(reports, ['time_limit', 'done']);
  // 読み切った後は先頭から。件数の上限（既定 20 件）で止まる。
  now = '2030-10-09T03:30:00.000Z';
  const fast = build(harness(), {
    client: store.client as never,
    clock: async () => ({ ok: true, now }),
    monotonic: () => 0,
    onEvidenceRecheck: (report) => reports.push(report.stopped),
    checkEvidence: async (row) => {
      checked.push(row.candidate_id);
      return 'available';
    },
  });
  const before = checked.length;
  await fast.refresh();
  await fast.evidenceIdle();
  assert.equal(checked.length - before, 20);
  assert.equal(reports[reports.length - 1], 'count_limit');
  assert.equal(checked[before], store.rows[0]?.candidate_id);
});

test('the evidence writes of one re-check are wrapped in one alert batch, and a failing check does not stop the list', async () => {
  const h = harness();
  const store = fakeStore(2);
  const batches: string[] = [];
  const refresh = build(h, {
    client: store.client as never,
    batch: async (run) => {
      batches.push('start');
      const out = await run();
      batches.push('end');
      return out;
    },
    checkEvidence: async () => {
      throw new Error('provider');
    },
  });
  const listed = await refresh.wrap(h.list)(request);
  assert.equal(listed.status, 200);
  await refresh.evidenceIdle();
  assert.deepEqual(batches, ['start', 'end']);
  // 例外は未確認として扱い、状態を変えない。
  assert.deepEqual(store.transitions, []);
});
