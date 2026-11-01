// B05 の統合のケース（会話の処理）。Live の発話（模擬のサイドバンドの出来事）と文字の依頼を共通の workflow に通し、
// 中枢の判定が端末（VoiceController・模擬の音声レンダラー）へどう届くかを確かめる。
// 期待値は b05-expectations.json の手書きの値（設計 10 §1A・§5・§6・§6A、07 §5、09 の X49・X58、ADR 0005・0052）。
import assert from 'node:assert/strict';
import { withWorld } from './b05-world.mjs';
import { attachConversation, createApiContract } from './b05-conversation.mjs';
import { commandsSince, renderer, settle, summary } from './b05-observe.mjs';
import { liveRows } from './b05-support.mjs';

// 端末が音声レンダラーへ送った命令を、チャネルと理由だけにそろえる。
const sentSince = (w, t0) =>
  commandsSince(w, t0).map(({ channel, reason }) => ({ channel, reason }));

const live = (w) => w.rig.voice.liveRecord(liveRows(w)[0].live_session_id);

// X58: 会話の操作の言い回し（短い発話の全体が照合表に一致したとき）は、LLM を呼ばず、依頼も作らず、操作ごとに別の効果で
// 端末へ届く。「ちょっと待って」は次の無音を 60 秒にするだけで再生も接続も触らない。「読み上げを止めて」は再生だけを止める。
// 依頼の言い回しが続く・丁寧な形は操作ではなく通常の意図の経路へ回る。「もう終わり」は会話を終える。
async function x58Phrases() {
  let result;
  await withWorld({}, async (w) => {
    const conv = attachConversation(w);
    await w.begin();
    w.remoteAudio();
    await w.advance(100);
    const steps = {};
    let t = w.clock.mono();

    // 0. 丁寧な形は操作ではない: 通常の意図の経路（解釈）へ回り、端末へ操作は届かない。
    const silencesBefore = w.silence.length;
    const controlsBefore = conv.controlEvents('audio_control').length;
    await conv.speak({ text: 'ちょっと待ってください' });
    await conv.delegate('d1', conv.next.start - 400);
    await w.advance(500);
    await w.advanceUntil(
      '解釈の応答',
      () => conv.sb().commentary.length === 1,
      100,
    );
    steps.polite_form = {
      model_calls: conv.script.calls,
      new_silence_extensions: w.silence.length - silencesBefore,
      renderer_commands: sentSince(w, t),
      audio_controls_added:
        conv.controlEvents('audio_control').length - controlsBefore,
      live_closure: live(w).closure,
    };

    // 以降の操作で、解釈（LLM）の呼び出しと発言が増えないことを数える。
    const base = {
      calls: conv.script.calls.length,
      turns: conv.turnsOf().length,
    };
    // 1. ちょっと待って: 無音の延長だけ。
    t = w.clock.mono();
    await conv.speak({ text: 'ちょっと待って' });
    await w.advance(400);
    await w.advanceUntil('無音の延長', () => w.silence.length === 1);
    const event = conv.controlEvents('silence_extension')[0];
    steps.wait = {
      silence_extensions: w.silence.map((entry) => entry.ms),
      event_is_valid_voice_event: createApiContract().valid(
        'VoiceEvent',
        event,
      ),
      event_has_text: JSON.stringify(event).includes('ちょっと待って'),
      renderer_commands: sentSince(w, t),
      model_calls_added: conv.script.calls.length - base.calls,
      turns_added: conv.turnsOf().length - base.turns,
      playing: w.stats().playing,
      live_closure: live(w).closure,
    };

    // 2. 読み上げを止めて: 再生だけを止める。
    t = w.clock.mono();
    await conv.speak({ text: '読み上げを止めて' });
    await w.advance(400);
    await w.advanceUntil('再生の停止', () => w.stats().playing === false);
    steps.stop_reading = {
      renderer_commands: sentSince(w, t),
      renderer: renderer(w),
      model_calls_added: conv.script.calls.length - base.calls,
      turns_added: conv.turnsOf().length - base.turns,
      live_closure: live(w).closure,
    };

    // 4. もう終わり: 会話を終える（理由は conversation_ended）。収音は保つ。
    t = w.clock.mono();
    const calls = conv.script.calls.length;
    await conv.speak({ text: 'もう終わり' });
    await w.advance(400);
    await w.advanceUntil('会話の終了', () => w.stats().live === false);
    await w.advance(3000);
    steps.end = {
      renderer_commands: sentSince(w, t),
      renderer: renderer(w),
      model_calls_added: conv.script.calls.length - calls,
      live_end_reason: liveRows(w)[0].end_reason,
      live_closure: liveRows(w)[0].closure,
      reply_mode: w.ctl.replyMode,
    };
    settle(w);
    result = summary(w, { checks: steps });
  });
  return result;
}

