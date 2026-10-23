// 予算の命令を DB worker（worker_threads）とクライアント越しに確かめる（ADR 0036）。DB は一時ディレクトリに作って消す。
// - QA28 と同じ型: 受付の COMMIT の直後（応答の前）に worker が落ちても、新しい worker で同じ request_id を送り直すと
//   保存済みの予約を返し、二重に受け付けない。
// - X18 の DB の層: 2 つの worker（別々の書込み接続）がそろって受け付けても、上限を超えない。
// 期待値は合成の上限（XTS）から手で書いた値。固定の sleep は使わず、両方の worker の起動を待ってから同じ tick で送る。

import assert from 'node:assert/strict';
import test from 'node:test';
import { DbWorkerClient, openWriteConnection } from './index.js';
import type { DbWorkerOptions } from './index.js';
import {
  OCT_15,
  TIME_ZONE,
  admitOp,
  approvalId,
  budgetRequestId,
  count,
  reservationId,
} from './budget-test-support.js';
import {
  STORE_GENERATION,
  databasePath,
  openSeededDatabase,
  withTempDir,
} from './operation-test-support.js';

function start(
  path: string,
  options: Partial<DbWorkerOptions> = {},
): Promise<DbWorkerClient> {
  return DbWorkerClient.start({
    path,
    storeGeneration: STORE_GENERATION,
    responseTimeoutMs: 10_000,
    ...options,
  });
}

async function seeded(dir: string): Promise<string> {
  const path = databasePath(dir);
  openSeededDatabase(path).close();
  const client = await start(path);
  try {
    const calendar = await client.budget({
      kind: 'budget.calendar_advance',
      now: OCT_15,
      time_zone: TIME_ZONE,
    });
    assert.equal(calendar.ok, true, JSON.stringify(calendar));
  } finally {
    await client.close();
  }
  return path;
}

// 検査は worker を閉じた後に、試験側の書込み接続で読む（合成のデータは足さない）。
function withConnection<T>(
  path: string,
  read: (db: ReturnType<typeof openWriteConnection>) => T,
): T {
  const db = openWriteConnection(path, { platform: 'macos' });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

test('a worker exit right after the admission COMMIT never admits the same request twice (QA28 shape)', async () => {
  await withTempDir(async (dir) => {
    const path = await seeded(dir);
    const first = await start(path, {
      faults: { exitAfterCommit: 'budget.admit' },
    });
    const op = admitOp(1, { reserved: '10', max: '70' });
    const lost = await first.budget(op);
    // COMMIT の応答を失った。未 commit と決めつけず、成否不明として扱う。
    assert.deepEqual(lost, {
      ok: false,
      outcome: 'unknown',
      reasons: ['worker_exited'],
    });
    assert.equal(first.state, 'broken');
    await first.close();
    const next = await start(path);
    try {
      const found = await next.budget({
        kind: 'budget.reservation_find',
        reservation_id: null,
        request_id: budgetRequestId(1),
      });
      assert.equal(found.ok, true);
      assert.deepEqual(
        found.ok && found.value !== null
          ? [
              found.value.reservationId,
              found.value.status,
              found.value.maxLiability,
            ]
          : null,
        [reservationId(1), 'reserved', '70'],
      );
      // 同じ request_id の送り直しは保存済みの予約を返す。
      const resent = await next.budget(op);
      assert.equal(resent.ok, true);
      assert.deepEqual(
        resent.ok
          ? [
              resent.value.admitted,
              resent.value.duplicate,
              resent.value.reservation?.reservationId,
            ]
          : null,
        [true, true, reservationId(1)],
      );
      // 一度だけ数えている: 70＋20＝90 > 80。
      const more = await next.budget(admitOp(2, { reserved: '5', max: '20' }));
      assert.deepEqual(more.ok ? more.value.reason_codes : null, [
        'm_limit:llm',
      ]);
    } finally {
      await next.close();
    }
    assert.equal(
      withConnection(path, (db) =>
        count(db, 'SELECT count(*) FROM budget_reservations'),
      ),
      1,
    );
  });
});

test('two workers admitting at the same time never exceed the limit (X18)', async () => {
  await withTempDir(async (dir) => {
    const path = await seeded(dir);
    const a = await start(path);
    const b = await start(path);
    try {
      const base = await a.budget(admitOp(1, { reserved: '10', max: '60' }));
      assert.equal(base.ok && base.value.admitted, true);
      // 両方の worker が動いてから、同じ tick で送る（関門）。llm の残りは 20 で、どちらか一方だけが収まる。
      const [ra, rb] = await Promise.all([
        a.budget(admitOp(2, { reserved: '5', max: '20' })),
        b.budget(admitOp(3, { reserved: '5', max: '20' })),
      ]);
      const admitted = [ra, rb].filter((r) => r.ok && r.value.admitted);
      assert.equal(admitted.length, 1, JSON.stringify([ra, rb]));
      const loser =
        ra.ok && ra.value.admitted
          ? { r: rb, client: b, n: 3 }
          : { r: ra, client: a, n: 2 };
      // 負けた側は、書込みの排他で待たずに拒否されたか、先の COMMIT の後に上限で拒否された。
      if (loser.r.ok)
        assert.deepEqual(loser.r.value.reason_codes, ['m_limit:llm']);
      else {
        assert.deepEqual(loser.r, {
          ok: false,
          outcome: 'rejected',
          reasons: ['database_busy'],
        });
        const retry = await loser.client.budget(
          admitOp(loser.n, { reserved: '5', max: '20' }),
        );
        assert.deepEqual(retry.ok ? retry.value.reason_codes : null, [
          'm_limit:llm',
        ]);
      }
      // 承認の二度押し（2 つの worker から同時）でも承認は 1 件。
      const asked = await a.budget({
        kind: 'budget.request_overage',
        approval_id: approvalId(1),
        request_id: budgetRequestId(9),
        pool_id: 'overage',
        budget_month: '2030-10',
        currency: 'XTS',
        max_liability: '20',
        overage_remaining: '60',
        now: OCT_15,
        expires_at: OCT_15 + 600_000,
      });
      assert.equal(asked.ok, true);
      const press = {
        kind: 'budget.approve_overage',
        approval_id: approvalId(1),
        budget_request_id: budgetRequestId(9),
        currency: 'XTS',
        max_liability: '20',
        decision: 'approve',
        now: OCT_15 + 1000,
        request: null,
      } as const;
      const presses = await Promise.all([
        a.budget(press),
        b.budget(press),
        a.budget(press),
      ]);
      const fresh = presses.filter((r) => r.ok && !r.value.duplicate);
      assert.equal(fresh.length, 1, JSON.stringify(presses));
      for (const r of presses)
        if (!r.ok) assert.deepEqual(r.reasons, ['database_busy']);
    } finally {
      await a.close();
      await b.close();
    }
    withConnection(path, (db) => {
      assert.equal(
        count(
          db,
          "SELECT sum(max_liability) FROM budget_reservations WHERE pool_id = 'llm' AND status = 'reserved'",
        ),
        80,
      );
      assert.equal(
        count(
          db,
          "SELECT count(*) FROM budget_overage_approvals WHERE status = 'approved'",
        ),
        1,
      );
    });
  });
});
