// Live（声）の会話の処理（B05-05、ADR 0052）を、本物の DB worker・VoiceControl・共通の workflow（createTurnRoutes）に
// 組み込んだ模擬試験。サイドバンドの出来事（発話の開始・文字起こしの断片・終了候補・委譲）は模擬の provider から合成して送る。
// 実際の音声・実 API・実機は使わない。時計は手で進める（固定の sleep を使わない）。期待値（行・文・理由・件数）は手で書いた。
// QA41（方式 C の 4 操作）・X46・X47・X49・X51・X58・X27・X36・X59 の一部・QA05・QA35 の Core 側。

import assert from 'node:assert/strict';
import test from 'node:test';
import { uuid } from './budget-test-support.js';
import { createApiContract } from './api-contract.js';
import { API_ROUTES } from './api-routes.js';
import type { ApiHandlerRequest } from './api-server.js';
import { createTurnRoutes } from './api-turns.js';
import type { TurnRoutes } from './api-turns.js';
import { DATA_KEY_MATERIAL } from './event-test-support.js';
import { LiveConversation, createLiveScreenSink } from './live-conversation.js';
import type { ScreenResult } from './live-conversation.js';
import { PreviewRegistry } from './previews.js';
import { TEST_TURN_POLICY, createMockInterpreter } from './turn-ports.js';
import type {
  Interpreter,
  InterpretationContext,
  InterpreterReply,
  ProviderReader,
  TurnPolicy,
} from './turn-ports.js';
import type { VoiceControlOptions } from './voice-control.js';
import {
  A,
  DEV_A,
  SCOPE_A,
  SESSION,
  TIMEOUT,
  bodyOf,
  openLive,
  renew,
  waitUntil,
  withRig,
} from './voice-rig-test-support.js';
import type { Rig } from './voice-rig-test-support.js';
import type { MockSideband } from './voice-test-support.js';

const NOW = Date.parse('2026-10-05T09:00:00+09:00');
const LEASE = uuid(0x1a);

