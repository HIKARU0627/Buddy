// ペアリング・端末の一覧・証明書の変更による失効の保存（ADR 0021）。DB は一時ディレクトリに作って消す。
// コードの照合の期待値は契約 fixture（api-scenarios.json の pairing）に手で書いた値を使う。
// hash は試験の中で作る合成の値（製品の HMAC とは別の SHA-256）で、トークン・秘密そのものではない。

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DbWorkerClient,
  PAIRING_CLAIM_TTL_MS,
  executePairingOp,
} from './index.js';
import type {
  PairingClaimOutcome,
  PairingClaimRecord,
  PairingOp,
  PairingOpResult,
} from './index.js';
import type { SqliteDatabase } from './connection.js';
import {
  STORE_GENERATION,
  databasePath,
  openSeededDatabase,
  withTempDir,
} from './operation-test-support.js';

const MINUTE = 60_000;
const T0 = Date.parse('2030-10-05T00:00:00Z');
const HOUR_LATER = 60 * MINUTE;
const FINGERPRINT = 'f'.repeat(64);
const OTHER_FINGERPRINT = 'e'.repeat(64);
const hash = (label: string) =>
  createHash('sha256').update(`synthetic:${label}`).digest('hex');

interface PairingStep {
  readonly code: string;
  readonly now: string;
  readonly expected: {
    readonly ok: boolean;
    readonly reason: string | null;
    readonly attempts_left: number;
  };
}

