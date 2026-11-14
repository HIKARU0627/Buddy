// B05 の統合のケース（Live の入力の確定）。Live の文字起こしの断片・発話の終了候補・委譲（依頼の文字を含まない）から、
// 方式 C の暫定の入力がいつ・どこまで依頼になるかを、端末（音声レンダラー）へ何も実行させずに確かめる。
// 期待値は b05-expectations.json の手書きの値（設計 07 §1、10 §5・§5A・§6、09 の QA41・X51・X27、ADR 0052）。
// 固定の文は設計の定型文（読み上げは定型句を使わず、結果の言い回しは版つきの定型文だけ。質問 99）。
import { withWorld } from './b05-world.mjs';
import {
  ALL_AUTO,
  AUTO_TASK,
  attachConversation,
  intentReply,
  uuid,
} from './b05-conversation.mjs';
import { commandsSince, settle, summary } from './b05-observe.mjs';

const TASK_TEXT = '「牛乳を買う」を用事に登録して';
const EGG_TEXT = '「卵を買う」を用事に登録して';

const sentSince = (w, t0) =>
  commandsSince(w, t0).map(({ channel, reason }) => ({ channel, reason }));

const liveId = (w) =>
  w.rig.harness.sql((db) =>
    db.prepare('SELECT live_session_id FROM live_sessions').pluck().get(),
  );

// 発話し、委譲を送り、応答（声のつなぎ）が answered 個届くまで時計を進める。
async function ask(w, conv, text, answered, offset = null) {
  const end = await conv.speak({ text });
  await conv.delegate(`d${answered}`, offset ?? end);
  await w.advance(500);
  await w.advanceUntil(
    `応答 ${answered}`,
    () => conv.sb().commentary.length === answered,
    100,
  );
}

// 1 つの世界で run を実行し、結果を観測する。
async function oneRequest(options, run) {
  let out;
  await withWorld({}, async (w) => {
    const conv = attachConversation(w, options);
    await w.begin();
    const t = w.clock.mono();
    await run(w, conv);
    settle(w);
    out = summary(w, {
      checks: {
        commentary: conv.sb().commentary,
        operations: conv.operations(),
        workflows: conv.workflowStates(),
        model_calls: conv.script.calls.length,
        renderer_commands: sentSince(w, t),
        live_closure: w.rig.voice.liveRecord(liveId(w)).closure,
      },
    });
  });
  return out;
}

// QA41: 方式 C（Live の文字起こし）から依頼になるのは、用事の登録など 4 操作の完全な観測だけで、しかも自動実行を許す方針の
// ときだけ「承認待ちの操作」になる（実行ではない）。既定の方針は、4 操作も承認の対象を作らず全文の確定を案内する。記憶の保存・
// メール送信・削除・予定の変更・忘却・表示の移動は、方針で自動実行を許していても、全文が確定するまで操作を作らない。
async function qa41FourOperations() {
  const complete = await oneRequest({ policy: AUTO_TASK }, (w, conv) =>
    ask(w, conv, TASK_TEXT, 1, 800),
  );
  const defaults = await oneRequest({}, (w, conv) =>
    ask(w, conv, TASK_TEXT, 1, 800),
  );
  const cases = [
    [
      'あしたは歯医者だと覚えておいて',
      'memory_save',
      { body: 'あしたは歯医者' },
    ],
    ['メールを送って', 'send_mail', { body: 'よろしく' }],
    ['そのメールを捨てて', 'trash_mail', { target_candidate_id: uuid(0xc1) }],
    ['予定を動かして', 'update_event', { target_candidate_id: uuid(0xc1) }],
    ['あれを忘れて', 'memory_forget', { query: 'あれ' }],
    ['こっちの画面に出して', 'handoff_screen', { device_name: '書斎' }],
  ];
  let needFull;
  await withWorld({}, async (w) => {
    const conv = attachConversation(w, { policy: ALL_AUTO });
    for (const [text, intent, args] of cases)
      conv.script.replies.set(text, intentReply(intent, args));
    await w.begin();
    const t = w.clock.mono();
    for (const [index, [text]] of cases.entries())
      await ask(w, conv, text, index + 1);
    settle(w);
    needFull = {
      commentary: conv.sb().commentary,
      operations: conv.operations(),
      workflows: conv.workflowStates(),
      snapshots: conv.snapshots(),
      memories_saved: conv.memories(),
      renderer_commands: sentSince(w, t),
    };
  });
  return {
    ...complete,
    checks: {
      complete_observation: complete.checks,
      default_policy: defaults.checks,
      never_without_full_text: needFull,
    },
  };
}