const EMPTY_ARGS = {
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

const intentReply = (
  intent: string,
  args: Record<string, unknown> = {},
  extra: { relation?: string; target_workflow_id?: string } = {},
): InterpreterReply => ({
  kind: 'intent',
  intent,
  args: { ...EMPTY_ARGS, ...args },
  ...extra,
});

// 決まった文に決まった応答を返す解釈（なければ B04 の模擬）。呼ばれた文を記録し、文ごとに応答を保留できる。
class Script implements Interpreter {
  readonly calls: string[] = [];
  readonly replies = new Map<string, InterpreterReply>();
  readonly gates = new Map<string, Promise<void>>();
  readonly #fallback = createMockInterpreter();
  async interpret(context: InterpretationContext): Promise<InterpreterReply> {
    this.calls.push(context.text);
    const gate = this.gates.get(context.text);
    if (gate !== undefined) await gate;
    return (
      this.replies.get(context.text) ??
      (await this.#fallback.interpret(context))
    );
  }
}

// 解釈を保留する門（release で通す）。
function gate(): { promise: Promise<void>; release: () => void } {
  let release = () => undefined as void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// 今日（2026-10-05）の予定が 2 件（重なる）の読み取り専用の provider。
const provider: ProviderReader = {
  connection: () =>
    Promise.resolve({
      provider: 'mock',
      account_id: uuid(2),
      status: 'active',
      access: 'read_write',
    }),
  readPermission: () =>
    Promise.resolve({
      account_id: uuid(2),
      permission_revision: '1',
      scopes: ['mail.read'],
    }),
  readTarget: () => Promise.resolve(null),
  listEvents: () =>
    Promise.resolve([
      {
        event_id: 'ev-1',
        title: '合成の予定1',
        start: '2026-10-05T09:30:00+09:00',
        end: '2026-10-05T10:30:00+09:00',
      },
      {
        event_id: 'ev-2',
        title: '合成の予定2',
        start: '2026-10-05T10:00:00+09:00',
        end: '2026-10-05T11:00:00+09:00',
      },
    ]),
};

const AUTO_TASK: TurnPolicy = {
  ...TEST_TURN_POLICY,
  auto_execution: { ...TEST_TURN_POLICY.auto_execution, create_task: true },
};

interface Heartbeat {
  n: number;
}

interface Conv {
  readonly rig: Rig;
  readonly script: Script;
  readonly turns: TurnRoutes;
  readonly conversation: LiveConversation;
  readonly sb: MockSideband;
  readonly liveId: string;
  readonly shown: ScreenResult[];
  readonly dropped: {
    session_id: string;
    workflow_id: string;
    reason: string;
  }[];
  readonly hb: Heartbeat;
  next: { index: number; start: number };
  // 保存の命令を送る直前（共通の workflow の最後の確認）に呼ぶ（1 回だけ）。保存の直前の再検査の試験で使う。
  readonly hooks: {
    beforeRecord: (() => void) | null;
    // 共通の workflow へ保存を頼む前（保存の準備の間）に待たせる（1 回だけ）。呼ばれたことは entered で分かる。
    beforeCommit: (() => Promise<void>) | null;
    // 保存の命令を送った後（共通の workflow が保存応答を返す前）に待たせる（1 回だけ）。
    afterRecord: (() => Promise<void>) | null;
    // 次の保存の結果を差し替える（1 回だけ）。failed は保存失敗、reject は結果不明（例外）。
    commitFailure: 'failed' | 'reject' | null;
    entered: number;
  };
  // 共通の workflow への保存の結果の種類（ok・held・failed）を、返った順に残す。
  readonly commits: string[];
}

async function withConversation(
  body: (c: Conv) => Promise<void>,
  options: {
    readonly policy?: TurnPolicy;
    readonly prepare?: (script: Script) => void;
    readonly overrides?: Partial<VoiceControlOptions>;
  } = {},
): Promise<void> {
  await withRig(async (rig) => {
    const script = new Script();
    options.prepare?.(script);
    const turns = createTurnRoutes({
      store: rig.harness.store,
      keyStore: {
        loadDataKey: () =>
          Promise.resolve({ ok: true as const, dataKey: DATA_KEY_MATERIAL }),
      },
      interpreter: script,
      provider,
      candidates: { mailCandidates: () => Promise.resolve([]) },
      policy: options.policy ?? TEST_TURN_POLICY,
      previews: new PreviewRegistry(),
      utcOffset: '+09:00',
      now: () => NOW,
      onSessionControl: ({ device_id, action }) =>
        rig.voice.applySessionControlForDevice(device_id, action),
    });
    const hooks: Conv['hooks'] = {
      beforeRecord: null,
      beforeCommit: null,
      afterRecord: null,
      commitFailure: null,
      entered: 0,
    };
    const commits: string[] = [];
    const shown: ScreenResult[] = [];
    const dropped: Conv['dropped'] = [];
    let counter = 0;
    const conversation = new LiveConversation({
      host: rig.voice.conversationHost(),
      turns: {
        interpret: turns.interpret,
        commitLive: async (input) => {
          hooks.entered += 1;
          const wait = hooks.beforeCommit;
          hooks.beforeCommit = null;
          await wait?.();
          const failure = hooks.commitFailure;
          hooks.commitFailure = null;
          if (failure === 'failed') {
            commits.push('failed');
            return { kind: 'failed', status: 503 };
          }
          if (failure === 'reject') {
            commits.push('reject');
            throw new Error('simulated unknown commit result');
          }
          const result = await turns.commitLive({
            ...input,
            precommit: () => {
              const hook = hooks.beforeRecord;
              hooks.beforeRecord = null;
              hook?.();
              return input.precommit();
            },
          });
          const after = hooks.afterRecord;
          hooks.afterRecord = null;
          await after?.();
          commits.push(result.kind);
          return result;
        },
      },
      screen: {
        show: (result) => shown.push(result),
        heldDropped: (info) => dropped.push({ ...info }),
      },
      monoNow: rig.clock.mono,
      timers: rig.clock,
      newId: () => uuid(0x8000 + ++counter),
    });
    rig.voice.setConversation(conversation);
    const liveId = await openLive(rig);
    await body({
      rig,
      script,
      turns,
      conversation,
      sb: rig.provider.last,
      liveId,
      shown,
      dropped,
      hb: { n: 1 },
      next: { index: 0, start: 0 },
      hooks,
      commits,
    });
  }, options.overrides ?? {});
}

// ---- 合成の発話 -----------------------------------------------------------------------------------------------

interface Utterance {
  readonly text: string;
  // 断片を分ける（既定は 1 つ）。
  readonly parts?: readonly string[];
  // 断片の連番を飛ばす・持たない（欠落・時刻の対応の試験）。
  readonly indexes?: readonly (number | null)[];
  readonly speech?: boolean;
  readonly end?: boolean;
}

// 発話の開始 → 断片 → 終了候補。連番と音声内の時刻は Conv が持ち回る。時計は 50 ms ずつ進める。
async function speak(c: Conv, utterance: Utterance): Promise<number> {
  const parts = utterance.parts ?? [utterance.text];
  if (utterance.speech !== false) c.sb.speechStarted();
  await c.rig.clock.advance(50);
  let endMs = c.next.start;
  for (const [position, text] of parts.entries()) {
    const index =
      utterance.indexes === undefined
        ? c.next.index
        : (utterance.indexes[position] ?? null);
    const start = endMs;
    endMs = start + 800;
    c.sb.fragment({ index, start_ms: start, end_ms: endMs, text });
    if (utterance.indexes === undefined) c.next.index += 1;
    else if (typeof index === 'number') c.next.index = index + 1;
    await c.rig.clock.advance(50);
  }
  if (utterance.end !== false) c.sb.endCandidate();
  c.next.start = endMs + 400;
  return endMs;
}

// 委譲を送り、中枢が受け付ける（条件の確認）まで処理を進める。受け付けた時刻が、時計を進める前の値にそろう。
async function delegate(
  c: Conv,
  id: string,
  offset: number | null,
): Promise<void> {
  c.sb.delegation(id, offset);
  await c.rig.wait();
}

// 端末の音声リースの更新とサイドバンドの pong（2 秒ごと）を続けながら時間を進める。
async function beat(c: Conv, ms: number): Promise<void> {
  for (let done = 0; done < ms; done += 2000) {
    await c.rig.clock.advance(Math.min(2000, ms - done));
    c.hb.n += 1;
    c.sb.pong();
    const renewed = await renew(c.rig, A, {
      lease_id: LEASE,
      nonce: `n${c.hb.n}`,
      previous_nonce: `n${c.hb.n - 1}`,
      at: 10 + 2000 * (c.hb.n - 1),
    });
    assert.equal(bodyOf(renewed)['result'], 'renewed', JSON.stringify(renewed));
  }
}

const rows = <T = Record<string, unknown>>(rig: Rig, sql: string): T[] =>
  rig.harness.sql((db) => db.prepare(sql).all() as T[]);

const operations = (rig: Rig) =>
  rows(
    rig,
    'SELECT kind, effect_route, state FROM operations ORDER BY created_at, operation_id',
  );
const snapshots = (rig: Rig) =>
  rows(
    rig,
    'SELECT origin, state, seal_reason, input_evidence, policy_version, audio_epoch FROM input_snapshots ORDER BY rowid',
  );
const turnsOf = (rig: Rig) =>
  rows(rig, 'SELECT input_kind, role FROM turns ORDER BY rowid');
const workflowStates = (rig: Rig) =>
  rows<{ state: string }>(
    rig,
    'SELECT state FROM workflows ORDER BY rowid',
  ).map((row) => row.state);
const liveAudioEpoch = (rig: Rig): number =>
  rows<{ audio_epoch: number }>(rig, 'SELECT audio_epoch FROM live_sessions')[0]
    ?.audio_epoch as number;

const TASK_TEXT = '「牛乳を買う」を用事に登録して';
const FULL_TEXT_SENTENCE =
  'この依頼はまだ実行していません。画面から全文を入力し直してください。';
const SAY_AGAIN_SENTENCE =
  'うまく聞き取れませんでした。もう一度言ってください。';
const SCREEN_SENTENCE = '画面で確認してください。';
const HOLD_DROPPED_SENTENCE =
  '実行前の依頼は実行していません。必要なら、もう一度お願いします。';

const controlEvents = (rig: Rig, type: string) =>
  (rig.events.get(DEV_A) ?? []).filter((event) => event['event_type'] === type);

// ---- QA41: 方式 C の 4 操作 ----------------------------------------------------------------------------------

test(
  'QA41/X51: a complete observation of "create a task" is sealed by the live policy and becomes one awaiting operation, answered by a fixed sentence',
  TIMEOUT,
  async () => {
    await withConversation(
      async (c) => {
        await speak(c, { text: TASK_TEXT });
        await delegate(c, 'd1', 800);
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the commentary',
          () => c.sb.commentary.length === 1,
        );
        assert.deepEqual(c.sb.commentary, [[SCREEN_SENTENCE]]);
        assert.deepEqual(operations(c.rig), [
          {
            kind: 'task.create',
            effect_route: 'local_command',
            state: 'awaiting_approval',
          },
        ]);
        assert.deepEqual(snapshots(c.rig), [
          {
            origin: 'live_fragment',
            state: 'sealed',
            seal_reason: 'live_transcript_policy',
            input_evidence: 'live_policy_observed',
            policy_version: 1,
            audio_epoch: liveAudioEpoch(c.rig),
          },
        ]);
        assert.deepEqual(turnsOf(c.rig), [
          { input_kind: 'voice_live', role: 'user' },
        ]);
        assert.deepEqual(workflowStates(c.rig), ['ready']);
        assert.deepEqual(c.script.calls, [TASK_TEXT]);
        assert.deepEqual(c.shown, []);
        // 同じ委譲の再送は、もう一度扱わない。
        await delegate(c, 'd1', 800);
        await c.rig.clock.advance(500);
        await c.rig.wait();
        assert.deepEqual(c.script.calls, [TASK_TEXT]);
        assert.equal(operations(c.rig).length, 1);
      },
      { policy: AUTO_TASK },
    );
  },
);

test(
  'QA41: when the policy does not allow automatic execution the four-operation input still makes no operation and asks for the full text on screen',
  TIMEOUT,
  async () => {
    await withConversation(async (c) => {
      await speak(c, { text: TASK_TEXT });
      await delegate(c, 'd1', 800);
      await c.rig.clock.advance(500);
      await waitUntil(
        c.rig,
        'the commentary',
        () => c.sb.commentary.length === 1,
      );
      assert.deepEqual(c.sb.commentary, [[FULL_TEXT_SENTENCE]]);
      // 承認の対象は 0。依頼は聞き返しのまま。
      assert.deepEqual(operations(c.rig), []);
      assert.deepEqual(workflowStates(c.rig), ['clarifying']);
    });
  },
);

test(
  'QA41/X59: memory, approval and display-target intents never make an operation from a live transcript, even with a complete observation and an automatic policy',
  TIMEOUT,
  async () => {
    const cases: [string, string, Record<string, unknown>][] = [
      [
        'あしたは歯医者だと覚えておいて',
        'memory_save',
        { body: 'あしたは歯医者' },
      ],
      ['メールを送って', 'send_mail', { body: 'よろしく' }],
      ['そのメールを捨てて', 'trash_mail', { target_candidate_id: uuid(0xc1) }],
      ['予定を動かして', 'update_event', { target_candidate_id: uuid(0xc1) }],
      [
        '用事を完了にして',
        'update_task',
        { target_candidate_id: uuid(0xc1), task_change: 'complete' },
      ],
      ['あれを忘れて', 'memory_forget', { query: 'あれ' }],
      ['こっちの画面に出して', 'handoff_screen', { device_name: '書斎' }],
    ];
    await withConversation(
      async (c) => {
        let answered = 0;
        for (const [index, [text]] of cases.entries()) {
          await speak(c, { text });
          await delegate(c, `d${index}`, c.next.start - 400);
          await c.rig.clock.advance(500);
          answered += 1;
          await waitUntil(
            c.rig,
            `the answer ${answered}`,
            () => c.sb.commentary.length === answered,
          );
        }
        assert.deepEqual(
          c.sb.commentary,
          cases.map(() => [FULL_TEXT_SENTENCE]),
        );
        // 操作・依頼は 0。確定できなかった入力として残る（blocked・unverified）。
        assert.deepEqual(operations(c.rig), []);
        assert.deepEqual(workflowStates(c.rig), []);
        assert.deepEqual(
          snapshots(c.rig),
          cases.map(() => ({
            origin: 'live_fragment',
            state: 'blocked',
            seal_reason: null,
            input_evidence: 'unverified',
            policy_version: null,
            audio_epoch: liveAudioEpoch(c.rig),
          })),
        );
        // 記憶は 1 件も保存していない。
        assert.deepEqual(
          rows<{ n: number }>(c.rig, 'SELECT count(*) AS n FROM memories'),
          [{ n: 0 }],
        );
      },
      {
        policy: {
          ...TEST_TURN_POLICY,
          auto_execution: Object.fromEntries(
            Object.keys(TEST_TURN_POLICY.auto_execution).map((name) => [
              name,
              true,
            ]),
          ) as TurnPolicy['auto_execution'],
        },
        prepare: (script) => {
          for (const [text, intent, args] of cases)
            script.replies.set(text, intentReply(intent, args));
        },
      },
    );
  },
);

// Codex の P2-4: 方式 C の全文の確定の判定は、対応する操作の分岐より前にある。作成にまだ対応していない操作（メモ・予定）も、
// 用事・ラベル・下書きと同じく、既定では承認の対象を作らず全文の確定へ戻す（「未対応」と食い違わせない）。
test(
  'QA41/P2: with the default policy every one of the four live operations (task, note, event, label, draft) makes no operation and goes back to the full text',
  TIMEOUT,
  async () => {
    const intents: [string, Record<string, unknown>][] = [
      ['create_task', { title: '牛乳を買う' }],
      ['create_note', { title: 'メモ', body: '牛乳' }],
      [
        'create_event',
        {
          title: '歯医者',
          start: '2026-10-06T10:00:00+09:00',
          end: '2026-10-06T11:00:00+09:00',
        },
      ],
      ['label_mail', { target_candidate_id: uuid(0xc1), add_labels: ['仕事'] }],
      ['draft_reply', { target_candidate_id: uuid(0xc1), body: 'よろしく' }],
    ];
    await withConversation(async (c) => {
      for (const [index, [intent, args]] of intents.entries()) {
        const interpreted = intentReply(intent, args);
        const result = await c.turns.commitLive({
          session_id: SESSION,
          command_scope_id: SCOPE_A,
          request_id: uuid(0x9100 + index),
          identity: `${c.liveId}/p24-${index}`,
          text: `p24 ${intent}`,
          audio_epoch: c.rig.voice.liveRecord(c.liveId)?.audio_epoch as string,
          policy_version: '1',
          interpreted: {
            ...interpreted,
            relation: 'unknown',
            target_workflow_id: null,
          } as never,
          outcome: 'sealed',
          workflow_id: uuid(0x9200 + index),
          precommit: () => true,
        });
        assert.equal(result.kind, 'ok', intent);
        if (result.kind !== 'ok') return;
        assert.equal(result.full_text, true, intent);
        assert.equal(result.turn.status, 'clarification', intent);
      }
      // 承認の対象は 0。
      assert.deepEqual(operations(c.rig), []);
    });
  },
);

test(
  'QA41/P2: a spoken note or event with the default policy is answered with the full-text sentence, not with "not supported", and makes no operation',
  TIMEOUT,
  async () => {
    const cases: [string, string, Record<string, unknown>][] = [
      [
        'メモに「牛乳」と書いて',
        'create_note',
        { title: 'メモ', body: '牛乳' },
      ],
      [
        'あした十時に歯医者の予定を入れて',
        'create_event',
        {
          title: '歯医者',
          start: '2026-10-06T10:00:00',
          end: '2026-10-06T11:00:00',
        },
      ],
    ];
    await withConversation(
      async (c) => {
        let answered = 0;
        for (const [index, [text]] of cases.entries()) {
          await speak(c, { text });
          await delegate(c, `d${index}`, c.next.start - 400);
          await c.rig.clock.advance(500);
          answered += 1;
          await waitUntil(
            c.rig,
            `the answer ${answered}`,
            () => c.sb.commentary.length === answered,
          );
        }
        assert.deepEqual(
          c.sb.commentary,
          cases.map(() => [FULL_TEXT_SENTENCE]),
        );
        assert.deepEqual(operations(c.rig), []);
      },
      {
        prepare: (script) => {
          for (const [text, intent, args] of cases)
            script.replies.set(text, intentReply(intent, args));
        },
      },
    );
  },
);

// ---- 欠落・時刻の対応が不明なら変更が 0（X51・QA05） ----------------------------------------------------------

test(
  'X51/QA05: a skipped fragment, a fragment without a number, two target utterances or a missing offset make no change and ask to say it again',
  TIMEOUT,
  async () => {
    const scenarios: {
      readonly name: string;
      readonly run: (c: Conv) => Promise<void>;
    }[] = [
      {
        name: 'skipped fragment number',
        run: async (c) => {
          await speak(c, {
            text: TASK_TEXT,
            parts: ['「牛乳を買う」を', '用事に登録して'],
            indexes: [0, 2],
          });
          await delegate(c, 'd1', 1600);
        },
      },
      {
        name: 'fragment without a number',
        run: async (c) => {
          await speak(c, { text: TASK_TEXT, indexes: [null] });
          await delegate(c, 'd1', 800);
        },
      },
      {
        name: 'two utterances before one delegation',
        run: async (c) => {
          await speak(c, { text: '牛乳を買う' });
          const end = await speak(c, { text: '卵も買う' });
          await delegate(c, 'd1', end);
        },
      },
      {
        name: 'unknown offset',
        run: async (c) => {
          await speak(c, { text: TASK_TEXT });
          await delegate(c, 'd1', null);
        },
      },
    ];
    for (const scenario of scenarios)
      await withConversation(
        async (c) => {
          await scenario.run(c);
          await c.rig.clock.advance(500);
          await waitUntil(
            c.rig,
            `${scenario.name}: the answer`,
            () => c.sb.commentary.length === 1,
          );
          assert.deepEqual(
            c.sb.commentary,
            [[SAY_AGAIN_SENTENCE]],
            scenario.name,
          );
          assert.deepEqual(operations(c.rig), [], scenario.name);
          assert.deepEqual(workflowStates(c.rig), [], scenario.name);
        },
        { policy: AUTO_TASK },
      );
  },
);

test(
  'X51: without an end candidate the delegation waits and does not proceed on the passing of time alone; with it the input is confirmed after 300 ms without a new fragment',
  TIMEOUT,
  async () => {
    await withConversation(
      async (c) => {
        await speak(c, { text: TASK_TEXT, end: false });
        await delegate(c, 'd1', 800);
        // 終了候補がなければ、時間が経っても解釈に進まない（上限の 5 秒より前）。
        await c.rig.clock.advance(1500);
        await c.rig.wait();
        assert.deepEqual(c.script.calls, []);
        assert.equal(c.conversation.pendingCount, 1);
        // 終了候補が来て、最後の断片から 300 ms 以上変化がなければ、すぐ進む。
        c.sb.endCandidate();
        await c.rig.clock.advance(100);
        await waitUntil(
          c.rig,
          'the commentary',
          () => c.sb.commentary.length === 1,
        );
        assert.deepEqual(c.script.calls, [TASK_TEXT]);
        assert.equal(operations(c.rig).length, 1);
      },
      { policy: AUTO_TASK },
    );
  },
);

test(
  'X51: a fragment that arrives after the end candidate restarts the 300 ms and is part of what is interpreted (299 ms is not enough)',
  TIMEOUT,
  async () => {
    await withConversation(
      async (c) => {
        c.sb.speechStarted();
        c.sb.fragment({
          index: 0,
          start_ms: 0,
          end_ms: 800,
          text: '「牛乳を買う」を',
        });
        c.sb.endCandidate();
        await delegate(c, 'd1', 800);
        await c.rig.clock.advance(250);
        // 認識の遅れで、残りの断片が終了候補の後に届く。
        c.sb.fragment({
          index: 1,
          start_ms: 800,
          end_ms: 1600,
          text: '用事に登録して',
        });
        await c.rig.clock.advance(299);
        await c.rig.wait();
        assert.deepEqual(c.script.calls, []);
        // 見直しは 100 ms ごと。300 ms 変化がなかった後の最初の見直しで進む。
        await c.rig.clock.advance(101);
        await waitUntil(
          c.rig,
          'the commentary',
          () => c.sb.commentary.length === 1,
        );
        // 解釈したのは断片をつないだ全文（先の断片だけで進めない）。
        assert.deepEqual(c.script.calls, [TASK_TEXT]);
        assert.equal(operations(c.rig).length, 1);
      },
      { policy: AUTO_TASK },
    );
  },
);

test(
  'X51: a read from an utterance that is never confirmed is answered after the 5 second limit, recorded as collecting, and makes no operation',
  TIMEOUT,
  async () => {
    await withConversation(async (c) => {
      await speak(c, { text: '今日の予定を見せて', end: false });
      await delegate(c, 'd1', 800);
      await beat(c, 5200);
      await waitUntil(c.rig, 'the answer', () => c.sb.commentary.length === 1);
      assert.deepEqual(c.sb.commentary, [
        ['予定は2件です。', '時間が重なっている予定があります。'],
      ]);
      assert.deepEqual(snapshots(c.rig), [
        {
          origin: 'live_fragment',
          state: 'collecting',
          seal_reason: null,
          input_evidence: 'unverified',
          policy_version: null,
          audio_epoch: liveAudioEpoch(c.rig),
        },
      ]);
      assert.deepEqual(operations(c.rig), []);
      assert.deepEqual(workflowStates(c.rig), ['done']);
    });
  },
);

// ---- X49: 文字の依頼は、音声の接続が開いていても文字で返す ------------------------------------------------------

function typedRequest(text: string, inputKind: string): ApiHandlerRequest {
  const route = API_ROUTES.find((entry) => entry.operationId === 'postTurn');
  assert(route !== undefined);
  return {
    route,
    device: A,
    body: {
      request_id: uuid(0x900000 + Math.floor(Math.random() * 0xfffff)),
      command_scope_id: SCOPE_A,
      text,
      input_kind: inputKind,
    },
    params: { session_id: SESSION },
    remoteAddress: '127.0.0.1',
    query: {},
    declaredLockState: 'unlocked',
  };
}

test(
  'X49: a typed request is answered in text while a voice connection is open, and nothing is appended to the live; a live transcript cannot be claimed over HTTP',
  TIMEOUT,
  async () => {
    await withConversation(async (c) => {
      const handler = c.turns.handlers['postTurn'];
      assert(handler !== undefined);
      const typed = await handler(typedRequest('今日の予定を見せて', 'text'));
      assert.equal(typed.status, 200, JSON.stringify(typed.body));
      const body = typed.body as Record<string, unknown>;
      assert.equal(body['status'], 'answered');
      assert.equal(
        (body['result_view'] as Record<string, unknown>)['kind'],
        'schedule_cards',
      );
      await c.rig.wait();
      // 音声の接続には何も送らない（結果もつなぎも）。出力先は文字のまま。
      assert.deepEqual(c.sb.commentary, []);
      assert.deepEqual(c.sb.instructions, []);
      assert.deepEqual(turnsOf(c.rig), [{ input_kind: 'text', role: 'user' }]);
      assert.deepEqual(c.shown, []);
      // 端末の HTTP の経路で voice_live を名乗る入力は受け付けない（中枢がサイドバンドで受ける）。
      const claimed = await handler(
        typedRequest('今日の予定を見せて', 'voice_live'),
      );
      assert.equal(claimed.status, 503);
      assert.deepEqual(turnsOf(c.rig), [{ input_kind: 'text', role: 'user' }]);
      assert.deepEqual(c.sb.commentary, []);
    });
  },
);

// ---- X58: 会話の操作（LLM を呼ばない） --------------------------------------------------------------------------

test(
  'X58: "wait a moment" extends the next silence to 60 seconds, calls no model, makes no turn, and leaves the playback and the connection alone',
  TIMEOUT,
  async () => {
    await withConversation(async (c) => {
      await speak(c, { text: 'ちょっと待って' });
      await c.rig.clock.advance(400);
      await waitUntil(
        c.rig,
        'the silence extension',
        () => controlEvents(c.rig, 'silence_extension').length === 1,
      );
      const event = controlEvents(c.rig, 'silence_extension')[0] as Record<
        string,
        unknown
      >;
      // 契約（VoiceEvent）に合う形で、本文・文字起こしを載せない。
      assert(createApiContract().valid('VoiceEvent', event));
      assert.equal(event['silence_extension_ms'], 60000);
      assert.equal(event['live_session_id'], c.liveId);
      assert.equal(event['device_id'], DEV_A);
      assert.deepEqual(c.script.calls, []);
      assert.deepEqual(turnsOf(c.rig), []);
      assert.deepEqual(c.sb.commentary, []);
      assert.equal(c.rig.voice.liveRecord(c.liveId)?.closure, 'open');
      assert.deepEqual(controlEvents(c.rig, 'audio_control'), []);
    });
  },
);

test(
  'X58: each conversation operation has its own effect on the live: stop only mutes, end / do-not-record / reply-in-text close with their own reason',
  TIMEOUT,
  async () => {
    const effects: [string, 'open' | 'close_requested', string | null][] = [
      ['読み上げを止めて', 'open', null],
      ['もう終わり', 'close_requested', 'conversation_ended'],
      ['記録しないで', 'close_requested', 'private_conversation'],
      ['文字で返して', 'close_requested', 'output_mode_text'],
    ];
    for (const [phrase, closure, reason] of effects)
      await withConversation(async (c) => {
        await speak(c, { text: phrase });
        await c.rig.clock.advance(400);
        await waitUntil(
          c.rig,
          `${phrase}: the control`,
          () => controlEvents(c.rig, 'audio_control').length >= 1,
        );
        assert(
          createApiContract().valid(
            'VoiceEvent',
            controlEvents(c.rig, 'audio_control')[0],
          ),
        );
        const control = (
          controlEvents(c.rig, 'audio_control')[0] as Record<string, unknown>
        )['audio_control'] as Record<string, unknown>;
        if (reason === null) {
          assert.deepEqual(
            [control['action'], control['reason'], control['issued_by']],
            ['stop_playback', 'user_stop', 'core'],
            phrase,
          );
        } else
          assert.deepEqual(
            [control['action'], control['reason'], control['issued_by']],
            ['close_voice_session', reason, 'core'],
            phrase,
          );
        assert.equal(
          c.rig.voice.liveRecord(c.liveId)?.closure,
          closure,
          phrase,
        );
        assert.equal(
          c.rig.voice.liveRecord(c.liveId)?.end_reason ?? null,
          reason,
        );
        // どれも LLM を呼ばず、発言も依頼も作らない。
        assert.deepEqual(c.script.calls, [], phrase);
        assert.deepEqual(turnsOf(c.rig), [], phrase);
        assert.deepEqual(workflowStates(c.rig), [], phrase);
        assert.deepEqual(controlEvents(c.rig, 'silence_extension'), [], phrase);
      });
  },
);

test(
  'X58: a phrase followed by a request, a polite form and the cancel command are not conversation operations and go to the normal intent path',
  TIMEOUT,
  async () => {
    const texts = [
      'ちょっと待って、「牛乳を買う」を用事に登録して',
      'ちょっと待ってください',
      '処理を取り消して',
    ];
    await withConversation(
      async (c) => {
        let answered = 0;
        for (const text of texts) {
          await speak(c, { text });
          await delegate(c, `d${answered}`, c.next.start - 400);
          await c.rig.clock.advance(500);
          answered += 1;
          await waitUntil(
            c.rig,
            `the answer ${answered}`,
            () => c.sb.commentary.length === answered,
          );
        }
        assert.deepEqual(c.script.calls, texts);
        assert.deepEqual(controlEvents(c.rig, 'silence_extension'), []);
        assert.deepEqual(controlEvents(c.rig, 'audio_control'), []);
        assert.equal(c.rig.voice.liveRecord(c.liveId)?.closure, 'open');
      },
      {
        prepare: (script) => {
          script.replies.set(texts[0] as string, intentReply('smalltalk'));
        },
      },
    );
  },
);

test(
  'X58: a typed conversation operation is matched without the model, makes no workflow, and closes the open live in the same way as the button',
  TIMEOUT,
  async () => {
    await withConversation(async (c) => {
      const handler = c.turns.handlers['postTurn'];
      assert(handler !== undefined);
      const typed = await handler(typedRequest('文字で返して', 'text'));
      assert.equal(typed.status, 200, JSON.stringify(typed.body));
      assert.deepEqual(
        {
          status: (typed.body as Record<string, unknown>)['status'],
          control: (typed.body as Record<string, unknown>)['session_control'],
          workflow: (typed.body as Record<string, unknown>)['workflow_id'],
          view: (typed.body as Record<string, unknown>)['result_view'],
        },
        {
          status: 'session_control',
          control: 'reply_in_text',
          workflow: null,
          view: null,
        },
      );
      await waitUntil(
        c.rig,
        'the live closes',
        () => c.rig.voice.liveRecord(c.liveId)?.closure !== 'open',
      );
      assert.equal(
        c.rig.voice.liveRecord(c.liveId)?.end_reason,
        'output_mode_text',
      );
      assert.deepEqual(c.script.calls, []);
      assert.deepEqual(workflowStates(c.rig), []);
      assert.deepEqual(operations(c.rig), []);
    });
  },
);

// ---- X27・QA35: 発話の開始による一時保留 ------------------------------------------------------------------------

const EGG_TEXT = '「卵を買う」を用事に登録して';

// 1 つ目の依頼（解釈を保留）を出し、2 つ目の発話を始める。1 つ目の解釈を通した後、1 つ目は保留になっている。
async function firstRequestHeldBySecondUtterance(
  c: Conv,
  release: () => void,
): Promise<void> {
  await speak(c, { text: TASK_TEXT });
  await delegate(c, 'd1', 800);
  await c.rig.clock.advance(500);
  await waitUntil(
    c.rig,
    'the first interpretation',
    () => c.script.calls.length === 1,
  );
  // 2 つ目の発話が始まった（送出前の変更を一時保留する）。
  c.sb.speechStarted();
  release();
  await waitUntil(
    c.rig,
    'the first change is held',
    () => c.conversation.heldCount(c.liveId) === 1,
  );
  await c.rig.wait();
  // 保留の間は、依頼も操作も作らず、声で返しもしない。
  assert.deepEqual(operations(c.rig), []);
  assert.deepEqual(turnsOf(c.rig), []);
  assert.deepEqual(c.sb.commentary, []);
}

async function secondUtterance(c: Conv): Promise<void> {
  await speak(c, { text: EGG_TEXT, speech: false });
  await delegate(c, 'd2', c.next.start - 400);
  await c.rig.clock.advance(500);
}

test(
  'QA35/X27: a new utterance holds the change that is not sent yet; a new (separate) request resumes it and both are made',
  TIMEOUT,
  async () => {
    const first = gate();
    await withConversation(
      async (c) => {
        await firstRequestHeldBySecondUtterance(c, first.release);
        await secondUtterance(c);
        await waitUntil(
          c.rig,
          'both answered',
          () => c.sb.commentary.length === 2,
        );
        assert.equal(operations(c.rig).length, 2);
        assert.deepEqual(c.sb.commentary, [
          [SCREEN_SENTENCE],
          [SCREEN_SENTENCE],
        ]);
        assert.equal(c.conversation.heldCount(c.liveId), 0);
        assert.deepEqual(c.dropped, []);
      },
      {
        policy: AUTO_TASK,
        prepare: (script) => {
          script.gates.set(TASK_TEXT, first.promise);
          script.replies.set(
            EGG_TEXT,
            intentReply(
              'create_task',
              { title: '卵を買う' },
              { relation: 'new' },
            ),
          );
        },
      },
    );
  },
);

test(
  'QA35/X27: a correction that settles on one held change replaces it (the old change is never made and its result is not read); only the corrected request is made',
  TIMEOUT,
  async () => {
    const first = gate();
    await withConversation(
      async (c) => {
        await firstRequestHeldBySecondUtterance(c, first.release);
        await secondUtterance(c);
        await waitUntil(
          c.rig,
          'the corrected answer',
          () => c.sb.commentary.length === 1,
        );
        await c.rig.wait();
        assert.equal(operations(c.rig).length, 1);
        assert.deepEqual(turnsOf(c.rig), [
          { input_kind: 'voice_live', role: 'user' },
        ]);
        assert.deepEqual(c.sb.commentary, [[SCREEN_SENTENCE]]);
        // 旧い依頼の結果は声にも画面にも出さない。
        assert.deepEqual(c.shown, []);
        assert.equal(c.conversation.heldCount(c.liveId), 0);
      },
      {
        policy: AUTO_TASK,
        prepare: (script) => {
          script.gates.set(TASK_TEXT, first.promise);
          script.replies.set(
            EGG_TEXT,
            intentReply(
              'create_task',
              { title: '卵を買う' },
              { relation: 'correction', target_workflow_id: uuid(0x8001) },
            ),
          );
        },
      },
    );
  },
);

test(
  'QA35/X27: a cancel that settles on one held change stops it before it is sent and answers that it was cancelled; nothing is made',
  TIMEOUT,
  async () => {
    const first = gate();
    await withConversation(
      async (c) => {
        await firstRequestHeldBySecondUtterance(c, first.release);
        await secondUtterance(c);
        await waitUntil(
          c.rig,
          'the cancel answer',
          () => c.sb.commentary.length === 1,
        );
        assert.deepEqual(c.sb.commentary, [['実行前の依頼を取り消しました。']]);
        assert.deepEqual(operations(c.rig), []);
        assert.deepEqual(workflowStates(c.rig), []);
        assert.equal(c.conversation.heldCount(c.liveId), 0);
      },
      {
        policy: AUTO_TASK,
        prepare: (script) => {
          script.gates.set(TASK_TEXT, first.promise);
          script.replies.set(
            EGG_TEXT,
            intentReply(
              'smalltalk',
              {},
              { relation: 'cancel', target_workflow_id: uuid(0x8001) },
            ),
          );
        },
      },
    );
  },
);

test(
  'QA35/X27: when the relation or the target is not settled the held change is never resumed on its own, the user is asked back, and after the limit it is dropped without being made',
  TIMEOUT,
  async () => {
    const first = gate();
    await withConversation(
      async (c) => {
        await firstRequestHeldBySecondUtterance(c, first.release);
        await secondUtterance(c);
        await waitUntil(
          c.rig,
          'the ask back',
          () => c.sb.commentary.length === 1,
        );
        assert.deepEqual(c.sb.commentary, [
          ['どの依頼のことか分かりませんでした。もう一度言ってください。'],
        ]);
        // 勝手に再開しない: 依頼も操作もない。
        assert.deepEqual(operations(c.rig), []);
        assert.equal(c.conversation.heldCount(c.liveId), 1);
        // 保留の上限（30 秒）を過ぎたら、実行せずに捨てて画面へ知らせる。
        await beat(c, 32000);
        await waitUntil(c.rig, 'the drop', () => c.dropped.length === 1);
        assert.deepEqual(
          c.dropped.map((entry) => [entry.session_id, entry.reason]),
          [[SESSION, 'hold_expired']],
        );
        assert.deepEqual(operations(c.rig), []);
        assert.equal(c.conversation.heldCount(c.liveId), 0);
        assert.equal(c.rig.voice.liveRecord(c.liveId)?.closure, 'open');
      },
      {
        policy: AUTO_TASK,
        prepare: (script) => {
          script.gates.set(TASK_TEXT, first.promise);
          // 関係の記載がない（relation なし）: 分からない扱い。
          script.replies.set(
            EGG_TEXT,
            intentReply('create_task', { title: '卵を買う' }),
          );
        },
      },
    );
  },
);

test(
  'QA35: a conversation operation is not a correction: it resumes the held change, which then goes to the screen because the playback was stopped',
  TIMEOUT,
  async () => {
    const first = gate();
    await withConversation(
      async (c) => {
        await firstRequestHeldBySecondUtterance(c, first.release);
        // 保留の間に「読み上げを止めて」（会話の操作）。依頼への訂正ではないので、保留を解く。
        await speak(c, { text: '読み上げを止めて', speech: false });
        await c.rig.clock.advance(400);
        await waitUntil(
          c.rig,
          'the change is made',
          () => operations(c.rig).length === 1,
        );
        await waitUntil(c.rig, 'the late result', () => c.shown.length === 1);
        // 停止の前に受けた依頼の結果は、停止の後に声にしない（画面へ）。
        assert.deepEqual(c.sb.commentary, []);
        assert.deepEqual(
          c.shown.map((entry) => [entry.reason, entry.session_id]),
          [['stale_epoch', SESSION]],
        );
        assert.equal(c.shown[0]?.turn.status, 'answered');
        assert.equal(c.rig.voice.liveRecord(c.liveId)?.closure, 'open');
      },
      {
        policy: AUTO_TASK,
        prepare: (script) => {
          script.gates.set(TASK_TEXT, first.promise);
        },
      },
    );
  },
);

// ---- 遅着の結果を画面に回す（X29・X36） -------------------------------------------------------------------------

test(
  'X29: a result that returns after the live was closed goes to the screen (not the voice), is still saved as one workflow, and nothing is appended to the closed live',
  TIMEOUT,
  async () => {
    const first = gate();
    await withConversation(
      async (c) => {
        await speak(c, { text: TASK_TEXT });
        await delegate(c, 'd1', 800);
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the interpretation',
          () => c.script.calls.length === 1,
        );
        // 解釈の間に、端末が会話を閉じた（無音）。
        const closed = await c.rig.voice.closeLiveSession(A, c.liveId, {
          request_id: uuid(0x71),
          command_scope_id: SCOPE_A,
          reason: 'silence',
          audio_epoch: c.rig.voice.liveRecord(c.liveId)?.audio_epoch as string,
        });
        assert.equal(closed.status, 202);
        first.release();
        await waitUntil(c.rig, 'the late result', () => c.shown.length === 1);
        assert.deepEqual(
          c.shown.map((entry) => [entry.reason, entry.session_id]),
          [['live_closed', SESSION]],
        );
        assert.equal(c.shown[0]?.turn.workflow_id, workflowIds(c.rig)[0]);
        assert.deepEqual(c.sb.commentary, []);
        assert.equal(operations(c.rig).length, 1);
        assert.deepEqual(turnsOf(c.rig), [
          { input_kind: 'voice_live', role: 'user' },
        ]);
      },
      {
        policy: AUTO_TASK,
        prepare: (script) => {
          script.gates.set(TASK_TEXT, first.promise);
        },
      },
    );
  },
);

const workflowIds = (rig: Rig): string[] =>
  rows<{ workflow_id: string }>(
    rig,
    'SELECT workflow_id FROM workflows ORDER BY rowid',
  ).map((row) => row.workflow_id);

test(
  'X47: after the reply mode was switched to text the live is closed at once; transcripts and delegations that arrive afterwards are not processed and nothing is voiced',
  TIMEOUT,
  async () => {
    await withConversation(
      async (c) => {
        const closed = await c.rig.voice.closeLiveSession(A, c.liveId, {
          request_id: uuid(0x72),
          command_scope_id: SCOPE_A,
          reason: 'output_mode_text',
          audio_epoch: c.rig.voice.liveRecord(c.liveId)?.audio_epoch as string,
        });
        assert.equal(closed.status, 202);
        await c.rig.wait();
        assert.equal(
          c.rig.voice.liveRecord(c.liveId)?.end_reason,
          'output_mode_text',
        );
        await speak(c, { text: TASK_TEXT });
        await delegate(c, 'd1', 800);
        await c.rig.clock.advance(1000);
        await c.rig.wait();
        assert.deepEqual(c.script.calls, []);
        assert.deepEqual(c.sb.commentary, []);
        assert.deepEqual(turnsOf(c.rig), []);
        assert.deepEqual(operations(c.rig), []);
      },
      { policy: AUTO_TASK },
    );
  },
);

test(
  'X46/X13: a delegation whose external-send consent was revoked is not processed, so nothing is interpreted, saved or voiced',
  TIMEOUT,
  async () => {
    const consent = { value: 'granted' as 'granted' | 'revoked' };
    await withConversation(
      async (c) => {
        consent.value = 'revoked';
        await speak(c, { text: TASK_TEXT });
        await delegate(c, 'd1', 800);
        await c.rig.clock.advance(1000);
        await c.rig.wait();
        assert.deepEqual(c.script.calls, []);
        assert.deepEqual(turnsOf(c.rig), []);
        assert.deepEqual(c.sb.commentary, []);
        assert.equal(c.conversation.pendingCount, 0);
      },
      {
        policy: AUTO_TASK,
        overrides: { consent: () => consent.value },
      },
    );
  },
);

test(
  'X36: closing the live with a held change drops it without making it and tells the screen',
  TIMEOUT,
  async () => {
    const first = gate();
    await withConversation(
      async (c) => {
        await firstRequestHeldBySecondUtterance(c, first.release);
        const closed = await c.rig.voice.closeLiveSession(A, c.liveId, {
          request_id: uuid(0x73),
          command_scope_id: SCOPE_A,
          reason: 'silence',
          audio_epoch: c.rig.voice.liveRecord(c.liveId)?.audio_epoch as string,
        });
        assert.equal(closed.status, 202);
        await waitUntil(c.rig, 'the drop', () => c.dropped.length === 1);
        assert.deepEqual(
          c.dropped.map((entry) => entry.reason),
          ['live_closed'],
        );
        assert.deepEqual(operations(c.rig), []);
        assert.equal(c.conversation.pendingCount, 0);
      },
      {
        policy: AUTO_TASK,
        prepare: (script) => {
          script.gates.set(TASK_TEXT, first.promise);
        },
      },
    );
  },
);

// Codex の P2-3（部分対応）: 製品の起動が使う画面への届け方。予定のカードはキャンバスへ置き、置けない文字の結果と保留の破棄は
// 理由だけをログに残す（結果の中身は残さない）。文字の結果を載せる表示の経路は未対応（contract-map U120）。
test('P2-3: the product screen sink places schedule cards and logs, without any content, what the canvas cannot show', () => {
  const placed: string[] = [];
  const logs: string[] = [];
  const sink = createLiveScreenSink({
    placeLate: (turn) => placed.push(turn.turn_id),
    log: (message) => logs.push(message),
  });
  const turnOf = (id: string, kind: string | null) =>
    ({
      turn_id: id,
      reply_text: '秘密の本文',
      result_view: kind === null ? null : { kind },
    }) as never;
  sink.show({
    reason: 'live_closed',
    session_id: SESSION,
    turn: turnOf('t1', 'schedule_cards'),
  });
  sink.show({
    reason: 'live_closed',
    session_id: SESSION,
    turn: turnOf('t2', null),
  });
  sink.heldDropped({
    session_id: SESSION,
    workflow_id: uuid(0x8001),
    reason: 'hold_expired',
  });
  // 配置者へは、文字の結果も含めて必ず渡す（置けるかは配置者が決める）。
  assert.deepEqual(placed, ['t1', 't2']);
  assert.deepEqual(logs, [
    'live_screen_text_not_shown:live_closed',
    'live_held_dropped:hold_expired',
  ]);
});

// ---- 破棄した保留依頼が遅い非同期処理から復活しない（Codex の P1・P2-2） ----------------------------------------------

// 解釈を待つ依頼を新しい発話で保留する（解釈はまだ戻らない）。
async function interpretingRequestHeld(c: Conv): Promise<void> {
  await speak(c, { text: TASK_TEXT });
  await delegate(c, 'd1', 800);
  await c.rig.clock.advance(500);
  await waitUntil(
    c.rig,
    'the first interpretation',
    () => c.script.calls.length === 1,
  );
  c.sb.speechStarted();
  assert.equal(c.conversation.heldCount(c.liveId), 1);
}

const nothingMade = (c: Conv): void => {
  assert.deepEqual(operations(c.rig), []);
  assert.deepEqual(workflowStates(c.rig), []);
  assert.deepEqual(turnsOf(c.rig), []);
  assert.deepEqual(c.sb.commentary, []);
  assert.deepEqual(c.shown, []);
};

// 何も作らず、破棄の通知だけを声で伝えた（Live が開いているときの保留の破棄）。
const nothingMadeButDropTold = (c: Conv): void => {
  assert.deepEqual(operations(c.rig), []);
  assert.deepEqual(workflowStates(c.rig), []);
  assert.deepEqual(turnsOf(c.rig), []);
  assert.deepEqual(c.sb.commentary, [[HOLD_DROPPED_SENTENCE]]);
  assert.deepEqual(c.shown, []);
};

test(
  'P1: a held request dropped at the limit while its interpretation is pending is never saved when the interpretation returns late',
  TIMEOUT,
  async () => {
    const first = gate();
    await withConversation(
      async (c) => {
        await interpretingRequestHeld(c);
        // 保留の上限（30 秒）を過ぎて破棄した（画面へ知らせた）。
        await beat(c, 32000);
        await waitUntil(c.rig, 'the drop', () => c.dropped.length === 1);
        assert.deepEqual(
          c.dropped.map((entry) => entry.reason),
          ['hold_expired'],
        );
        // 破棄の通知の後に解釈が返る。
        first.release();
        await c.rig.wait();
        await c.rig.clock.advance(500);
        await c.rig.wait();
        assert.deepEqual(c.commits, []);
        nothingMadeButDropTold(c);
        assert.equal(c.conversation.pendingCount, 0);
        assert.equal(c.conversation.heldCount(c.liveId), 0);
      },
      {
        policy: AUTO_TASK,
        prepare: (script) => {
          script.gates.set(TASK_TEXT, first.promise);
        },
      },
    );
  },
);

test(
  'P1: closing the live while a held request is preparing its record drops it, and the record is refused at the last check afterwards',
  TIMEOUT,
  async () => {
    const prepared = gate();
    await withConversation(
      async (c) => {
        c.hooks.beforeCommit = () => prepared.promise;
        await speak(c, { text: TASK_TEXT });
        await delegate(c, 'd1', 800);
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the record is being prepared',
          () => c.hooks.entered === 1,
        );
        // 保存の準備の間に新しい発話が始まって保留され、そのまま Live が閉じた。
        c.sb.speechStarted();
        assert.equal(c.conversation.heldCount(c.liveId), 1);
        const closed = await c.rig.voice.closeLiveSession(A, c.liveId, {
          request_id: uuid(0x74),
          command_scope_id: SCOPE_A,
          reason: 'silence',
          audio_epoch: c.rig.voice.liveRecord(c.liveId)?.audio_epoch as string,
        });
        assert.equal(closed.status, 202);
        await waitUntil(c.rig, 'the drop', () => c.dropped.length === 1);
        assert.deepEqual(
          c.dropped.map((entry) => entry.reason),
          ['live_closed'],
        );
        prepared.release();
        await waitUntil(
          c.rig,
          'the refused record',
          () => c.commits.length === 1,
        );
        await c.rig.wait();
        // 保存の直前の検査で止まる（保存の命令を送らない）。
        assert.deepEqual(c.commits, ['held']);
        nothingMade(c);
        assert.equal(c.conversation.pendingCount, 0);
      },
      { policy: AUTO_TASK },
    );
  },
);