const scenarios = JSON.parse(
  readFileSync(
    new URL(
      '../../../packages/contracts/fixtures/api-scenarios.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  pairing: {
    initial: { pairing_code: string; expires_at: string };
    steps: PairingStep[];
    exhaustion: {
      wrong_attempts: number;
      then: { code: string; now: string };
      expected: PairingStep['expected'];
    };
    expiry: PairingStep;
  };
};

function run(
  db: SqliteDatabase,
  op: PairingOp,
  halted = false,
): PairingOpResult {
  return executePairingOp(db, op, { platform: 'macos', halted }).result;
}

function value<T>(result: PairingOpResult): T {
  assert.equal(result.ok, true, result.ok ? '' : result.reasons.join(','));
  if (!result.ok) throw new Error('unreachable');
  return result.value as T;
}

function reasonsOf(result: PairingOpResult): readonly string[] {
  assert.equal(result.ok, false);
  return result.ok ? [] : result.reasons;
}

const start = (
  code: string,
  createdAt = T0,
  fingerprint = FINGERPRINT,
  expiresAt = createdAt + 5 * MINUTE,
): Extract<PairingOp, { kind: 'pairing.start' }> => ({
  kind: 'pairing.start',
  pairing_id: randomUUID(),
  code_hash: hash(`code:${code}`),
  certificate_fingerprint: fingerprint,
  created_at: createdAt,
  expires_at: expiresAt,
});

const claim = (
  code: string,
  now: number,
  secret = randomUUID(),
): Extract<PairingOp, { kind: 'pairing.claim' }> => ({
  kind: 'pairing.claim',
  claim_id: randomUUID(),
  code_hash: hash(`code:${code}`),
  device_name: '合成の端末',
  platform: 'windows',
  claim_secret_hash: hash(`secret:${secret}`),
  now,
  claim_expires_at: now + PAIRING_CLAIM_TTL_MS,
});

// 結果を fixture の期待値（ok・reason・attempts_left）の形にそろえる。
function outcomeOf(outcome: PairingClaimOutcome): PairingStep['expected'] {
  return outcome.ok
    ? { ok: true, reason: null, attempts_left: -1 }
    : {
        ok: false,
        reason: outcome.reason,
        attempts_left: outcome.attempts_left,
      };
}

function attemptsLeft(db: SqliteDatabase, pairingId: string): number {
  return (
    db
      .prepare(
        'SELECT attempts_left FROM pairing_sessions WHERE pairing_id = ?',
      )
      .get(pairingId) as { attempts_left: number }
  ).attempts_left;
}

test(
  'pairing codes follow the fixture: mismatches count down, a used code and expiry are refused',
  { timeout: 30_000 },
  async () => {
    const { initial, steps, exhaustion, expiry } = scenarios.pairing;
    assert.equal(Date.parse(initial.expires_at), T0 + 5 * MINUTE);
    await withTempDir((dir) => {
      const db = openSeededDatabase(databasePath(dir));
      try {
        const session = start(initial.pairing_code);
        value(run(db, session));
        for (const step of steps) {
          const outcome = value<PairingClaimOutcome>(
            run(db, claim(step.code, Date.parse(step.now))),
          );
          const got = outcomeOf(outcome);
          assert.equal(got.ok, step.expected.ok, step.code);
          assert.equal(got.reason, step.expected.reason, step.code);
          // 成功の時の残り回数は DB の値で確かめる（申請には残り回数を返さない）。
          assert.equal(
            attemptsLeft(db, session.pairing_id),
            step.expected.attempts_left,
            step.code,
          );
        }

        // 5 回続けて失敗すると、正しいコードでも受け付けない。
        const exhausted = start(initial.pairing_code);
        value(run(db, exhausted));
        for (let index = 0; index < exhaustion.wrong_attempts; index += 1)
          value(run(db, claim('99999999', T0 + MINUTE + index)));
        const after = value<PairingClaimOutcome>(
          run(db, claim(exhaustion.then.code, Date.parse(exhaustion.then.now))),
        );
        assert.deepEqual(outcomeOf(after), exhaustion.expected);

        // 期限（開始から 5 分ちょうど）を過ぎると受け付けず、残り回数も減らさない。
        const expiring = start(initial.pairing_code);
        value(run(db, expiring));
        const expired = value<PairingClaimOutcome>(
          run(db, claim(expiry.code, Date.parse(expiry.now))),
        );
        assert.deepEqual(outcomeOf(expired), expiry.expected);
        // 時計が開始より前へ戻ったときも期限切れとして扱う。
        const backwards = value<PairingClaimOutcome>(
          run(db, claim(initial.pairing_code, T0 - 1)),
        );
        assert.equal(outcomeOf(backwards).reason, 'expired');
        assert.equal(attemptsLeft(db, expiring.pairing_id), 5);
      } finally {
        db.close();
      }
    });
  },
);

test(
  'a new pairing supersedes the unused one and a claim secret cannot be reused',
  { timeout: 30_000 },
  async () => {
    await withTempDir((dir) => {
      const db = openSeededDatabase(databasePath(dir));
      try {
        const first = start('11111111');
        value(run(db, first));
        const second = start('22222222', T0 + 1);
        value(run(db, second));
        // 前のペアリングは使用済みになり、そのコードは最新のペアリングとの照合で不一致になる。
        const old = value<PairingClaimOutcome>(
          run(db, claim('11111111', T0 + 2)),
        );
        assert.equal(outcomeOf(old).reason, 'code_mismatch');
        const firstRow = value<{ used: boolean } | null>(
          run(db, {
            kind: 'pairing.find_session',
            pairing_id: first.pairing_id,
          }),
        );
        assert.equal(firstRow?.used, true);

        const secret = randomUUID();
        const ok = value<PairingClaimOutcome>(
          run(db, claim('22222222', T0 + 3, secret)),
        );
        assert(ok.ok);
        assert.equal(ok.claim.status, 'pending');
        assert.equal(ok.claim.pairing_id, second.pairing_id);
        assert.equal(ok.claim.certificate_fingerprint, FINGERPRINT);
        // 同じ申請用の秘密の hash は、別のペアリングでも使えない（コードの照合の前に拒否し、回数を減らさない）。
        const third = start('33333333', T0 + 4);
        value(run(db, third));
        assert.deepEqual(
          reasonsOf(run(db, claim('33333333', T0 + 5, secret))),
          ['claim_secret_reused'],
        );
        assert.equal(attemptsLeft(db, third.pairing_id), 5);
      } finally {
        db.close();
      }
    });
    // ペアリングがないときは no_session。
    await withTempDir((dir) => {
      const db = openSeededDatabase(databasePath(dir));
      try {
        const none = value<PairingClaimOutcome>(run(db, claim('12345678', T0)));
        assert.deepEqual(outcomeOf(none), {
          ok: false,
          reason: 'no_session',
          attempts_left: 0,
        });
      } finally {
        db.close();
      }
    });
  },
);

// 承認待ちの申請を一つ作り、その申請と秘密の hash を返す。
function pendingClaim(
  db: SqliteDatabase,
  createdAt: number,
  fingerprint = FINGERPRINT,
): { readonly claim: PairingClaimRecord; readonly secretHash: string } {
  const code = String(10_000_000 + (createdAt % 1000));
  value(run(db, start(code, createdAt, fingerprint)));
  const secret = randomUUID();
  const outcome = value<PairingClaimOutcome>(
    run(db, claim(code, createdAt + MINUTE, secret)),
  );
  assert(outcome.ok);
  return { claim: outcome.claim, secretHash: hash(`secret:${secret}`) };
}

const decide = (
  claimId: string,
  decision: 'approve' | 'reject',
  now: number,
  options: { fingerprint?: string; requireNoActiveDevices?: boolean } = {},
): Extract<PairingOp, { kind: 'pairing.decide' }> => ({
  kind: 'pairing.decide',
  claim_id: claimId,
  decision,
  now,
  certificate_fingerprint: options.fingerprint ?? FINGERPRINT,
  require_no_active_devices: options.requireNoActiveDevices ?? false,
});

const pickup = (
  claimId: string,
  secretHash: string,
  now: number,
  options: {
    fingerprint?: string;
    tokenHash?: string;
    hubLocal?: boolean;
  } = {},
): Extract<PairingOp, { kind: 'pairing.pickup' }> => ({
  kind: 'pairing.pickup',
  claim_id: claimId,
  claim_secret_hash: secretHash,
  device_id: randomUUID(),
  token_hash: options.tokenHash ?? hash(`token:${randomUUID()}`),
  hub_local: options.hubLocal ?? false,
  now,
  certificate_fingerprint: options.fingerprint ?? FINGERPRINT,
});

test(
  'approval and a single token pickup register the device with only the token hash',
  { timeout: 30_000 },
  async () => {
    await withTempDir((dir) => {
      const db = openSeededDatabase(databasePath(dir));
      try {
        const { claim: pending, secretHash } = pendingClaim(db, T0);
        const id = pending.claim_id;
        // 承認前は受け取れない。
        assert.deepEqual(
          reasonsOf(run(db, pickup(id, secretHash, T0 + 2 * MINUTE))),
          ['claim_not_approved'],
        );
        // 秘密の照合（hash だけ）。
        assert.deepEqual(
          value(
            run(db, {
              kind: 'pairing.claim_secret_matches',
              claim_id: id,
              claim_secret_hash: secretHash,
            }),
          ),
          { matches: true },
        );
        assert.deepEqual(
          value(
            run(db, {
              kind: 'pairing.claim_secret_matches',
              claim_id: id,
              claim_secret_hash: hash('other'),
            }),
          ),
          { matches: false },
        );
        assert.deepEqual(
          value(
            run(db, {
              kind: 'pairing.claim_secret_matches',
              claim_id: randomUUID(),
              claim_secret_hash: secretHash,
            }),
          ),
          { matches: false },
        );
        // 有効な端末（合成の 2 台）があれば、最初の端末の承認は拒否する。
        assert.deepEqual(
          reasonsOf(
            run(
              db,
              decide(id, 'approve', T0 + 2 * MINUTE, {
                requireNoActiveDevices: true,
              }),
            ),
          ),
          ['devices_registered'],
        );
        // 証明書が変わっていれば承認しない。
        assert.deepEqual(
          reasonsOf(
            run(
              db,
              decide(id, 'approve', T0 + 2 * MINUTE, {
                fingerprint: OTHER_FINGERPRINT,
              }),
            ),
          ),
          ['certificate_changed'],
        );
        const approved = value<PairingClaimRecord>(
          run(db, decide(id, 'approve', T0 + 2 * MINUTE)),
        );
        assert.equal(approved.status, 'approved');
        // 承認済みの申請はもう一度決められない。
        assert.deepEqual(
          reasonsOf(run(db, decide(id, 'reject', T0 + 2 * MINUTE))),
          ['claim_not_pending'],
        );
        // 秘密が違えば受け取れない。
        assert.deepEqual(
          reasonsOf(run(db, pickup(id, hash('other'), T0 + 3 * MINUTE))),
          ['claim_secret_mismatch'],
        );
        const tokenHash = hash('token:first');
        const op = pickup(id, secretHash, T0 + 3 * MINUTE, {
          tokenHash,
          hubLocal: true,
        });
        const device = value<Record<string, unknown>>(run(db, op));
        assert.deepEqual(device, {
          device_id: op.device_id,
          device_name: '合成の端末',
          platform: 'windows',
          hub_local: true,
          registered_at: T0 + 3 * MINUTE,
          last_seen_at: null,
          revoked_at: null,
        });
        // 2 回目は受け取れない（consumed）。
        assert.deepEqual(
          reasonsOf(run(db, pickup(id, secretHash, T0 + 3 * MINUTE))),
          ['claim_consumed'],
        );
        const consumed = value<PairingClaimRecord>(
          run(db, { kind: 'pairing.find_claim', claim_id: id }),
        );
        assert.equal(consumed.status, 'consumed');
        assert.equal(consumed.device_id, op.device_id);
        // DB にはトークンの hash だけがある（32 バイト）。
        const row = db
          .prepare('SELECT token_hash FROM devices WHERE device_id = ?')
          .get(op.device_id) as { token_hash: Buffer };
        assert.equal(row.token_hash.toString('hex'), tokenHash);
      } finally {
        db.close();
      }
    });
  },
);

test(
  'rejected, expired and certificate-changed claims never hand out a token',
  { timeout: 30_000 },
  async () => {
    await withTempDir((dir) => {
      const db = openSeededDatabase(databasePath(dir));
      try {
        const rejected = pendingClaim(db, T0);
        value(
          run(db, decide(rejected.claim.claim_id, 'reject', T0 + 2 * MINUTE)),
        );
        assert.deepEqual(
          reasonsOf(
            run(
              db,
              pickup(
                rejected.claim.claim_id,
                rejected.secretHash,
                T0 + 3 * MINUTE,
              ),
            ),
          ),
          ['claim_rejected'],
        );

        // 申請の期限（申請の時刻から 5 分）ちょうどで、承認も受取りもできない。
        const late = pendingClaim(db, T0 + 10 * MINUTE);
        const deadline = late.claim.expires_at;
        assert.equal(deadline, T0 + 11 * MINUTE + PAIRING_CLAIM_TTL_MS);
        assert.deepEqual(
          reasonsOf(run(db, decide(late.claim.claim_id, 'approve', deadline))),
          ['claim_expired'],
        );
        value(run(db, decide(late.claim.claim_id, 'approve', deadline - 1)));
        assert.deepEqual(
          reasonsOf(
            run(db, pickup(late.claim.claim_id, late.secretHash, deadline)),
          ),
          ['claim_expired'],
        );

        // 承認の後に証明書が変われば受け取れない。
        const changed = pendingClaim(db, T0 + 20 * MINUTE);
        value(
          run(db, decide(changed.claim.claim_id, 'approve', T0 + 22 * MINUTE)),
        );
        assert.deepEqual(
          reasonsOf(
            run(
              db,
              pickup(
                changed.claim.claim_id,
                changed.secretHash,
                T0 + 22 * MINUTE,
                {
                  fingerprint: OTHER_FINGERPRINT,
                },
              ),
            ),
          ),
          ['certificate_changed'],
        );
        assert.deepEqual(
          reasonsOf(run(db, decide(randomUUID(), 'approve', T0))),
          ['claim_not_found'],
        );
        // どれも端末を登録していない（合成の 2 台のまま）。
        assert.deepEqual(value(run(db, { kind: 'devices.count_active' })), {
          count: 2,
        });
      } finally {
        db.close();
      }
    });
  },
);

test(
  'devices paired under another certificate are revoked with their scopes; others are kept',
  { timeout: 30_000 },
  async () => {
    await withTempDir((dir) => {
      const db = openSeededDatabase(databasePath(dir));
      try {
        const register = (createdAt: number, fingerprint: string) => {
          const { claim: c, secretHash } = pendingClaim(
            db,
            createdAt,
            fingerprint,
          );
          value(
            run(
              db,
              decide(c.claim_id, 'approve', createdAt + 2 * MINUTE, {
                fingerprint,
              }),
            ),
          );
          return value<{ device_id: string }>(
            run(
              db,
              pickup(c.claim_id, secretHash, createdAt + 3 * MINUTE, {
                fingerprint,
              }),
            ),
          ).device_id;
        };
        const oldDevice = register(T0, OTHER_FINGERPRINT);
        const currentDevice = register(T0 + 10 * MINUTE, FINGERPRINT);
        db.prepare(
          "INSERT INTO command_scopes VALUES ('00000000-0000-4000-8000-000000000001', ?, '00000000-0000-4000-8000-0000000000c1', ?, ?, NULL)",
        ).run(oldDevice, T0, T0 + MINUTE);
        assert.deepEqual(value(run(db, { kind: 'devices.count_active' })), {
          count: 4,
        });
        const revoked = value<{ revoked_device_ids: string[] }>(
          run(db, {
            kind: 'devices.revoke_certificate_mismatch',
            certificate_fingerprint: FINGERPRINT,
            revoked_at: T0 + HOUR_LATER,
          }),
        );
        assert.deepEqual(revoked.revoked_device_ids, [oldDevice]);
        const devices = value<
          { device_id: string; revoked_at: number | null }[]
        >(run(db, { kind: 'devices.list' }));
        const byId = new Map(devices.map((d) => [d.device_id, d.revoked_at]));
        assert.equal(byId.get(oldDevice), T0 + HOUR_LATER);
        assert.equal(byId.get(currentDevice), null);
        // ペアリングで登録していない端末（合成の 2 台）は対象にしない。
        assert.equal(byId.get('dev-1'), null);
        assert.equal(byId.get('dev-2'), null);
        const scope = db
          .prepare('SELECT revoked_at FROM command_scopes WHERE device_id = ?')
          .get(oldDevice) as { revoked_at: number | null };
        assert.equal(scope.revoked_at, T0 + HOUR_LATER);
        // 2 回目は何も失効しない。
        assert.deepEqual(
          value(
            run(db, {
              kind: 'devices.revoke_certificate_mismatch',
              certificate_fingerprint: FINGERPRINT,
              revoked_at: T0 + 2 * HOUR_LATER,
            }),
          ),
          { revoked_device_ids: [] },
        );
        assert.equal(
          value<{ device_id: string } | null>(
            run(db, { kind: 'devices.find', device_id: currentDevice }),
          )?.device_id,
          currentDevice,
        );
        assert.equal(
          value(run(db, { kind: 'devices.find', device_id: randomUUID() })),
          null,
        );
      } finally {
        db.close();
      }
    });
  },
);

test(
  'malformed pairing operations and halted writers are refused',
  { timeout: 30_000 },
  async () => {
    await withTempDir((dir) => {
      const db = openSeededDatabase(databasePath(dir));
      try {
        const refused = (op: PairingOp, reason: string) => {
          const result = run(db, op);
          assert(!result.ok && result.reasons.includes(reason), reason);
        };
        refused(
          start('12345678', T0, FINGERPRINT, T0 + 5 * MINUTE + 1),
          'expires_at_invalid',
        );
        refused(
          { ...start('12345678'), code_hash: 'AB'.repeat(32) },
          'code_hash_invalid',
        );
        refused(
          { ...start('12345678'), certificate_fingerprint: 'f'.repeat(63) },
          'certificate_fingerprint_invalid',
        );
        refused(
          { ...claim('12345678', T0), device_name: '' },
          'device_name_invalid',
        );
        refused(
          {
            ...claim('12345678', T0),
            claim_expires_at: T0 + PAIRING_CLAIM_TTL_MS + 1,
          },
          'claim_expires_at_invalid',
        );
        refused(
          { ...claim('12345678', T0), platform: 'ios' as 'macos' },
          'platform_invalid',
        );
        refused(
          {
            ...decide(randomUUID(), 'approve', T0),
            decision: 'maybe' as 'approve',
          },
          'decision_invalid',
        );
        refused(
          { ...pickup(randomUUID(), hash('s'), T0), token_hash: '0' },
          'token_hash_invalid',
        );
        refused({ kind: 'devices.find', device_id: 'x' }, 'device_id_invalid');
        // 書込みを止めた worker は書かない（照会は続ける）。
        assert.deepEqual(run(db, start('12345678'), true), {
          ok: false,
          outcome: 'rejected',
          reasons: ['worker_halted'],
        });
        assert.equal(run(db, { kind: 'devices.list' }, true).ok, true);
        db.pragma('synchronous = NORMAL');
        const weak = executePairingOp(db, start('12345678'), {
          platform: 'macos',
          halted: false,
        });
        assert.equal(weak.halt, true);
        assert(
          !weak.result.ok && weak.result.reasons[0] === 'durability_mismatch',
        );
      } finally {
        db.close();
      }
    });
  },
);

test(
  'the DB worker client carries pairing operations',
  { timeout: 30_000 },
  async () => {
    await withTempDir(async (dir) => {
      const path = databasePath(dir);
      openSeededDatabase(path).close();
      const client = await DbWorkerClient.start({
        path,
        storeGeneration: STORE_GENERATION,
        responseTimeoutMs: 10_000,
      });
      try {
        const session = start('12345678');
        const started = await client.pairing(session);
        assert(started.ok);
        assert.equal(started.value.attempts_left, 5);
        const claimed = await client.pairing(claim('12345678', T0 + MINUTE));
        assert(claimed.ok && claimed.value.ok);
        assert.equal(claimed.value.claim.pairing_id, session.pairing_id);
        const found = await client.pairing({
          kind: 'pairing.find_session_claim',
          pairing_id: session.pairing_id,
        });
        assert(found.ok);
        assert.equal(found.value?.claim_id, claimed.value.claim.claim_id);
        const listed = await client.pairing({ kind: 'devices.list' });
        assert(listed.ok);
        assert.deepEqual(
          listed.value.map((device) => device.device_id),
          ['dev-1', 'dev-2'],
        );
      } finally {
        await client.close();
      }
      assert.deepEqual(await client.pairing({ kind: 'devices.count_active' }), {
        ok: false,
        outcome: 'rejected',
        reasons: ['worker_closed'],
      });
    });
  },
);