// X51: 入力が確定する前に解釈しない。終了候補が来て最後の断片から 300 ms 変化がなければ進む（299 ms では進まず、終了候補の後に
// 届いた断片は解釈する文に含める）。断片の欠落・連番なし・複数の対象・時刻の対応不明は、変更を進めずに聞き返す。
async function x51Confirmation() {
  let waits;
  await withWorld({}, async (w) => {
    const conv = attachConversation(w, { policy: AUTO_TASK });
    await w.begin();
    await conv.speak({ text: TASK_TEXT, end: false });
    await conv.delegate('d1', 800);
    // 終了候補がなければ、時間が経っても解釈に進まない（上限の 5 秒より前）。
    await w.advance(1500);
    // 委譲を受けて 1.5 秒で結果がないので、つなぎを 1 回だけ言う（B10-04 P3。解釈には進まない）。
    const beforeEnd = {
      model_calls: conv.script.calls.length,
      pending: conv.conversation.pendingCount,
      commentary: conv.sb().commentary.map((parts) => [...parts]),
    };
    conv.sb().endCandidate();
    await w.advance(100);
    await w.advanceUntil('応答', () => conv.sb().commentary.length === 2, 100);
    settle(w);
    waits = {
      before_end_candidate: beforeEnd,
      after_end_candidate: {
        model_calls: conv.script.calls,
        operations: conv.operations().length,
      },
    };
  });
  let late;
  await withWorld({}, async (w) => {
    const conv = attachConversation(w, { policy: AUTO_TASK });
    await w.begin();
    conv.sb().speechStarted();
    conv.sb().fragment({
      index: 0,
      start_ms: 0,
      end_ms: 800,
      text: '「牛乳を買う」を',
    });
    conv.sb().endCandidate();
    await conv.delegate('d1', 800);
    await w.advance(250);
    // 認識の遅れで、残りの断片が終了候補の後に届く。
    conv.sb().fragment({
      index: 1,
      start_ms: 800,
      end_ms: 1600,
      text: '用事に登録して',
    });
    await w.advance(299);
    await w.rig.wait();
    const at299 = conv.script.calls.length;
    await w.advance(101);
    // 断片から 400 ms（安定の閾値 300 ms を超えた時点）で解釈が始まっていること。これが無いと、閾値が 300 ms より
    // 長くなっても advanceUntil が上限まで待つだけで合格してしまう（上限側を確かめる）。
    await w.rig.wait();
    const at400 = conv.script.calls.length;
    await w.advanceUntil('応答', () => conv.sb().commentary.length === 1, 100);
    settle(w);
    late = {
      model_calls_at_299ms: at299,
      model_calls_at_400ms: at400,
      model_calls: conv.script.calls,
      operations: conv.operations().length,
    };
  });
  const scenarios = {
    skipped_fragment_number: async (w, conv) => {
      await conv.speak({
        text: TASK_TEXT,
        parts: ['「牛乳を買う」を', '用事に登録して'],
        indexes: [0, 2],
      });
      await conv.delegate('d1', 1600);
    },
    fragment_without_number: async (w, conv) => {
      await conv.speak({ text: TASK_TEXT, indexes: [null] });
      await conv.delegate('d1', 800);
    },
    two_utterances_before_one_delegation: async (w, conv) => {
      await conv.speak({ text: '牛乳を買う' });
      const end = await conv.speak({ text: '卵も買う' });
      await conv.delegate('d1', end);
    },
    unknown_offset: async (w, conv) => {
      await conv.speak({ text: TASK_TEXT });
      await conv.delegate('d1', null);
    },
  };
  const unconfirmed = {};
  let base;
  for (const [name, run] of Object.entries(scenarios)) {
    const out = await oneRequest({ policy: AUTO_TASK }, async (w, conv) => {
      await run(w, conv);
      await w.advance(500);
      await w.advanceUntil(
        '応答',
        () => conv.sb().commentary.length === 1,
        100,
      );
    });
    base = out;
    const {
      commentary,
      operations,
      workflows,
      renderer_commands: sent,
    } = out.checks;
    unconfirmed[name] = {
      commentary,
      operations,
      workflows,
      renderer_commands: sent,
    };
  }
  return {
    ...base,
    checks: {
      waits,
      late_fragment_restarts_300ms: late,
      unconfirmed_input: unconfirmed,
    },
  };
}