test(
  'P1: a request whose record command was already sent is not dropped when a new utterance starts and the live closes before the result returns',
  TIMEOUT,
  async () => {
    const answer = gate();
    await withConversation(
      async (c) => {
        c.hooks.afterRecord = () => answer.promise;
        await speak(c, { text: TASK_TEXT });
        await delegate(c, 'd1', 800);
        await c.rig.clock.advance(500);
        // 保存の命令は送信済み（操作は DB に 1 件ある）。保存の応答はまだ返っていない。
        await waitUntil(
          c.rig,
          'the record command',
          () => operations(c.rig).length === 1,
        );
        // 応答を待つ間に、新しい発話が始まって Live が閉じた。
        c.sb.speechStarted();
        const closed = await c.rig.voice.closeLiveSession(A, c.liveId, {
          request_id: uuid(0x76),
          command_scope_id: SCOPE_A,
          reason: 'silence',
          audio_epoch: c.rig.voice.liveRecord(c.liveId)?.audio_epoch as string,
        });
        assert.equal(closed.status, 202);
        await c.rig.wait();
        // 送信済みの依頼は保留・破棄の対象にしない。
        assert.deepEqual(c.dropped, []);
        assert.equal(c.conversation.heldCount(c.liveId), 0);
        answer.release();
        // 保存結果は捨てずに画面へ回す（保存されたものとして扱う）。
        await waitUntil(c.rig, 'the saved result', () => c.shown.length === 1);
        assert.deepEqual(c.commits, ['ok']);
        assert.deepEqual(
          c.shown.map((entry) => [entry.reason, entry.session_id]),
          [['live_closed', SESSION]],
        );
        assert.equal(c.shown[0]?.turn.status, 'answered');
        assert.deepEqual(operations(c.rig), [
          {
            kind: 'task.create',
            effect_route: 'local_command',
            state: 'awaiting_approval',
          },
        ]);
        assert.deepEqual(turnsOf(c.rig), [
          { input_kind: 'voice_live', role: 'user' },
        ]);
        assert.equal(c.conversation.pendingCount, 0);
      },
      { policy: AUTO_TASK },
    );
  },
);

