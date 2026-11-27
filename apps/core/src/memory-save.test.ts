// 本人の明示の依頼の記憶（memory_save・memory_correct）の Core の経路（ADR 0191）。createTurnRoutes を一時ディレクトリの
// DB worker に直接つなぎ、解釈は決まった意図を返す偽物にする。台帳の鍵は試験用の 32 バイト、データ鍵は試験用の鍵。
// 期待値（返事の文・状態・行数・本文）は ADR 0191 の決めから手で書いた値で、実装の関数から作っていない。模擬の試験だけ。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { MemoryListRow, MemoryOp } from '@buddy/storage';
import { sharedApiContract } from './api-test-support.js';
import { createTurnRoutes } from './api-turns.js';
import type { TurnRouteStore, TurnRoutes } from './api-turns.js';
import { API_ROUTES } from './api-routes.js';
import type { ApiHandlerRequest } from './api-server.js';
import { withBudgetStore } from './budget-test-support.js';
import type { BudgetHarness } from './budget-test-support.js';
import { DATA_KEY_MATERIAL } from './event-test-support.js';
import { planExplicitMemory } from './memory-save.js';
import { PreviewRegistry } from './previews.js';
import { openSealedText } from './sealed-text.js';
import { TEST_TURN_POLICY } from './turn-ports.js';
import type { Interpreter } from './turn-ports.js';
import { A, DEV_A, SCOPE_A } from './voice-rig-test-support.js';

const contract = sharedApiContract();
const CLOCK = new Date('2026-10-05T09:00:00+09:00');
const LEDGER_KEY = new Uint8Array(32).fill(0x4c);

const NO_ARGS = {
  target_candidate_id: null,
  start: null,
  end: null,
  due: null,
  title: null,
  body: null,
  subject: null,
  add_labels: null,
  remove_labels: null,
  task_change: null,
  memory_kind: null,
  query: null,
  device_name: null,
} as const;

// 手で書いた返事の文（ADR 0191）。
const SAVED_PREFERENCE =
  '「好み」の記憶として覚えました。「記憶と忘却」の欄で確かめられます。';
const SAVED_GOAL =
  '「目標」の記憶として覚えました。「記憶と忘却」の欄で確かめられます。';
const NOT_ALLOWED_PREFERENCE =
  '覚えませんでした。「好み」の記憶は、保存してよい記憶の種類で許可されていません。「保存してよい記憶の種類」の欄で変えられます。';
const DUPLICATE = '同じ内容をすでに覚えています。新しくは保存しませんでした。';
const KIND_MISSING =
  '覚えませんでした。どの種類の記憶か分かりませんでした。好み・目標・人・習慣・言葉の使い方・進み具合のどれに当たるかが分かるように、言い換えてください。';
const TOO_LONG = '覚えませんでした。覚える内容は 80 文字までにしてください。';
const HIDDEN =
  '覚えませんでした。覚える内容に、画面に見えない文字が含まれています。';
const NOT_READY =
  '覚えませんでした。中枢が今は記憶を保存できません（バックアップの設定がまだのときも保存しません）。';
const SETTINGS_CHANGED =
  '覚えませんでした。保存してよい記憶の種類の設定が、受け付けている間に変わりました。もう一度お願いします。';
const CORRECTED_GATE_CLOSED =
  '新しい内容を「好み」の記憶として覚えました。古い記憶は残っています。古い記憶を忘れる操作は、まだ使えません（「記憶と忘却」の欄で記憶を見ることはできます）。';
const CORRECTED_GATE_OPEN =
  '新しい内容を「好み」の記憶として覚えました。古い記憶は残っています。古い記憶は「記憶と忘却」の欄で選び、忘却の計画を確かめてから忘れてください。';
const UNSUPPORTED = 'その依頼にはまだ対応していません。';

interface Said {
  intent: string;
  body: string | null;
  memory_kind: string | null;
  // 解釈が返す、本人の発言の中の対象の候補（memory_correct では使わないことを確かめる）。
  target_candidate_id?: string | null;
  // 本人の発言。省略は「「本文」を覚えて」（記憶の本文は発言にそのまま含まれるときだけ保存する）。
  utterance?: string;
}

interface Rig {
  readonly harness: BudgetHarness;
  readonly routes: TurnRoutes;
  readonly sessionId: string;
  readonly said: Said;
  readonly interpretCalls: () => number;
}

