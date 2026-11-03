// B05 の世界へ、Live（声）の会話の処理を足す。共通の workflow（createTurnRoutes）・LiveConversation・解釈（台本）を本物の
// DB worker・VoiceControl につなぎ、サイドバンドの出来事（発話の開始・文字起こしの断片・終了候補・委譲）は模擬の provider から
// 合成して送る。実際の音声・実 API は使わない。時計は世界の手で進める時計。期待値はここでは作らない。
import assert from 'node:assert/strict';
import { createApiContract } from '../../apps/core/dist/api-contract.js';
import { API_ROUTES } from '../../apps/core/dist/api-routes.js';
import { createTurnRoutes } from '../../apps/core/dist/api-turns.js';
import { uuid } from '../../apps/core/dist/budget-test-support.js';
import { DATA_KEY_MATERIAL } from '../../apps/core/dist/event-test-support.js';
import { LiveConversation } from '../../apps/core/dist/live-conversation.js';
import { PreviewRegistry } from '../../apps/core/dist/previews.js';
import {
  TEST_TURN_POLICY,
  createMockInterpreter,
} from '../../apps/core/dist/turn-ports.js';
import { A, SCOPE_A, SESSION } from './b05-world.mjs';

export { createApiContract };

// 本人の今日（2026-10-05）の予定が 2 件（重なる）の読み取り専用の provider（合成）。
const NOW = Date.parse('2026-10-05T09:00:00+09:00');
const READER = {
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
};

export const intentReply = (intent, args = {}, extra = {}) => ({
  kind: 'intent',
  intent,
  args: { ...EMPTY_ARGS, ...args },
  ...extra,
});

// 決まった文に決まった応答を返す解釈（なければ B04 の模擬）。呼ばれた文を記録する。
class Script {
  calls = [];
  replies = new Map();
  #fallback = createMockInterpreter();
  async interpret(context) {
    this.calls.push(context.text);
    return (
      this.replies.get(context.text) ??
      (await this.#fallback.interpret(context))
    );
  }
}

// 自動実行を許す方針（用事の登録だけ）。既定の方針は、4 操作も承認の対象を作らず全文の確定を案内する（U101）。
export const AUTO_TASK = {
  ...TEST_TURN_POLICY,
  auto_execution: { ...TEST_TURN_POLICY.auto_execution, create_task: true },
};

// 世界へ会話の処理をつなぐ。Live を開く前（begin の前）に呼ぶ。
export function attachConversation(world, options = {}) {
  const rig = world.rig;
  const script = new Script();
  const turns = createTurnRoutes({
    store: rig.harness.store,
    keyStore: {
      loadDataKey: () =>
        Promise.resolve({ ok: true, dataKey: DATA_KEY_MATERIAL }),
    },
    interpreter: script,
    provider: READER,
    candidates: { mailCandidates: () => Promise.resolve([]) },
    policy: options.policy ?? TEST_TURN_POLICY,
    previews: new PreviewRegistry(),
    storage: { origin: () => ({ segment_generation: '1' }) },
    utcOffset: '+09:00',
    now: () => NOW,
    onSessionControl: ({ device_id, action }) =>
      rig.voice.applySessionControlForDevice(device_id, action),
  });
  const shown = [];
  const dropped = [];
  let counter = 0;
  const conversation = new LiveConversation({
    host: rig.voice.conversationHost(),
    turns: { interpret: turns.interpret, commitLive: turns.commitLive },
    screen: {
      show: (result) => shown.push(result),
      heldDropped: (info) => dropped.push({ ...info }),
    },
    monoNow: world.clock.mono,
    timers: world.clock,
    newId: () => uuid(0x8000 + ++counter),
  });
  rig.voice.setConversation(conversation);
  const next = { index: 0, start: 0 };
  const conv = {
    script,
    turns,
    conversation,
    shown,
    dropped,
    next,
    // 今のサイドバンド（模擬の provider が最後に接続を許したもの）。
    sb: () => rig.provider.last,
    // 発話の開始 → 断片 → 終了候補。連番と音声内の時刻は持ち回る。時計は 50 ms ずつ進める。
    async speak(utterance) {
      const parts = utterance.parts ?? [utterance.text];
      if (utterance.speech !== false) conv.sb().speechStarted();
      await world.advance(50);
      let endMs = next.start;
      for (const [position, text] of parts.entries()) {
        const index =
          utterance.indexes === undefined
            ? next.index
            : (utterance.indexes[position] ?? null);
        const start = endMs;
        endMs = start + 800;
        conv.sb().fragment({ index, start_ms: start, end_ms: endMs, text });
        if (utterance.indexes === undefined) next.index += 1;
        else if (typeof index === 'number') next.index = index + 1;
        await world.advance(50);
      }
      if (utterance.end !== false) conv.sb().endCandidate();
      next.start = endMs + 400;
      return endMs;
    },
    // 委譲を送り、中枢が受け付ける（条件の確認）まで処理を進める。
    async delegate(id, offset) {
      conv.sb().delegation(id, offset);
      await rig.wait();
    },
    // 画面の発言（HTTP の postTurn）。文字の依頼。
    async typed(text, inputKind = 'text') {
      const route = API_ROUTES.find(
        (entry) => entry.operationId === 'postTurn',
      );
      assert(route !== undefined);
      const handler = turns.handlers['postTurn'];
      assert(handler !== undefined);
      return handler({
        route,
        device: A,
        body: {
          request_id: world.newId(),
          command_scope_id: SCOPE_A,
          text,
          input_kind: inputKind,
          origin: { segment_id: SESSION, segment_generation: '1' },
        },
        params: { session_id: SESSION },
        remoteAddress: '127.0.0.1',
        query: {},
        declaredLockState: 'unlocked',
      });
    },
    rows: (sql) => rig.harness.sql((db) => db.prepare(sql).all()),
    operations: () =>
      conv.rows(
        'SELECT kind, effect_route, state FROM operations ORDER BY created_at, operation_id',
      ),
    turnsOf: () =>
      conv.rows('SELECT input_kind, role FROM turns ORDER BY rowid'),
    workflowStates: () =>
      conv
        .rows('SELECT state FROM workflows ORDER BY rowid')
        .map((row) => row.state),
    controlEvents: (type) =>
      (rig.events.get(A.device_id) ?? []).filter(
        (event) => event['event_type'] === type,
      ),
  };
  return conv;
}
