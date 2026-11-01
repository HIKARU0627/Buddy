// 系譜の全件読みの実測（ADR 0054 U110、B06-07 の 07b-0。本人が 2026-11-01 に合格の基準を決定）。
//
// 合成の DB を 2 つの規模（1 年相当＝記憶 2,000・系譜の辺 5 万、その 10 倍）で作り、
// - 系譜の閉包の読み取り（`forget.graph`。`readLineageEdges` で derivations・memory_sources・user_directives を全件読む）
// - domain の `planForget`（Core のメインスレッドで動く純粋な計画）
// - 忘却の適用の transaction（`forget.apply`。BEGIN IMMEDIATE の中でもう一度全件読み + 計画 + 削除 + 台帳）
// の所要時間と、DB worker を通す経路で同時に測ったメインのイベントループ遅延 p99 を記録する。
//
// これは `pnpm test` には入れない（`*.test.mjs` ではないので scripts/run-tests.mjs が拾わない）。
// 実データ・実機は使わない。数値は実行する機械に依存する。
//
// 使い方（ビルド済みの dist を読む）:
//   pnpm run build
//   node scripts/forget-lineage-benchmark.mjs            # 2 つの規模を続けて実行
//   node scripts/forget-lineage-benchmark.mjs --only one-year
//   node scripts/forget-lineage-benchmark.mjs --json     # 最後に JSON も出す
//
// 出力は標準出力だけ。DB は OS の一時ディレクトリに作り、終了時に消す（残さない）。

import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { cpus, totalmem, platform as osPlatform, release } from 'node:os';
import {
  DbWorkerClient,
  applyMigrations,
  executeMemoryOp,
  initStoreGeneration,
  openWriteConnection,
  storagePlatform,
} from '../packages/storage/dist/index.js';
import { planForget } from '../packages/domain/dist/index.js';

// --- 規模（本人の決定 2026-11-01。1 年相当＝記憶 2,000・系譜の辺 5 万） ---
const EDGES_PER_MEMORY = 25;
const SCALES = [
  {
    id: 'one-year',
    label: '1 年相当',
    memories: 2_000,
    lineageEdges: 50_000,
    readSamples: 5,
    applySamples: 5,
  },
  {
    id: 'ten-times',
    label: '10 倍',
    memories: 20_000,
    lineageEdges: 500_000,
    readSamples: 3,
    applySamples: 3,
  },
];
// 合格の基準（本人の決定 2026-11-01）。
const LIMITS = {
  'one-year': { apply_ms: 1_000, event_loop_p99_ms: 50 },
  'ten-times': { apply_ms: 5_000, event_loop_p99_ms: 50 },
};

// 固定の時刻（時計は結果に使わない。期限の判定もしない）。
const NOW = Date.parse('2026-11-01T00:00:00.000Z');
const CREATED_AT = Date.parse('2025-11-01T00:00:00.000Z');
const DAY_MS = 86_400_000;

// --- 合成の ID ---

const hex12 = (value) => value.toString(16).padStart(12, '0');

// UUID v4 の形（4 桁目が 4、5 桁目の先頭が 8）。種類ごとに接頭辞を変える。
function uuid(prefix, index) {
  return `${prefix}-0000-4000-8000-${hex12(index)}`;
}

const MEMORY_PREFIX = 'a11ce000';
const TURN_PREFIX = 'b0b00000';
const SESSION_PREFIX = '5e55a000';
const OPERATION_PREFIX = '0be00000';
const BLOB_PREFIX = 'b10b0000';

const memoryId = (index) => uuid(MEMORY_PREFIX, index);
const turnId = (index) => uuid(TURN_PREFIX, index);
const sessionId = (index) => uuid(SESSION_PREFIX, index);
const operationId = (index, slot) => uuid(OPERATION_PREFIX, index * 10 + slot);
// 派生の節点（表のない種類もある）。derivations の CHECK は長さ 1〜256 だけを見る。
const derivedId = (kind, index, slot) => `${kind}-${hex12(index)}-${slot}`;
const sourceItemId = (index) => `remote-${hex12(index)}`;

const textBlobId = (index) => uuid(BLOB_PREFIX, index * 2 + 1);
const targetBlobId = (index) => uuid(BLOB_PREFIX, index * 2 + 2);
const sha256hex = (text) => createHash('sha256').update(text).digest('hex');