test(
  'P1: a cancel that targets a request whose record command was sent is not processed as a new request, even when no other change is held',
  TIMEOUT,
  async () => {
    const answer = gate();
    await withConversation(
      async (c) => {
        // A: 保存の命令を送り、応答を待たせる（ほかに保留はない）。
        c.hooks.afterRecord = () => answer.promise;
        await speak(c, { text: TASK_TEXT });
        await delegate(c, 'd1', 800);
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the record command of A',
          () => operations(c.rig).length === 1,
        );
        const aId = workflowIds(c.rig)[0] as string;
        // B: A を対象とする取消。解釈は intent も返すが、関係（cancel）を優先する。
        c.script.replies.set(
          EGG_TEXT,
          intentReply(
            'create_task',
            { title: '卵を買う' },
            { relation: 'cancel', target_workflow_id: aId },
          ),
        );
        await speak(c, { text: EGG_TEXT });
        await delegate(c, 'd2', c.next.start - 400);
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the cancel answer',
          () => c.sb.commentary.length === 1,
        );
        // B は通常の依頼にならず、新しい操作も作らない（A の 1 件だけ）。
        assert.deepEqual(c.sb.commentary, [[SAY_AGAIN_SENTENCE]]);
        assert.deepEqual(operations(c.rig), [
          {
            kind: 'task.create',
            effect_route: 'local_command',
            state: 'awaiting_approval',
          },
        ]);
        assert.equal(c.conversation.heldCount(c.liveId), 0);
        assert.deepEqual(c.dropped, []);
        // A の応答を返すと、A の保存結果はそのまま届き、B からは操作が増えない。
        answer.release();
        await waitUntil(
          c.rig,
          'the result of A',
          () => c.sb.commentary.length === 2,
        );
        assert.deepEqual(
          c.sb.commentary.map((parts) => parts[0]).toSorted(),
          [SAY_AGAIN_SENTENCE, SCREEN_SENTENCE].toSorted(),
        );
        assert.equal(operations(c.rig).length, 1);
        assert.equal(c.conversation.pendingCount, 0);
      },
      { policy: AUTO_TASK },
    );
  },
);