// X58: 会話の操作に使った発話は「委譲の対象の候補」から外れるため、直後（委譲の窓 2 秒以内）の依頼も、操作の
// 発話と並んで「対象が複数」にならずに通常どおり解釈する（操作の発話は依頼の対象ではない。U151、ADR 0064）。
// 窓の外でも同じ。どちらも依頼の内容（丁寧な形なので操作ではない）に従い、LLM は呼ぶが操作は作らない。
async function x58RequestAfterControl() {
  const SAY_AGAIN = 'うまく聞き取れませんでした。もう一度言ってください。';
  const observe = async (gapMs) => {
    let out;
    await withWorld({}, async (w) => {
      const conv = attachConversation(w);
      await w.begin();
      w.remoteAudio();
      await w.advance(100);
      await conv.speak({ text: '読み上げを止めて' });
      await w.advance(400);
      await w.advanceUntil('再生の停止', () => w.stats().playing === false);
      // Live の音声内の時刻を進める（直前の発話の終わりから gapMs 離れて次の発話を始める）。
      conv.next.start += gapMs;
      await conv.speak({ text: 'ちょっと待ってください' });
      await conv.delegate('d1', conv.next.start - 400);
      await w.advance(500);
      await w.advanceUntil(
        '応答',
        () => conv.sb().commentary.length === 1,
        100,
      );
      out = summary(w, {
        checks: {
          model_calls: conv.script.calls.length,
          asked_to_say_again: conv.sb().commentary[0][0] === SAY_AGAIN,
          operations: conv.operations().length,
          live_closure: live(w).closure,
        },
      });
    });
    return out;
  };
  const inside = await observe(0);
  const outside = await observe(3000);
  return {
    ...outside,
    checks: { right_after: inside.checks, after_the_window: outside.checks },
  };
}

// X58 / X47: 「文字で返して」で Live を閉じ、端末の返し方も文字になる。文字のうちは声の会話を始められず、声へ戻すだけでは
// 接続は戻らない（次の「続ける」で新しい接続を作る）。
async function x58ReplyInText() {
  let result;
  await withWorld({}, async (w) => {
    const conv = attachConversation(w);
    await w.begin();
    w.remoteAudio();
    await w.advance(100);
    const t = w.clock.mono();
    await conv.speak({ text: '文字で返して' });
    await w.advance(400);
    await w.advanceUntil('文字への切り替え', () => w.ctl.replyMode === 'text');
    await w.advance(3000);
    const switched = {
      renderer_commands: sentSince(w, t),
      reply_mode: w.ctl.replyMode,
      view_reply_mode: w.ctl.view().reply_mode,
      can_continue: w.ctl.view().can_continue,
      live_end_reason: liveRows(w)[0].end_reason,
      renderer_live: w.stats().live,
      model_calls: conv.script.calls.length,
      turns: conv.turnsOf().length,
    };
    const refused = await w.ctl.continueConversation();
    await w.advance(100);
    // 声へ戻す: 設定を戻すだけで、接続は作らない。
    w.ctl.setReplyMode('voice');
    await w.advance(100);
    const back = {
      reply_mode: w.ctl.replyMode,
      can_continue: w.ctl.view().can_continue,
      live_rows: liveRows(w).length,
      renderer_live: w.stats().live,
    };
    const reopened = await w.ctl.continueConversation();
    await w.advanceUntil('新しい Live', () => w.stats().live === true);
    settle(w);
    result = summary(w, {
      checks: {
        switched,
        continue_while_text: refused,
        back_to_voice: back,
        continue_after_voice: {
          outcome: reopened,
          live_rows: liveRows(w).map((row) => ({
            closure: row.closure,
            audio_epoch: row.audio_epoch,
            session_epoch: row.session_epoch,
          })),
        },
      },
    });
  });
  return result;
}

// X49: 文字で依頼した結果は、音声の接続が開いていても文字で返す（出力先は入力のときに固定する）。声の接続には何も送らず、
// 再生も触らない。HTTP の経路で voice_live を名乗る入力は受け付けない。文字の「文字で返して」も同じ効果で Live を閉じる。
async function x49TextStaysText() {
  let result;
  await withWorld({}, async (w) => {
    const conv = attachConversation(w);
    await w.begin();
    w.remoteAudio();
    await w.advance(100);
    const t = w.clock.mono();
    const typed = await conv.typed('今日の予定を見せて', 'text');
    await w.advance(100);
    await w.rig.wait();
    const answered = {
      status: typed.status,
      body_status: typed.body.status,
      view: typed.body.result_view?.kind ?? null,
      voice_commentary: conv.sb().commentary.length,
      voice_instructions: conv.sb().instructions.length,
      renderer_commands: sentSince(w, t),
      playing: w.stats().playing,
      live_closure: live(w).closure,
      turns: conv.turnsOf(),
      screen_results: conv.shown.length,
    };
    const claimed = await conv.typed('今日の予定を見せて', 'voice_live');
    const claim = {
      status: claimed.status,
      turns: conv.turnsOf().length,
      voice_commentary: conv.sb().commentary.length,
    };
    const control = await conv.typed('文字で返して', 'text');
    await w.advance(100);
    await w.advanceUntil('文字への切り替え', () => w.ctl.replyMode === 'text');
    await w.advance(3000);
    const sc = control.body;
    const switched = {
      status: control.status,
      body_status: sc.status,
      session_control: sc.session_control,
      workflow_id: sc.workflow_id,
      result_view: sc.result_view,
      renderer_commands: sentSince(w, t).slice(-1),
      reply_mode: w.ctl.replyMode,
      live_end_reason: liveRows(w)[0].end_reason,
      model_calls: conv.script.calls.length,
    };
    const later = await conv.typed('今日の予定を見せて', 'text');
    await w.advance(100);
    const afterClose = {
      status: later.status,
      body_status: later.body.status,
      view: later.body.result_view?.kind ?? null,
      voice_commentary: conv.sb().commentary.length,
    };
    settle(w);
    result = summary(w, {
      checks: {
        answered_in_text: answered,
        voice_live_over_http: claim,
        reply_in_text: switched,
        after_close: afterClose,
      },
    });
  });
  assert.ok(result);
  return result;
}

export const CONVERSATION_CASES = {
  'X58-session-control-phrases-reach-the-device': x58Phrases,
  'X58-request-right-after-a-control-phrase': x58RequestAfterControl,
  'X58-reply-in-text-switches-the-device': x58ReplyInText,
  'X49-text-request-stays-text': x49TextStaysText,
};