// 台帳の HMAC。実測では鍵を使わない（64 桁の 16 進であればよい。値の正しさはここでは見ない）。
const benchmarkHmac = (source) =>
  sha256hex(
    `buddy-lineage-benchmark:${source.source_kind}:${source.source_id}`,
  );
const sourceHmac = (source) => benchmarkHmac(source);

// --- 系譜の形（1 記憶あたり 25 辺）---
//
// 1 記憶あたり:
//   memory_sources 2（由来の発言・元情報）、derivations 23。
//   記憶から出る辺（13）: operation_content 3・notification_candidate 2・related_analysis 1・
//                         async_guard 3・canvas_item 2・request_entity 1・session_summary 1
//   記憶以外の辺（10）: 発言→intent_shadow 3・気づき→つないだ要約 2・関連解析→気づき 1・
//                       操作の確定内容→関連解析 1・非同期の参照→操作の確定内容 1・キャンバス→つないだ要約 1・
//                       発言→関連解析 1
// 閉包は 1 記憶の下流だけ（約 20 節点）で、ほかの記憶に広がらない形にしてある。
const DERIVATIONS_PER_MEMORY = [
  // artifact_kind, artifact_id, source_kind, source_id
  (i) => ['operation_content', operationId(i, 0), 'memory', memoryId(i)],
  (i) => ['operation_content', operationId(i, 1), 'memory', memoryId(i)],
  (i) => ['operation_content', operationId(i, 2), 'memory', memoryId(i)],
  (i) => [
    'notification_candidate',
    derivedId('candidate', i, 0),
    'memory',
    memoryId(i),
  ],
  (i) => [
    'notification_candidate',
    derivedId('candidate', i, 1),
    'memory',
    memoryId(i),
  ],
  (i) => [
    'related_analysis',
    derivedId('related', i, 0),
    'memory',
    memoryId(i),
  ],
  (i) => ['async_guard', derivedId('guard', i, 0), 'memory', memoryId(i)],
  (i) => ['async_guard', derivedId('guard', i, 1), 'memory', memoryId(i)],
  (i) => ['async_guard', derivedId('guard', i, 2), 'memory', memoryId(i)],
  (i) => ['canvas_item', derivedId('canvas', i, 0), 'memory', memoryId(i)],
  (i) => ['canvas_item', derivedId('canvas', i, 1), 'memory', memoryId(i)],
  (i) => ['request_entity', derivedId('request', i, 0), 'memory', memoryId(i)],
  (i) => ['session_summary', sessionId(i), 'memory', memoryId(i)],
  (i) => ['intent_shadow', derivedId('shadow', i, 0), 'turn', turnId(i)],
  (i) => ['intent_shadow', derivedId('shadow', i, 1), 'turn', turnId(i)],
  (i) => ['intent_shadow', derivedId('shadow', i, 2), 'turn', turnId(i)],
  (i) => [
    'carried_summary',
    derivedId('carried', i, 0),
    'notification_candidate',
    derivedId('candidate', i, 0),
  ],
  (i) => [
    'carried_summary',
    derivedId('carried', i, 1),
    'notification_candidate',
    derivedId('candidate', i, 1),
  ],
  (i) => [
    'notification_candidate',
    derivedId('candidate', i, 2),
    'related_analysis',
    derivedId('related', i, 0),
  ],
  (i) => [
    'related_analysis',
    derivedId('related', i, 1),
    'operation_content',
    operationId(i, 0),
  ],
  (i) => [
    'operation_content',
    operationId(i, 3),
    'async_guard',
    derivedId('guard', i, 0),
  ],
  (i) => [
    'carried_summary',
    derivedId('carried', i, 2),
    'canvas_item',
    derivedId('canvas', i, 0),
  ],
  (i) => ['related_analysis', derivedId('related', i, 2), 'turn', turnId(i)],
];

const expectedEdges = (memories) => memories * EDGES_PER_MEMORY;