test(
  'P1: a cancel that targets a saved request makes no new operation when no change is held',
  TIMEOUT,
  async () => {
    await withConversation(
      async (c) => {
        await speak(c, { text: TASK_TEXT });
        await delegate(c, 'd1', 800);
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the result of A',
          () => c.sb.commentary.length === 1,
        );
        const aId = workflowIds(c.rig)[0] as string;
        c.script.replies.set(
          EGG_TEXT,
          intentReply(
            'create_task',
            { title: '卵を買う' },
            { relation: 'cancel', target_workflow_id: aId },
          ),
        );
        await speak(c, { text: EGG_TEXT });
        await delegate(c, 'd2', c.next.start - 400);
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the cancel answer',
          () => c.sb.commentary.length === 2,
        );
        // 保存済みの A への取消も、新しい操作を作らずに聞き返しに留める。
        assert.deepEqual(c.sb.commentary, [
          [SCREEN_SENTENCE],
          [SAY_AGAIN_SENTENCE],
        ]);
        assert.equal(operations(c.rig).length, 1);
        assert.equal(c.conversation.heldCount(c.liveId), 0);
        assert.deepEqual(c.dropped, []);
      },
      { policy: AUTO_TASK },
    );
  },
);

test(
  'P1: a cancel that targets a request whose save failed is not processed as a new request',
  TIMEOUT,
  async () => {
    await withConversation(
      async (c) => {
        // A の保存は失敗し、追跡（pending）から外れる。
        c.hooks.commitFailure = 'failed';
        await speak(c, { text: TASK_TEXT });
        await delegate(c, 'd1', c.next.start - 400);
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the failed save of A',
          () => c.conversation.pendingCount === 0,
        );
        assert.deepEqual(operations(c.rig), []);
        // A（uuid 0x8001）を対象とする取消。
        c.script.replies.set(
          EGG_TEXT,
          intentReply(
            'create_task',
            { title: '卵を買う' },
            { relation: 'cancel', target_workflow_id: uuid(0x8001) },
          ),
        );
        await speak(c, { text: EGG_TEXT });
        await delegate(c, 'd2', c.next.start - 400);
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the cancel answer',
          () => c.sb.commentary.length === 1,
        );
        // 対象を解決できなくても、取消からは新しい操作・保存要求を作らない。
        assert.deepEqual(c.sb.commentary, [[SAY_AGAIN_SENTENCE]]);
        assert.deepEqual(operations(c.rig), []);
        assert.equal(c.conversation.pendingCount, 0);
      },
      { policy: AUTO_TASK },
    );
  },
);