async function withMemoryRoutes(
  options: {
    readonly ledgerKey?: () => Promise<Uint8Array | null>;
    readonly forgetGate?: boolean;
    readonly memory?: false;
    // 保存層の memory の口を差し替える（処理の間に設定を変える試験）。
    readonly wrapMemory?: (harness: BudgetHarness) => TurnRouteStore['memory'];
  },
  body: (rig: Rig) => Promise<void>,
): Promise<void> {
  await withBudgetStore(async (harness) => {
    harness.sql((db) => {
      db.prepare(
        `INSERT INTO devices VALUES (?, '合成の端末', 'macos', 0, X'${'a'.repeat(64)}', 1000, NULL, NULL)`,
      ).run(DEV_A);
    });
    const said: Said = {
      intent: 'memory_save',
      body: '返信は短めが好み',
      memory_kind: 'preference',
    };
    let calls = 0;
    const interpreter: Interpreter = {
      interpret: () => {
        calls += 1;
        return Promise.resolve({
          kind: 'intent',
          intent: said.intent,
          args: {
            ...NO_ARGS,
            body: said.body,
            memory_kind: said.memory_kind,
            target_candidate_id: said.target_candidate_id ?? null,
          },
        });
      },
    };
    const memoryPort = options.wrapMemory?.(harness);
    const store: TurnRouteStore =
      memoryPort === undefined
        ? harness.store
        : new Proxy(harness.store, {
            get(target, property) {
              if (property === 'memory') return memoryPort;
              const value: unknown = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
    const routes = createTurnRoutes({
      store,
      keyStore: {
        loadDataKey: () =>
          Promise.resolve({ ok: true as const, dataKey: DATA_KEY_MATERIAL }),
      },
      interpreter,
      provider: null,
      candidates: { mailCandidates: () => Promise.resolve([]) },
      policy: TEST_TURN_POLICY,
      previews: new PreviewRegistry(),
      storage: {
        mode: 'normal',
        origin: () => ({ segment_id: 'gate', segment_generation: '1' }),
      },
      utcOffset: '+09:00',
      now: () => CLOCK.getTime(),
      ...(options.memory === false
        ? {}
        : {
            memory: {
              ledgerKey:
                options.ledgerKey ?? (() => Promise.resolve(LEDGER_KEY)),
              forgetGate: () => options.forgetGate ?? false,
            },
          }),
    });
    const route = API_ROUTES.find(
      (entry) => entry.operationId === 'createSession',
    );
    assert(route !== undefined);
    const created = await routes.handlers['createSession']?.({
      route,
      device: A,
      body: {
        request_id: randomUUID(),
        command_scope_id: SCOPE_A,
        storage_mode: 'normal',
      },
      params: {},
      remoteAddress: '127.0.0.1',
      query: {},
      declaredLockState: 'unlocked',
    });
    assert.equal(created?.status, 201, JSON.stringify(created?.body));
    const sessionId = String(
      (created?.body as { session_id?: unknown }).session_id,
    );
    await body({
      harness,
      routes,
      sessionId,
      said,
      interpretCalls: () => calls,
    });
  });
}

const say = async (
  rig: Rig,
  requestId: string = randomUUID(),
): Promise<Record<string, unknown>> => {
  const route = API_ROUTES.find((entry) => entry.operationId === 'postTurn');
  assert(route !== undefined);
  const request: ApiHandlerRequest = {
    route,
    device: A,
    body: {
      request_id: requestId,
      command_scope_id: SCOPE_A,
      text: rig.said.utterance ?? `「${rig.said.body ?? ''}」を覚えて`,
      input_kind: 'text',
      origin: { segment_id: rig.sessionId, segment_generation: '1' },
    },
    params: { session_id: rig.sessionId },
    remoteAddress: '127.0.0.1',
    query: {},
    declaredLockState: 'unlocked',
  };
  const response = await rig.routes.handlers['postTurn']?.(request);
  assert(response !== undefined);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert(
    contract.valid('TurnResponse', response.body),
    JSON.stringify(response.body),
  );
  return response.body as Record<string, unknown>;
};

const allow = async (
  rig: Rig,
  expected: string,
  kinds: Extract<MemoryOp, { kind: 'memory.settings_set' }>['allowed_kinds'],
) => {
  const changed = await rig.harness.store.memory({
    kind: 'memory.settings_set',
    expected_revision: expected,
    allowed_kinds: kinds,
    now: CLOCK.getTime(),
  });
  assert(changed.ok, JSON.stringify(changed));
};

const count = (rig: Rig, table: string): number =>
  rig.harness.sql(
    (db) => db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number,
  );

// 保存した記憶の本文（データ鍵で開く）・種類・由来。
async function memories(rig: Rig) {
  const listed = await rig.harness.store.memory({
    kind: 'memory.list',
    limit: 1000,
    now: CLOCK.getTime(),
  });
  assert(listed.ok, JSON.stringify(listed));
  const rows = (listed.value as { readonly rows: readonly MemoryListRow[] })
    .rows;
  return rows.map((row) => ({
    kind: row.kind,
    origin: row.origin,
    text:
      row.text === null
        ? null
        : openSealedText(
            DATA_KEY_MATERIAL,
            row.text,
            {
              ownerTable: 'memories',
              ownerId: row.memory_id,
              purpose: 'memory_text',
            },
            80,
          ),
    sources: rig.harness.sql((db) =>
      db
        .prepare(
          'SELECT source_kind, source_id FROM memory_sources WHERE memory_id = ?',
        )
        .all(row.memory_id),
    ),
  }));
}

const viewOf = (body: Record<string, unknown>) =>
  body['result_view'] as Record<string, unknown>;

test(
  'ADR 0191: with the default settings nothing is saved, and after the owner allows a kind the explicit request is saved with the turn as its only source',
  { timeout: 60_000 },
  async () => {
    await withMemoryRoutes({}, async (rig) => {
      // 既定（保存してよい種類が空）: 保存しない。発言は記録する。
      const refused = await say(rig);
      assert.equal(refused['status'], 'answered');
      assert.equal(refused['reply_text'], NOT_ALLOWED_PREFERENCE);
      assert.equal(viewOf(refused)['kind'], 'completion_line');
      assert.equal(viewOf(refused)['status'], 'needs_review');
      assert.equal(viewOf(refused)['intent'], 'memory_save');
      assert.deepEqual(viewOf(refused)['item_refs'], []);
      assert.equal(count(rig, 'memories'), 0);
      assert.equal(count(rig, 'turns'), 1);
      // 承認・操作は作らない。
      assert.equal(count(rig, 'operations'), 0);

      // 好みだけを許可すると保存する。本文は空白をまとめた値、由来はこの発言だけ。
      await allow(rig, '0', ['preference']);
      rig.said.body = '  返信は\n短めが好み  ';
      const requestId = randomUUID();
      const saved = await say(rig, requestId);
      assert.equal(saved['reply_text'], SAVED_PREFERENCE);
      assert.equal(viewOf(saved)['status'], 'ready');
      assert.deepEqual(await memories(rig), [
        {
          kind: 'preference',
          origin: 'explicit_request',
          text: '返信は 短めが好み',
          sources: [{ source_kind: 'turn', source_id: saved['turn_id'] }],
        },
      ]);
      // 応答（平文の列に残る）に記憶の本文を入れない。
      const stored = rig.harness.sql(
        (db) =>
          db
            .prepare('SELECT response_json FROM turn_responses')
            .pluck()
            .all() as string[],
      );
      assert(stored.every((json) => !json.includes('短めが好み')));

      // 同じ要求の再送は保存済みの応答で、解釈し直さず、二度保存しない。
      const calls = rig.interpretCalls();
      const again = await say(rig, requestId);
      assert.deepEqual(again, saved);
      assert.equal(rig.interpretCalls(), calls);
      assert.equal(count(rig, 'memories'), 1);

      // 別の要求で同じ内容: 二重に保存しない。
      const duplicate = await say(rig);
      assert.equal(duplicate['reply_text'], DUPLICATE);
      assert.equal(viewOf(duplicate)['status'], 'ready');
      assert.equal(count(rig, 'memories'), 1);

      // 許可していない種類（目標）は保存しない。
      rig.said.memory_kind = 'goal';
      rig.said.body = '毎週 3 回走る';
      const goal = await say(rig);
      assert.equal(
        goal['reply_text'],
        '覚えませんでした。「目標」の記憶は、保存してよい記憶の種類で許可されていません。「保存してよい記憶の種類」の欄で変えられます。',
      );
      assert.equal(count(rig, 'memories'), 1);
      // 許可を外すと、保存済みの記憶は消さずに、新しい保存だけを止める。
      await allow(rig, '1', []);
      rig.said.memory_kind = 'preference';
      rig.said.body = '朝は紅茶が好み';
      assert.equal((await say(rig))['reply_text'], NOT_ALLOWED_PREFERENCE);
      assert.equal(count(rig, 'memories'), 1);
      // 発言は 5 件（既定の拒否・保存・重複・目標・許可を外した後。再送は数えない）。
      assert.equal(count(rig, 'turns'), 5);
    });
  },
);

test(
  'ADR 0191: the text boundaries, a missing kind, hidden characters and a missing ledger key are answered without saving',
  { timeout: 60_000 },
  async () => {
    let ledger: Uint8Array | null = LEDGER_KEY;
    await withMemoryRoutes(
      { ledgerKey: () => Promise.resolve(ledger) },
      async (rig) => {
        await allow(rig, '0', ['goal']);
        rig.said.memory_kind = 'goal';
        // 81 文字は保存しない。80 文字ちょうどは保存する。
        rig.said.body = 'あ'.repeat(81);
        assert.equal((await say(rig))['reply_text'], TOO_LONG);
        assert.equal(count(rig, 'memories'), 0);
        rig.said.body = 'あ'.repeat(80);
        assert.equal((await say(rig))['reply_text'], SAVED_GOAL);
        assert.equal(count(rig, 'memories'), 1);
        // 種類が分からない。
        rig.said.memory_kind = null;
        rig.said.body = '合成の目標';
        assert.equal((await say(rig))['reply_text'], KIND_MISSING);
        // 書字方向の制御文字を含む本文。
        rig.said.memory_kind = 'goal';
        rig.said.body = '合成‮の目標';
        assert.equal((await say(rig))['reply_text'], HIDDEN);
        // 台帳の鍵がない（バックアップの設定の前）: 鍵を作らずに保存しない。
        ledger = null;
        rig.said.body = '合成の別の目標';
        const notReady = await say(rig);
        assert.equal(notReady['reply_text'], NOT_READY);
        assert.equal(viewOf(notReady)['status'], 'needs_review');
        assert.equal(count(rig, 'memories'), 1);
        assert.equal(count(rig, 'turns'), 5);
      },
    );
  },
);

test(
  'ADR 0191: memory_correct saves the new memory, keeps the old one and says whether the old one can be forgotten (the gate stays closed in the product)',
  { timeout: 60_000 },
  async () => {
    for (const [gate, expected] of [
      [false, CORRECTED_GATE_CLOSED],
      [true, CORRECTED_GATE_OPEN],
    ] as const)
      await withMemoryRoutes({ forgetGate: gate }, async (rig) => {
        await allow(rig, '0', ['preference']);
        rig.said.body = '返信は長めが好み';
        assert.equal((await say(rig))['reply_text'], SAVED_PREFERENCE);
        rig.said.intent = 'memory_correct';
        rig.said.body = '返信は短めが好み';
        const corrected = await say(rig);
        assert.equal(corrected['reply_text'], expected);
        assert.equal(viewOf(corrected)['intent'], 'memory_correct');
        assert.deepEqual((await memories(rig)).map((row) => row.text).sort(), [
          '返信は短めが好み',
          '返信は長めが好み',
        ]);
      });
  },
);

test(
  'ADR 0191: when the settings change between the check and the save, the storage guard refuses the memory and the turn is recorded with the reason',
  { timeout: 60_000 },
  async () => {
    let race = false;
    await withMemoryRoutes(
      {
        wrapMemory: (harness) => async (op) => {
          const result = await harness.store.memory(op);
          // 検査の材料を読んだ直後に、別の画面で設定が変わった。
          if (race && op.kind === 'memory.admission_facts') {
            race = false;
            const changed = await harness.store.memory({
              kind: 'memory.settings_set',
              expected_revision: '1',
              allowed_kinds: ['preference', 'goal'],
              now: CLOCK.getTime(),
            });
            assert(changed.ok, JSON.stringify(changed));
          }
          return result;
        },
      },
      async (rig) => {
        await allow(rig, '0', ['preference']);
        race = true;
        const requestId = randomUUID();
        const refused = await say(rig, requestId);
        assert.equal(refused['reply_text'], SETTINGS_CHANGED);
        assert.equal(viewOf(refused)['status'], 'needs_review');
        assert.equal(count(rig, 'memories'), 0);
        assert.equal(count(rig, 'turns'), 1);
        // 再送は保存しなかった理由の応答のまま（保存し直さない）。
        assert.deepEqual(await say(rig, requestId), refused);
        assert.equal(count(rig, 'memories'), 0);
        // 次の新しい依頼は今の設定で保存する。
        assert.equal((await say(rig))['reply_text'], SAVED_PREFERENCE);
        assert.equal(count(rig, 'memories'), 1);
      },
    );
  },
);

test(
  'ADR 0191: two concurrent copies of the same request save one memory',
  { timeout: 60_000 },
  async () => {
    await withMemoryRoutes({}, async (rig) => {
      await allow(rig, '0', ['preference']);
      const requestId = randomUUID();
      const [first, second] = await Promise.all([
        say(rig, requestId),
        say(rig, requestId),
      ]);
      assert.deepEqual(first, second);
      assert.equal(first['reply_text'], SAVED_PREFERENCE);
      assert.equal(count(rig, 'memories'), 1);
      assert.equal(count(rig, 'turns'), 1);
    });
  },
);

test(
  'ADR 0191: without the memory port memory_save stays unsupported and nothing is read',
  { timeout: 60_000 },
  async () => {
    await withMemoryRoutes({ memory: false }, async (rig) => {
      await allow(rig, '0', ['preference']);
      const body = await say(rig);
      assert.equal(body['status'], 'clarification');
      assert.equal(body['reply_text'], UNSUPPORTED);
      assert.equal(count(rig, 'memories'), 0);
    });
  },
);

test('ADR 0191: in a private conversation the plan refuses before reading the keys or the store (X59)', async () => {
  let ledgerReads = 0;
  let storeReads = 0;
  const plan = await planExplicitMemory(
    {
      store: {
        memory: () => {
          storeReads += 1;
          return Promise.reject(new Error('must not be read'));
        },
      },
      ledgerKey: () => {
        ledgerReads += 1;
        return Promise.resolve(LEDGER_KEY);
      },
    },
    {
      body: '合成の好み',
      utterance: '「合成の好み」を覚えて',
      memory_kind: 'preference',
      turn_id: randomUUID(),
      private_conversation: true,
      data_key: DATA_KEY_MATERIAL,
    },
  );
  assert.deepEqual(plan, {
    kind: 'not_saved',
    memory_kind: 'preference',
    reason: 'private_conversation',
  });
  assert.equal(ledgerReads, 0);
  assert.equal(storeReads, 0);
});

// ---- 見直し（ADR 0191 の見直し） ----

const NOT_IN_UTTERANCE =
  '覚えませんでした。覚える内容を、言ったとおりの言葉で受け取れませんでした。覚えてほしい言葉をそのまま入れて、言い換えてください。';

test(
  'ADR 0191 review: a body the model paraphrased (not in the utterance) is not saved and the reply does not carry it',
  { timeout: 60_000 },
  async () => {
    await withMemoryRoutes({}, async (rig) => {
      await allow(rig, '0', ['preference']);
      // 本人は「返信は短く」と言ったが、解釈は言い換えた本文を返した。
      rig.said.utterance = '返信は短くしてほしいと覚えて';
      rig.said.body = '返信は簡潔なものが好み';
      const refused = await say(rig);
      assert.equal(refused['reply_text'], NOT_IN_UTTERANCE);
      assert.equal(viewOf(refused)['status'], 'needs_review');
      assert(!JSON.stringify(refused).includes('簡潔'));
      assert.equal(count(rig, 'memories'), 0);
      // 改行・空白の違いは同じ整えで比べる（発言の中にそのまま含まれる）。
      rig.said.utterance = '「返信は\n短めが好み」を覚えて';
      rig.said.body = '返信は 短めが好み';
      assert.equal((await say(rig))['reply_text'], SAVED_PREFERENCE);
      // 本文が発言の一部を縮めた（補った）だけでも、そのまま含まれなければ保存しない。
      rig.said.utterance = '朝はコーヒーを飲むと覚えて';
      rig.said.body = '朝はコーヒーが好き';
      assert.equal((await say(rig))['reply_text'], NOT_IN_UTTERANCE);
      assert.equal(count(rig, 'memories'), 1);
    });
  },
);

test(
  'ADR 0191 review: the mock interpreter keeps the quoted words, so the check passes; a model-style paraphrase does not',
  { timeout: 60_000 },
  async () => {
    const { createMockInterpreter } = await import('./turn-ports.js');
    const mock = createMockInterpreter();
    const reply = await mock.interpret({
      text: '「朝は紅茶」を好みとして覚えて',
      today: '2026-10-05',
      mail_candidates: [],
    });
    assert.equal(reply.kind, 'intent');
    const args = (
      reply as unknown as { args: { body: string; memory_kind: string } }
    ).args;
    assert.deepEqual([args.body, args.memory_kind], ['朝は紅茶', 'preference']);
    const { memoryTextInUtterance } = await import('@buddy/domain');
    assert.equal(
      memoryTextInUtterance(args.body, '「朝は紅茶」を好みとして覚えて'),
      true,
    );
    assert.equal(
      memoryTextInUtterance('朝は紅茶が好み', '「朝は紅茶」を好みとして覚えて'),
      false,
    );
  },
);

test(
  'ADR 0191 review: memory_correct ignores target_candidate_id from the model and keeps the old memory',
  { timeout: 60_000 },
  async () => {
    await withMemoryRoutes({}, async (rig) => {
      await allow(rig, '0', ['preference']);
      rig.said.body = '返信は長めが好み';
      assert.equal((await say(rig))['reply_text'], SAVED_PREFERENCE);
      const before = await memories(rig);
      rig.said.intent = 'memory_correct';
      rig.said.body = '返信は短めが好み';
      // 解釈が対象の候補（メールの候補の形の ID）を返しても、古い記憶を選ぶのは画面の本人だけ。
      rig.said.target_candidate_id = '00000000-0000-4000-8000-0000000000c1';
      const corrected = await say(rig);
      assert.equal(corrected['reply_text'], CORRECTED_GATE_CLOSED);
      const after = await memories(rig);
      assert.equal(after.length, 2);
      // 古い記憶は消えず、変わらない。
      assert(
        after.some(
          (row) =>
            row.text === '返信は長めが好み' &&
            JSON.stringify(row.sources) === JSON.stringify(before[0]?.sources),
        ),
      );
      assert(!JSON.stringify(corrected).includes('0000000000c1'));
    });
  },
);

test('ADR 0191 review: the content and target HMACs match values computed by hand with node:crypto', async () => {
  // 期待値: node:crypto で別に計算した値（HKDF-SHA256(ikm = 0x4c × 32, salt = 空, info = buddy/memory/dedupe/v1, L = 32) の鍵で
  // HMAC-SHA256(用途の名前 ‖ 0x00 ‖ preference ‖ 0x00 ‖ 返信は短めが好み)。由来は info = buddy/ledger/source-id/v1 の鍵で
  // HMAC-SHA256(buddy/ledger/source-id/v1 ‖ 0x00 ‖ turn ‖ 0x00 ‖ 発言 ID)）。
  const turnId = '00000000-0000-4000-8000-0000000000aa';
  const plan = await planExplicitMemory(
    {
      store: {
        memory: (() =>
          Promise.resolve({
            ok: true as const,
            value: {
              settings: {
                allowed_kinds: ['preference'],
                settings_revision: '1',
              },
              forgetting_generation: '0',
              ledger: [],
              existing: [],
            },
          })) as never,
      },
      ledgerKey: () => Promise.resolve(LEDGER_KEY),
      newId: () => '00000000-0000-4000-8000-0000000000bb',
    },
    {
      body: '返信は短めが好み',
      utterance: '「返信は短めが好み」を覚えて',
      memory_kind: 'preference',
      turn_id: turnId,
      private_conversation: false,
      data_key: DATA_KEY_MATERIAL,
    },
  );
  assert.equal(plan.kind, 'save');
  const memory = (plan as Extract<typeof plan, { kind: 'save' }>).memory;
  assert.equal(
    memory.dedupe_key,
    'e62f6454a203d1df229f28e3884f207bb89f8eae5ef76010196c04406ff53c5b',
  );
  assert.equal(
    memory.target_key_hash,
    '3f87b229cb44f2a7af6712c513d8f7eff6f2db9b9c2f812fc49ddd3be8475f98',
  );
  assert.equal(
    memory.source_hmac,
    'c30f51b8119a9debc732900b3cbdeea5c1adc7c2a418bd7f5a2a6e35edc16cb3',
  );
  assert.equal(memory.settings_revision, '1');
  assert.equal(memory.forgetting_generation, '0');
});