// X27・QA35: 新しい本人の発話の開始で、送出前の変更を一時保留する。保留中の変更に決まった訂正は古い変更に置き換わり（古い変更は
// 作られず、結果も読まれない）、取消は送出前に止めて取り消したと答える。どちらも操作は 1 件（訂正）か 0 件（取消）。
async function x27Held() {
  const observe = async (reply, label) => {
    let out;
    await withWorld({}, async (w) => {
      const conv = attachConversation(w, { policy: AUTO_TASK });
      conv.script.replies.set(EGG_TEXT, reply);
      const release = conv.hold(TASK_TEXT);
      await w.begin();
      await conv.speak({ text: TASK_TEXT });
      await conv.delegate('d1', 800);
      await w.advance(500);
      await w.advanceUntil(
        '1 つ目の解釈',
        () => conv.script.calls.length === 1,
        100,
      );
      // 2 つ目の発話が始まった（送出前の変更を一時保留する）。
      conv.sb().speechStarted();
      release();
      await w.advanceUntil(
        '1 つ目の変更の保留',
        () => conv.conversation.heldCount(liveId(w)) === 1,
        10,
      );
      const held = {
        operations: conv.operations().length,
        turns: conv.turnsOf().length,
        commentary: conv.sb().commentary.length,
      };
      await conv.speak({ text: EGG_TEXT, speech: false });
      await conv.delegate('d2', conv.next.start - 400);
      await w.advance(500);
      await w.advanceUntil(
        `${label}の応答`,
        () => conv.sb().commentary.length === 1,
        100,
      );
      settle(w);
      out = summary(w, {
        checks: {
          while_held: held,
          commentary: conv.sb().commentary,
          operations: conv.operations(),
          // 確定した操作の意図を復号し、訂正後の依頼（卵を買う）が操作になったことを内容で確かめる。
          operation_intents: conv.operationIntents(),
          // 古い依頼の入力と訂正後の入力の状態（操作の内容は operation_intents で確かめる）。
          snapshots: conv
            .snapshots()
            .map((row) => ({ origin: row.origin, state: row.state })),
          workflows: conv.workflowStates(),
          turns: conv.turnsOf(),
          screen_results: conv.shown.length,
          held_after: conv.conversation.heldCount(liveId(w)),
        },
      });
    });
    return out;
  };
  const correction = await observe(
    intentReply(
      'create_task',
      { title: '卵を買う' },
      { relation: 'correction', target_workflow_id: uuid(0x8001) },
    ),
    '訂正',
  );
  const cancelled = await observe(
    intentReply(
      'smalltalk',
      {},
      { relation: 'cancel', target_workflow_id: uuid(0x8001) },
    ),
    '取消',
  );
  // 取消の発話自体を発言として残すかは設計に決めがない（記録の有無は比べない）。
  const { turns: ignored, ...cancel } = cancelled.checks;
  void ignored;
  return {
    ...correction,
    checks: { correction: correction.checks, cancel },
  };
}

export const INPUT_CASES = {
  'QA41-live-input-four-operations-need-full-text': qa41FourOperations,
  'X51-input-is-confirmed-before-it-is-interpreted': x51Confirmation,
  'X27-held-change-is-superseded-or-cancelled': x27Held,
};