test(
  'P1: a cancel that targets a request whose save result is unknown is not processed as a new request',
  TIMEOUT,
  async () => {
    await withConversation(
      async (c) => {
        // A の保存の結果は不明（例外）。追跡から外れる。
        c.hooks.commitFailure = 'reject';
        await speak(c, { text: TASK_TEXT });
        await delegate(c, 'd1', c.next.start - 400);
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the unknown save result of A',
          () => c.conversation.pendingCount === 0,
        );
        assert.deepEqual(operations(c.rig), []);
        c.script.replies.set(
          EGG_TEXT,
          intentReply(
            'create_task',
            { title: '卵を買う' },
            { relation: 'cancel', target_workflow_id: uuid(0x8001) },
          ),
        );
        await speak(c, { text: EGG_TEXT });
        await delegate(c, 'd2', c.next.start - 400);
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the cancel answer',
          () => c.sb.commentary.length === 1,
        );
        assert.deepEqual(c.sb.commentary, [[SAY_AGAIN_SENTENCE]]);
        assert.deepEqual(operations(c.rig), []);
        assert.equal(c.conversation.pendingCount, 0);
      },
      { policy: AUTO_TASK },
    );
  },
);

test(
  'P1: a cancel that targets a request already dropped from the 16 item history is not processed as a new request',
  { timeout: 60_000 },
  async () => {
    await withConversation(
      async (c) => {
        let seq = 0;
        const make = async (text: string): Promise<void> => {
          seq += 1;
          await speak(c, { text });
          await delegate(c, `d${seq}`, c.next.start - 400);
          await c.rig.clock.advance(500);
          await waitUntil(
            c.rig,
            `operation ${seq}`,
            () => c.sb.commentary.length === seq,
          );
          // 音声リースの期限（6 秒）を切らさない（3 件ごとに更新する）。
          if (seq % 3 === 0) await beat(c, 2000);
        };
        // A（uuid 0x8001）と、その後の 16 件の成功。A は直近 16 件の履歴から外れる。
        await make(TASK_TEXT);
        for (let index = 0; index < 16; index += 1) {
          const text = `「用事${index}」を用事に登録して`;
          c.script.replies.set(
            text,
            intentReply('create_task', { title: `用事${index}` }),
          );
          await make(text);
        }
        assert.equal(operations(c.rig).length, 17);
        // 履歴から外れた A への取消。
        c.script.replies.set(
          EGG_TEXT,
          intentReply(
            'create_task',
            { title: '卵を買う' },
            { relation: 'cancel', target_workflow_id: uuid(0x8001) },
          ),
        );
        await speak(c, { text: EGG_TEXT });
        await delegate(c, 'd18', c.next.start - 400);
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the cancel answer',
          () => c.sb.commentary.length === 18,
        );
        assert.deepEqual(c.sb.commentary.at(-1), [SAY_AGAIN_SENTENCE]);
        assert.equal(operations(c.rig).length, 17);
        assert.equal(c.conversation.pendingCount, 0);
      },
      { policy: AUTO_TASK },
    );
  },
);