// 定義どうしのずれを、DB を作る前に落とす（辺の数は手で決めた値）。
if (DERIVATIONS_PER_MEMORY.length + 2 !== EDGES_PER_MEMORY)
  throw new Error(
    `1 記憶あたりの辺の定義が ${DERIVATIONS_PER_MEMORY.length + 2} で、${EDGES_PER_MEMORY} ではありません`,
  );
for (const scale of SCALES)
  if (expectedEdges(scale.memories) !== scale.lineageEdges)
    throw new Error(
      `${scale.id} の辺の数が ${expectedEdges(scale.memories)} で、${scale.lineageEdges} ではありません`,
    );

// --- 合成の DB ---

function seedDatabase(path, scale) {
  const db = openWriteConnection(path, { platform: storagePlatform() });
  try {
    applyMigrations(db);
    initStoreGeneration(db, randomUUID());
    const insertBlob = db.prepare(
      `INSERT INTO sealed_blobs
         (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at)
       VALUES (?, ?, ?, ?, 0, 1, 'benchmark', ?, ?, ?, ?, NULL)`,
    );
    const insertSession = db.prepare(
      `INSERT INTO sessions
         (session_id, storage_mode, display_device_id, route_revision, summary_blob_id, created_at, ended_at)
       VALUES (?, 'normal', NULL, 0, NULL, ?, NULL)`,
    );
    const insertTurn = db.prepare(
      `INSERT INTO turns
         (turn_id, session_id, role, input_kind, text_blob_id, created_at, expires_at)
       VALUES (?, ?, 'user', 'text', NULL, ?, ?)`,
    );
    const insertMemory = db.prepare(
      `INSERT INTO memories
         (memory_id, origin, kind, text_blob_id, target_key_blob_id, target_key_hash, dedupe_key, status, created_at, review_at, delete_at)
       VALUES (?, 'explicit_request', 'preference', ?, ?, ?, ?, 'active', ?, ?, NULL)`,
    );
    const insertMemorySource = db.prepare(
      `INSERT INTO memory_sources (memory_id, source_kind, source_id) VALUES (?, ?, ?)`,
    );
    const insertDerivation = db.prepare(
      `INSERT INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertOperation = db.prepare(
      `INSERT INTO operations
         (operation_id, workflow_id, kind, effect_route, current_content_version, state, state_revision, created_at, completed_at)
       VALUES (?, NULL, 'memory_save', 'local_command', 1, 'succeeded', 1, ?, ?)`,
    );
    const blob = (id, purpose, ownerId, index) => {
      // nonce は 12 バイトで一意（同じ鍵で使い回さない）。
      const nonce = Buffer.from(sha256hex(`${id}:nonce`), 'hex').subarray(
        0,
        12,
      );
      insertBlob.run(
        id,
        purpose,
        'memories',
        ownerId,
        nonce,
        Buffer.from(id, 'utf8'),
        Buffer.from(sha256hex(`${id}:tag`), 'hex').subarray(0, 16),
        CREATED_AT + index,
      );
    };
    db.transaction(() => {
      for (let i = 0; i < scale.memories; i += 1) {
        const createdAt = CREATED_AT + i * 60_000;
        insertSession.run(sessionId(i), createdAt);
        insertTurn.run(
          turnId(i),
          sessionId(i),
          createdAt,
          createdAt + 30 * DAY_MS,
        );
        blob(textBlobId(i), 'memory_text', memoryId(i), i);
        blob(targetBlobId(i), 'memory_target_key', memoryId(i), i);
        insertMemory.run(
          memoryId(i),
          textBlobId(i),
          targetBlobId(i),
          sha256hex(`target-${i}`),
          sha256hex(`content-${i}`),
          createdAt,
          createdAt + 90 * DAY_MS,
        );
        // 由来: 発言と元情報（1 記憶あたり 2 辺）。
        insertMemorySource.run(memoryId(i), 'turn', turnId(i));
        insertMemorySource.run(memoryId(i), 'source_item', sourceItemId(i));
        for (const edge of DERIVATIONS_PER_MEMORY) {
          const [artifactKind, artifact, sourceKind, source] = edge(i);
          insertDerivation.run(
            artifactKind,
            artifact,
            sourceKind,
            source,
            createdAt,
          );
        }
        // 記憶の操作の確定内容は、ふつう成功して終わっている（閉包では暗号文を消す側）。
        for (let slot = 0; slot < 4; slot += 1)
          insertOperation.run(operationId(i, slot), createdAt, createdAt + 1);
      }
    })();
    const counts = {
      memories: db.prepare('SELECT count(*) FROM memories').pluck().get(),
      derivations: db.prepare('SELECT count(*) FROM derivations').pluck().get(),
      memory_sources: db
        .prepare('SELECT count(*) FROM memory_sources')
        .pluck()
        .get(),
      operations: db.prepare('SELECT count(*) FROM operations').pluck().get(),
      sessions: db.prepare('SELECT count(*) FROM sessions').pluck().get(),
      turns: db.prepare('SELECT count(*) FROM turns').pluck().get(),
    };
    const edges = counts.derivations + counts.memory_sources;
    if (counts.memories !== scale.memories)
      throw new Error(`記憶の数が違います: ${counts.memories}`);
    if (edges !== expectedEdges(scale.memories))
      throw new Error(`系譜の辺の数が違います: ${edges}`);
    if (edges !== scale.lineageEdges)
      throw new Error(`系譜の辺の数が規模の定義と違います: ${edges}`);
    return counts;
  } finally {
    db.close();
  }
}

// --- 計測の道具 ---

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

const round = (value) => Math.round(value * 10) / 10;

function forgetPlanFor(value, target) {
  const planned = planForget({
    target,
    instruction_turn_id: null,
    executing_operation_id: null,
    graph: value.graph,
    sourceHmac,
  });
  if (!planned.ok)
    throw new Error(`計画を作れません: ${planned.reasons.join(', ')}`);
  return planned.plan;
}

// 対象の記憶の由来（発言・元情報）の HMAC。applyForget は origins の HMAC を要求する。
function hmacsFor(index) {
  return [
    {
      source_kind: 'turn',
      source_id: turnId(index),
      hmac: benchmarkHmac({ source_kind: 'turn', source_id: turnId(index) }),
    },
    {
      source_kind: 'source_item',
      source_id: sourceItemId(index),
      hmac: benchmarkHmac({
        source_kind: 'source_item',
        source_id: sourceItemId(index),
      }),
    },
  ];
}

const memoryTarget = (index) => ({
  source_kind: 'memory',
  source_id: memoryId(index),
});

// --- 第 1 段: 製品のコードを同じプロセスで動かし、transaction の所要時間を測る ---

function measureInProcess(path, scale) {
  const db = openWriteConnection(path, { platform: storagePlatform() });
  const context = { platform: storagePlatform(), halted: false };
  let nextIndex = 0;
  let phase = 'read';
  const reads = [];
  const plans = [];
  const applies = [];
  const deletedNodes = [];
  try {
    // 温め（JIT・ページキャッシュ）。
    const warm = executeMemoryOp(
      db,
      { kind: 'forget.graph', target: memoryTarget(nextIndex) },
      context,
    );
    if (!warm.result.ok) throw new Error('forget.graph が拒否されました');
    for (let n = 0; n < scale.readSamples; n += 1) {
      const target = memoryTarget(nextIndex + n);
      const started = nowMs();
      const result = executeMemoryOp(
        db,
        { kind: 'forget.graph', target },
        context,
      );
      reads.push(nowMs() - started);
      if (!result.result.ok)
        throw new Error(
          `forget.graph が拒否されました: ${result.result.reasons.join(', ')}`,
        );
      const planned = nowMs();
      forgetPlanFor(result.result.value, target);
      plans.push(nowMs() - planned);
    }
    nextIndex += scale.readSamples;
    // 適用（1 回ごとに別の記憶を忘れる）。
    phase = 'apply';
    for (let n = 0; n < scale.applySamples; n += 1) {
      const index = nextIndex + n;
      const target = memoryTarget(index);
      const before = executeMemoryOp(
        db,
        { kind: 'forget.graph', target },
        context,
      );
      if (!before.result.ok) throw new Error('forget.graph が拒否されました');
      const plan = forgetPlanFor(before.result.value, target);
      const started = nowMs();
      const result = executeMemoryOp(
        db,
        {
          kind: 'forget.apply',
          target,
          instruction_turn_id: null,
          plan,
          source_hmacs: hmacsFor(index),
          entry_id: randomUUID(),
          previous_generation: before.result.value.forgetting_generation,
          new_ledger_id: randomUUID(),
          now: NOW,
        },
        context,
      );
      applies.push(nowMs() - started);
      if (!result.result.ok)
        throw new Error(
          `forget.apply が拒否されました: ${result.result.reasons.join(', ')}`,
        );
      deletedNodes.push(
        Object.values(result.result.value.deleted).reduce(
          (sum, count) => sum + count,
          0,
        ),
      );
    }
    nextIndex += scale.applySamples;
  } catch (error) {
    throw withPhase(error, phase);
  } finally {
    db.close();
  }
  return { reads, plans, applies, deletedNodes, nextIndex };
}

// --- 第 2 段: DB worker を通す経路で、メインのイベントループ遅延を同時に測る ---

// 遅延 p99 は、その区間のヒストグラム（10 ms ごとの標本）から求める。標本の数も残し、少ない標本の p99 を
// 過信しないようにする（5 回の忘却なら、止まった回数と標本の数の両方が分かる必要がある）。
async function measureThroughWorker(path, scale, firstIndex) {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  // 適用の往復だけの区間（メインスレッドは待つだけ）を測る別のヒストグラム。
  const applyHistogram = monitorEventLoopDelay({ resolution: 10 });
  applyHistogram.enable();
  const client = await DbWorkerClient.start({
    path,
    platform: storagePlatform(),
  });
  const reads = [];
  const plans = [];
  const applies = [];
  const flowPlans = [];
  const flows = [];
  const deletedNodes = [];
  const stages = {};
  let nextIndex = firstIndex;
  const readStage = async (name, run) => {
    histogram.reset();
    try {
      const value = await run();
      stages[name] = {
        p99_ms: round(histogram.percentile(99) / 1e6),
        max_ms: round(histogram.max / 1e6),
        samples: histogram.count,
      };
      return value;
    } catch (error) {
      throw withPhase(error, name);
    }
  };
  try {
    // 何もしないときの床（Windows のタイマーの粒度を含む）。
    await readStage(
      'idle',
      () => new Promise((resolve) => setTimeout(resolve, 1_000)),
    );
    // 温め。
    {
      const target = memoryTarget(nextIndex);
      const warm = await client.memory({ kind: 'forget.graph', target });
      if (!warm.ok) throw new Error('forget.graph が拒否されました（worker）');
    }
    await readStage('read', async () => {
      for (let n = 0; n < scale.readSamples; n += 1) {
        const target = memoryTarget(nextIndex + n);
        const started = nowMs();
        const result = await client.memory({ kind: 'forget.graph', target });
        reads.push(nowMs() - started);
        if (!result.ok)
          throw new Error(
            `forget.graph が拒否されました: ${result.reasons.join(', ')}`,
          );
      }
      nextIndex += scale.readSamples;
    });
    // 計画だけを、取った系譜に対してメインスレッドで測る（await を挟まない）。
    {
      const target = memoryTarget(nextIndex);
      const fetched = await client.memory({ kind: 'forget.graph', target });
      if (!fetched.ok) throw new Error('forget.graph が拒否されました');
      await readStage('plan', async () => {
        for (let n = 0; n < scale.readSamples; n += 1) {
          const started = nowMs();
          forgetPlanFor(fetched.value, target);
          plans.push(nowMs() - started);
          // 同期の計画の後でタイマーを 1 回発火させ、遅れをヒストグラムに載せる。
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      });
    }
    // 忘却 1 回の流れ（系譜の読み → 計画 → 適用）。判定の対象はこの区間の遅延。
    await readStage('forget', async () => {
      for (let n = 0; n < scale.applySamples; n += 1) {
        const index = nextIndex + n;
        const target = memoryTarget(index);
        const flowStarted = nowMs();
        const graph = await client.memory({ kind: 'forget.graph', target });
        if (!graph.ok)
          throw new Error(
            `forget.graph が拒否されました: ${graph.reasons.join(', ')}`,
          );
        const planStarted = nowMs();
        const plan = forgetPlanFor(graph.value, target);
        const applyStarted = nowMs();
        flowPlans.push(applyStarted - planStarted);
        // 適用の往復だけの区間も別に測る（メインスレッドは待つだけ。ほかの遅延の原因と混ぜない）。
        applyHistogram.reset();
        const result = await client.memory({
          kind: 'forget.apply',
          target,
          instruction_turn_id: null,
          plan,
          source_hmacs: hmacsFor(index),
          entry_id: randomUUID(),
          previous_generation: graph.value.forgetting_generation,
          new_ledger_id: randomUUID(),
          now: NOW,
        });
        applies.push(nowMs() - applyStarted);
        flows.push(nowMs() - flowStarted);
        const window = {
          p99_ms: round(applyHistogram.percentile(99) / 1e6),
          max_ms: round(applyHistogram.max / 1e6),
          samples: applyHistogram.count,
        };
        deletedNodes.push(
          Object.values(result.value.deleted).reduce(
            (sum, count) => sum + count,
            0,
          ),
        );
        if (!result.ok)
          throw new Error(
            `forget.apply が拒否されました: ${result.reasons.join(', ')}`,
          );
        stages['apply_only'] = stages['apply_only'] ?? [];
        stages['apply_only'].push(window);
      }
      nextIndex += scale.applySamples;
    });
  } finally {
    histogram.disable();
    applyHistogram.disable();
    await client.close();
  }
  return {
    reads,
    plans,
    applies,
    flowPlans,
    flows,
    deletedNodes,
    stages,
    nextIndex,
  };
}
// --- 実行 ---

function environment() {
  const cpu = cpus()[0];
  return {
    platform: `${osPlatform()} ${release()}`,
    arch: process.arch,
    cpu: cpu?.model ?? 'unknown',
    cpu_count: cpus().length,
    memory_gb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
  };
}

function line(label, value, unit = '') {
  return `${label}: ${value}${unit}`;
}

function summarize(measurement) {
  return {
    read_median_ms: round(median(measurement.reads)),
    read_samples_ms: measurement.reads.map(round),
    plan_median_ms: round(median(measurement.plans)),
    plan_samples_ms: measurement.plans.map(round),
    apply_median_ms: round(median(measurement.applies)),
    apply_samples_ms: measurement.applies.map(round),
    deleted_nodes: measurement.deletedNodes,
  };
}

// 規模に耐えない（例外）場合も、どの段で止まったかを残す。
function withPhase(error, phase) {
  if (error instanceof Error && error.benchmarkPhase === undefined)
    error.benchmarkPhase = phase;
  return error;
}

function describeError(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    phase: error instanceof Error ? (error.benchmarkPhase ?? null) : null,
  };
}

function failedVerdict(scale, reason) {
  const limit = LIMITS[scale.id];
  return {
    apply_limit_ms: limit.apply_ms,
    apply_ms: null,
    apply_ok: false,
    event_loop_p99_limit_ms: limit.event_loop_p99_ms,
    event_loop_p99_ms: null,
    event_loop_ok: false,
    apply_only_max_ms: null,
    pass: false,
    spirit_ok: false,
    reason,
  };
}

// 判定に使う遅延は、忘却 1 回の流れ（系譜の読み・計画・適用）の区間の p99。メインスレッドが止まる原因
// （系譜の復号化・計画・往復の待ち）をすべて含む。内訳は stages に残す。
// p99 だけでは、忘却の回数が少ない区間に 1 回だけある長い停止が薄まる（10 倍では 3 回の 2.4 秒の停止が
// 標本の 0.4% になり、p99 に出ない）。同じ区間の最大も併記し、判定の理由に使う。
function judge(scale, inProcess, worker) {
  const limit = LIMITS[scale.id];
  const applyMs = inProcess?.apply_median_ms ?? null;
  const flow = worker?.stages?.forget ?? null;
  const applyOnly = worker?.stages?.apply_only ?? [];
  const eventLoopP99 = flow?.p99_ms ?? null;
  const eventLoopMax = flow?.max_ms ?? null;
  const applyOk = applyMs !== null && applyMs <= limit.apply_ms;
  const p99Ok =
    eventLoopP99 !== null && eventLoopP99 <= limit.event_loop_p99_ms;
  const maxOk =
    eventLoopMax !== null && eventLoopMax <= limit.event_loop_p99_ms;
  return {
    apply_limit_ms: limit.apply_ms,
    apply_ms: applyMs,
    apply_ok: applyOk,
    event_loop_p99_limit_ms: limit.event_loop_p99_ms,
    event_loop_p99_ms: eventLoopP99,
    event_loop_ok: p99Ok,
    // 同じ区間の最大（1 回の忘却の間の、いちばん長い停止）。
    event_loop_max_ms: eventLoopMax,
    event_loop_max_ok: maxOk,
    // 参考: 適用の往復だけの区間の最大（メインスレッドは待つだけ）。
    apply_only_max_ms: applyOnly.length
      ? round(Math.max(...applyOnly.map((window) => window.max_ms)))
      : null,
    // 合格は本人の基準のとおり（適用の中央値と p99）。最大は理由の説明に使う。
    pass: applyOk && p99Ok,
    // 1 回の忘却でも 50 ms を超えて止まっていれば、基準の趣旨は満たさない。
    spirit_ok: applyOk && p99Ok && maxOk,
  };
}

async function runScale(scale, directory) {
  const path = join(directory, `buddy-${scale.id}.sqlite`);
  console.log(`\n=== ${scale.label}（${scale.id}）===`);
  const seedStarted = nowMs();
  const counts = seedDatabase(path, scale);
  console.log(
    `合成の DB: 記憶 ${counts.memories}・系譜の辺 ${counts.derivations + counts.memory_sources}（derivations ${counts.derivations} + memory_sources ${counts.memory_sources}）・操作 ${counts.operations}・会話 ${counts.sessions}・発言 ${counts.turns}（作るのに ${round(nowMs() - seedStarted)} ms）`,
  );
  // 製品のコードが規模に耐えない場合（例外）も、ほかの規模の結果を出せるようにして記録する。
  let inProcess = null;
  let inProcessError = null;
  try {
    inProcess = measureInProcess(path, scale);
  } catch (error) {
    inProcessError = describeError(error);
    console.log(
      `  同じプロセス（worker と同じコード）: 測定できません（${inProcessError.phase ?? '不明'}: ${inProcessError.name}: ${inProcessError.message}）`,
    );
  }
  const inProcessSummary = inProcess === null ? null : summarize(inProcess);
  if (inProcessSummary !== null) {
    console.log(
      line(
        '  同じプロセス（worker と同じコード）: 系譜の全件読みの中央値',
        inProcessSummary.read_median_ms,
        ' ms',
      ),
    );
    console.log(
      line(
        '  同じプロセス: 計画（planForget）の中央値',
        inProcessSummary.plan_median_ms,
        ' ms',
      ),
    );
    console.log(
      line(
        '  同じプロセス: forget.apply の transaction の中央値',
        inProcessSummary.apply_median_ms,
        ' ms',
      ),
    );
    console.log(
      line(
        '  同じプロセス: 1 回の忘却で消した行の数',
        inProcessSummary.deleted_nodes.join(', '),
      ),
    );
  }
  let worker = null;
  let workerError = null;
  try {
    worker = await measureThroughWorker(
      path,
      scale,
      inProcess === null ? 0 : inProcess.nextIndex,
    );
  } catch (error) {
    workerError = describeError(error);
    console.log(
      `  DB worker 経由: 測定できません（${workerError.phase ?? '不明'}: ${workerError.name}: ${workerError.message}）`,
    );
  }
  const workerSummary = worker === null ? null : summarize(worker);
  if (workerSummary !== null) {
    console.log(
      line(
        '  DB worker 経由: forget.graph の往復の中央値',
        workerSummary.read_median_ms,
        ' ms',
      ),
    );
    console.log(
      line(
        '  DB worker 経由: 計画の中央値',
        workerSummary.plan_median_ms,
        ' ms',
      ),
    );
    console.log(
      line(
        '  DB worker 経由: forget.apply の往復の中央値',
        workerSummary.apply_median_ms,
        ' ms',
      ),
    );
    console.log(
      line(
        '  DB worker 経由: 忘却 1 回（読み・計画・適用）の中央値',
        round(median(worker.flows)),
        ' ms',
      ),
    );
    for (const [stage, value] of Object.entries(worker.stages)) {
      if (stage === 'apply_only') {
        const worst = value.length
          ? Math.max(...value.map((window) => window.max_ms))
          : 0;
        console.log(
          `  メインのイベントループ遅延（適用の往復だけ）: 最大 ${round(worst)} ms（${value.length} 区間）`,
        );
        continue;
      }
      console.log(
        `  メインのイベントループ遅延 p99（${stage}）: ${value.p99_ms} ms（最大 ${value.max_ms} ms、標本 ${value.samples}）`,
      );
    }
  }
  const verdict =
    workerSummary !== null
      ? {
          ...judge(scale, inProcessSummary, worker),
          ...(inProcessSummary === null
            ? {
                reason:
                  `同じプロセス（メインスレッド）では系譜の全件読みが例外で止まりました（${inProcessError.name}: ${inProcessError.message}）。` +
                  `worker 経由では読めましたが、忘却 1 回の流れは ${round(median(worker.flows))} ms、最大停止 ${worker.stages.forget?.max_ms ?? '測定不能'} ms です`,
              }
            : {}),
        }
      : failedVerdict(
          scale,
          `DB worker 経由の計測が例外で止まりました（${workerError.name}: ${workerError.message}）`,
        );
  console.log(
    `  判定: apply ${verdict.apply_ms ?? '測定不能'} ms / 基準 ${verdict.apply_limit_ms} ms → ${verdict.apply_ok ? '内' : '超過'}、` +
      `イベントループ p99 ${verdict.event_loop_p99_ms ?? '測定不能'} ms / 基準 ${verdict.event_loop_p99_limit_ms} ms → ${verdict.event_loop_ok ? '内' : '超過'}、` +
      `最大停止 ${verdict.event_loop_max_ms ?? '測定不能'} ms、` +
      `${verdict.pass ? '合格' : '不合格'}${verdict.reason === undefined ? '' : `（${verdict.reason}）`}`,
  );
  rmSync(path, { force: true });
  for (const suffix of ['-wal', '-shm'])
    rmSync(`${path}${suffix}`, { force: true });
  return {
    scale: {
      id: scale.id,
      label: scale.label,
      memories: scale.memories,
      lineage_edges: counts.derivations + counts.memory_sources,
    },
    in_process: inProcessSummary,
    in_process_error: inProcessError,
    worker:
      workerSummary === null
        ? null
        : {
            ...workerSummary,
            stages: worker.stages,
            flow_median_ms: round(median(worker.flows)),
          },
    worker_error: workerError,
    verdict,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex === -1 ? null : args[onlyIndex + 1];
  const printJson = args.includes('--json');
  const selected =
    only === null ? SCALES : SCALES.filter((scale) => scale.id === only);
  if (selected.length === 0)
    throw new Error(
      `不明な規模です: ${only}（${SCALES.map((s) => s.id).join(', ')}）`,
    );
  const environmentInfo = environment();
  console.log(
    '系譜の全件読みの実測（ADR 0054 U110。合成データ・Windows の模擬）',
  );
  console.log(`環境: ${JSON.stringify(environmentInfo)}`);
  const directory = mkdtempSync(join(tmpdir(), 'buddy-lineage-benchmark-'));
  const results = [];
  try {
    for (const scale of selected)
      results.push(await runScale(scale, directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  console.log('\nまとめ（合格の基準は本人の決定 2026-11-01）');
  for (const result of results) {
    console.log(
      `  ${result.scale.label}: 記憶 ${result.scale.memories}・辺 ${result.scale.lineage_edges} / ` +
        `適用 transaction ${result.in_process?.apply_median_ms ?? '測定不能'} ms（基準 ${result.verdict.apply_limit_ms} ms） / ` +
        `読みの中央値 ${result.in_process?.read_median_ms ?? '測定不能'} ms / ` +
        `イベントループ p99 ${result.verdict.event_loop_p99_ms ?? '測定不能'} ms・最大 ${result.verdict.event_loop_max_ms ?? '測定不能'} ms（基準 50 ms） / ` +
        `${result.verdict.pass ? '合格' : '不合格'}${result.verdict.spirit_ok === false && result.verdict.pass ? '（最大が基準を超える）' : ''}`,
    );
  }
  if (printJson)
    console.log(
      `\n${JSON.stringify({ environment: environmentInfo, results }, null, 2)}`,
    );
}

await main();