test(
  'P1: a cancel whose target id never existed is not processed as a new request',
  TIMEOUT,
  async () => {
    await withConversation(
      async (c) => {
        c.script.replies.set(
          EGG_TEXT,
          intentReply(
            'create_task',
            { title: '卵を買う' },
            { relation: 'cancel', target_workflow_id: uuid(0x9999) },
          ),
        );
        await speak(c, { text: EGG_TEXT });
        await delegate(c, 'd1', c.next.start - 400);
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the cancel answer',
          () => c.sb.commentary.length === 1,
        );
        assert.deepEqual(c.sb.commentary, [[SAY_AGAIN_SENTENCE]]);
        assert.deepEqual(operations(c.rig), []);
        assert.equal(c.conversation.pendingCount, 0);
      },
      { policy: AUTO_TASK },
    );
  },
);

test(
  'P1: a new request with no target or an unknown target still proceeds',
  TIMEOUT,
  async () => {
    await withConversation(
      async (c) => {
        c.script.replies.set(
          EGG_TEXT,
          intentReply(
            'create_task',
            { title: '卵を買う' },
            { relation: 'new' },
          ),
        );
        await speak(c, { text: EGG_TEXT });
        await delegate(c, 'd1', c.next.start - 400);
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the first operation',
          () => c.sb.commentary.length === 1,
        );
        // 不明な対象の ID を添えた通常の new も止めない。
        const second = '「パンを買う」を用事に登録して';
        c.script.replies.set(
          second,
          intentReply(
            'create_task',
            { title: 'パンを買う' },
            { relation: 'new', target_workflow_id: uuid(0x9999) },
          ),
        );
        await speak(c, { text: second });
        await delegate(c, 'd2', c.next.start - 400);
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the second operation',
          () => c.sb.commentary.length === 2,
        );
        assert.deepEqual(c.sb.commentary, [
          [SCREEN_SENTENCE],
          [SCREEN_SENTENCE],
        ]);
        assert.equal(c.conversation.heldCount(c.liveId), 0);
      },
      { policy: AUTO_TASK },
    );
  },
);

test(
  'P1: a request that was not held still reaches the screen when its result returns after the live was closed',
  TIMEOUT,
  async () => {
    // X29 と同じ並び。保留の失効が、保留されていない遅着の結果まで捨てないことを固定する。
    const first = gate();
    await withConversation(
      async (c) => {
        await speak(c, { text: TASK_TEXT });
        await delegate(c, 'd1', 800);
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the interpretation',
          () => c.script.calls.length === 1,
        );
        const closed = await c.rig.voice.closeLiveSession(A, c.liveId, {
          request_id: uuid(0x75),
          command_scope_id: SCOPE_A,
          reason: 'silence',
          audio_epoch: c.rig.voice.liveRecord(c.liveId)?.audio_epoch as string,
        });
        assert.equal(closed.status, 202);
        first.release();
        await waitUntil(c.rig, 'the late result', () => c.shown.length === 1);
        assert.deepEqual(c.dropped, []);
        assert.equal(operations(c.rig).length, 1);
      },
      {
        policy: AUTO_TASK,
        prepare: (script) => {
          script.gates.set(TASK_TEXT, first.promise);
        },
      },
    );
  },
);

test(
  'P2: a later utterance does not extend the 30 second limit of a change that is already held',
  TIMEOUT,
  async () => {
    const first = gate();
    await withConversation(
      async (c) => {
        await interpretingRequestHeld(c);
        // 保留の開始から 29 秒後に、次の発話が始まる（保留は増えない）。
        await beat(c, 29000);
        assert.equal(c.dropped.length, 0);
        c.sb.speechStarted();
        // 開始から 30 秒を過ぎたら捨てる（発話の追加で延ばさない）。
        await beat(c, 2000);
        await waitUntil(c.rig, 'the drop', () => c.dropped.length === 1);
        assert.deepEqual(
          c.dropped.map((entry) => entry.reason),
          ['hold_expired'],
        );
        first.release();
        await c.rig.wait();
        nothingMadeButDropTold(c);
      },
      {
        policy: AUTO_TASK,
        prepare: (script) => {
          script.gates.set(TASK_TEXT, first.promise);
        },
      },
    );
  },
);

test(
  'X29: when the sideband cannot take the commentary the result goes to the screen instead and is never lost',
  TIMEOUT,
  async () => {
    await withConversation(
      async (c) => {
        c.sb.canComment = false;
        await speak(c, { text: TASK_TEXT });
        await delegate(c, 'd1', 800);
        await c.rig.clock.advance(500);
        await waitUntil(c.rig, 'the screen result', () => c.shown.length === 1);
        assert.deepEqual(
          c.shown.map((entry) => entry.reason),
          ['sideband_unavailable'],
        );
        assert.deepEqual(c.sb.commentary, []);
        assert.equal(operations(c.rig).length, 1);
      },
      { policy: AUTO_TASK },
    );
  },
);

test(
  'QA35: an utterance that starts after the input was accepted but before the record is written still holds the change (the final check before the record), and a separate request then resumes it with a fresh plan',
  TIMEOUT,
  async () => {
    await withConversation(
      async (c) => {
        await speak(c, { text: TASK_TEXT });
        await delegate(c, 'd1', 800);
        // 保存の命令を送る直前に、新しい発話が始まる（入力の受付の後・保存の前）。
        c.hooks.beforeRecord = () => c.sb.speechStarted();
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the change is held at the last check',
          () => c.commits.length === 1,
        );
        // 保存の直前の再検査で止まった（保存の命令を送っていない）。
        assert.deepEqual(c.commits, ['held']);
        assert.equal(c.conversation.heldCount(c.liveId), 1);
        assert.deepEqual(operations(c.rig), []);
        assert.deepEqual(turnsOf(c.rig), []);
        assert.deepEqual(c.sb.commentary, []);
        // 別件の依頼（relation: new）で、保留を解いて再検査し、続ける。
        await secondUtterance(c);
        await waitUntil(
          c.rig,
          'both answered',
          () => c.sb.commentary.length === 2,
        );
        assert.equal(operations(c.rig).length, 2);
        assert.equal(c.conversation.heldCount(c.liveId), 0);
      },
      {
        policy: AUTO_TASK,
        prepare: (script) => {
          script.replies.set(
            EGG_TEXT,
            intentReply(
              'create_task',
              { title: '卵を買う' },
              { relation: 'new' },
            ),
          );
        },
      },
    );
  },
);

test(
  'X58: a delegation that arrives for an utterance that is a conversation operation is not interpreted, and the operation is applied once',
  TIMEOUT,
  async () => {
    await withConversation(async (c) => {
      await speak(c, { text: 'ちょっと待って' });
      await delegate(c, 'd1', 800);
      await c.rig.clock.advance(600);
      await waitUntil(
        c.rig,
        'the silence extension',
        () => controlEvents(c.rig, 'silence_extension').length >= 1,
      );
      await c.rig.clock.advance(600);
      await c.rig.wait();
      assert.equal(controlEvents(c.rig, 'silence_extension').length, 1);
      assert.deepEqual(c.script.calls, []);
      assert.deepEqual(turnsOf(c.rig), []);
      assert.deepEqual(c.sb.commentary, []);
      assert.equal(c.conversation.pendingCount, 0);
    });
  },
);

test(
  'QA35: a read is never held, so an unrelated request that starts while it is in flight is not asked back about',
  TIMEOUT,
  async () => {
    const first = gate();
    await withConversation(
      async (c) => {
        await speak(c, { text: '今日の予定を見せて' });
        await delegate(c, 'd1', 800);
        await c.rig.clock.advance(500);
        await waitUntil(
          c.rig,
          'the first interpretation',
          () => c.script.calls.length === 1,
        );
        c.sb.speechStarted();
        first.release();
        await secondUtterance(c);
        await waitUntil(
          c.rig,
          'both answered',
          () => c.sb.commentary.length === 2,
        );
        // 参照は保留されず、2 つ目（関係の記載なし）は聞き返されずに進む。
        assert.equal(operations(c.rig).length, 1);
        assert.deepEqual(
          c.sb.commentary.map((parts) => parts[0]).toSorted(),
          ['予定は2件です。', SCREEN_SENTENCE].toSorted(),
        );
        assert.equal(c.conversation.heldCount(c.liveId), 0);
        assert.deepEqual(c.dropped, []);
      },
      {
        policy: AUTO_TASK,
        prepare: (script) => {
          script.gates.set('今日の予定を見せて', first.promise);
          script.replies.set(
            EGG_TEXT,
            intentReply('create_task', { title: '卵を買う' }),
          );
        },
      },
    );
  },
);

test(
  'X58: even when the input check comes before the conversation-operation check at the same instant, the utterance is applied as an operation and never interpreted',
  TIMEOUT,
  async () => {
    await withConversation(async (c) => {
      // 断片は届いたが終了候補はまだ。委譲を受け付けてから、終了候補が来る（見直しの timer が照合の timer より先に来る並び）。
      await speak(c, { text: 'ちょっと待って', end: false });
      // 断片の 100 ms 後に委譲を受け付け（見直しは断片の 200・300 ms 後）、断片の 250 ms 後に終了候補が来る
      // （照合の timer は断片の 300 ms 後。見直しの 300 ms 後の timer のほうが先に作られている）。
      await c.rig.clock.advance(50);
      await delegate(c, 'd1', 800);
      await c.rig.clock.advance(150);
      c.sb.endCandidate();
      await c.rig.clock.advance(600);
      await waitUntil(
        c.rig,
        'the silence extension',
        () => controlEvents(c.rig, 'silence_extension').length >= 1,
      );
      await c.rig.clock.advance(600);
      await c.rig.wait();
      assert.equal(controlEvents(c.rig, 'silence_extension').length, 1);
      assert.deepEqual(c.script.calls, []);
      assert.deepEqual(turnsOf(c.rig), []);
      assert.equal(c.conversation.pendingCount, 0);
    });
  },
);
