import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INTENT_NAMES,
  REPLY_TEXT_INTENTS,
  REPLY_TEXT_MAX_CHARS,
  admitReplyText,
} from '../packages/domain/dist/index.js';

// B10-04（ADR 0105。contract-map U217 の本人決定 (b)）: モデルの返答文 reply_text を吹き出しに出してよい境界の手書きの検査。
// 出すのは「文字で返す入力（②文字・③音声→文字）の smalltalk・general_question」だけで、平文として検査してから出す。
// 期待値は domain の実装から作らない。合成の文だけを使い、実 API・実音声は使わない。
// 見えない文字は、ソースに直接書かず文字コードから作る。
const c = (...codes) => String.fromCharCode(...codes);
const NUL = c(0x00);
const BEL = c(0x07);
const TAB = c(0x09);
const DEL = c(0x7f);
const NEL = c(0x85);
const ZWSP = c(0x200b);
const BOM = c(0xfeff);
const WORD_JOINER = c(0x2060);
const RLO = c(0x202e);

const show = (text) => ({ decision: 'show', text });
const hide = (reason) => ({ decision: 'hide', reason });
const admit = (reply_text, intent = 'smalltalk', input_kind = 'text') =>
  admitReplyText({ intent, input_kind, reply_text });

test('reply text: the limit is 400 characters, the target intents are the two read intents, and other values are not assumed', () => {
  assert.equal(REPLY_TEXT_MAX_CHARS, 400);
  assert.deepEqual([...REPLY_TEXT_INTENTS], ['smalltalk', 'general_question']);
});

test('reply text: a plain reply to smalltalk or a general question is shown for typed input and for local speech recognition', () => {
  for (const intent of ['smalltalk', 'general_question'])
    for (const kind of ['text', 'voice_local'])
      assert.deepEqual(
        admit('こんにちは。今日もがんばりましょう。', intent, kind),
        show('こんにちは。今日もがんばりましょう。'),
        `${intent}/${kind}`,
      );
});

test('reply text: every other intent is never shown, even when the text is plain and the input is typed', () => {
  for (const intent of INTENT_NAMES) {
    if (REPLY_TEXT_INTENTS.includes(intent)) continue;
    for (const kind of ['text', 'voice_local', 'voice_live'])
      assert.deepEqual(
        admit('はい、承知しました。', intent, kind),
        hide('intent_not_allowed'),
        `${intent}/${kind}`,
      );
  }
});

test('reply text: input from the live voice connection never shows the model sentence, for both target intents', () => {
  for (const intent of REPLY_TEXT_INTENTS)
    assert.deepEqual(
      admit('こんにちは。', intent, 'voice_live'),
      hide('voice_output'),
      intent,
    );
});

test('reply text: a missing, blank or control-only text is hidden', () => {
  for (const value of [
    null,
    undefined,
    '',
    '   ',
    '\n\n',
    NUL + BEL,
    ZWSP + RLO,
  ])
    assert.deepEqual(admit(value), hide('empty'));
});

test('reply text: control and direction-changing characters are removed, and line breaks are normalized', () => {
  assert.deepEqual(admit(`こん${NUL}に${BEL}ち${RLO}は`), show('こんにちは'));
  assert.deepEqual(
    admit(`あ${ZWSP}い${BOM}う${WORD_JOINER}え`),
    show('あいうえ'),
  );
  assert.deepEqual(admit('a\r\nb\rc'), show('a\nb\nc'));
  assert.deepEqual(admit('a\n\n\n\nb'), show('a\n\nb'));
  assert.deepEqual(admit('  こんにちは\n'), show('こんにちは'));
  // 改行以外の制御文字（タブ・DEL・C1）。
  assert.deepEqual(admit(`あ${TAB}い${DEL}う${NEL}え`), show('あいうえ'));
});

test('reply text: the length limit counts characters after removal, shows the limit exactly and hides one more without cutting', () => {
  assert.deepEqual(admit('あ'.repeat(400)), show('あ'.repeat(400)));
  assert.deepEqual(admit('あ'.repeat(401)), hide('too_long'));
  // 取り除く文字は数えない。
  assert.deepEqual(
    admit(`${'あ'.repeat(400)}${NUL}${ZWSP}`),
    show('あ'.repeat(400)),
  );
  // 1 文字は 1 コードポイントで数える（サロゲートペアを 2 文字にしない）。
  assert.deepEqual(admit('😀'.repeat(400)), show('😀'.repeat(400)));
  assert.deepEqual(admit('😀'.repeat(401)), hide('too_long'));
});

test('reply text: anything shaped like a link or a markup link is hidden, including one hidden by invisible characters', () => {
  for (const value of [
    'http://example.com',
    'こちらをどうぞ https://example.com/a?b=c',
    'FTP://example.com',
    'www.example.com を見てください',
    'mailto:someone@example.com',
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///etc/hosts',
    'tel:0000000000',
    '[詳しくはこちら](example)',
    '<a href="x">こちら</a>',
    '<script>x</script>',
    '<img src="x">',
    `ht${ZWSP}tp://example.com`,
  ])
    assert.deepEqual(admit(value), hide('link_in_text'), value);
});

test('reply text: ordinary text that only resembles those words is not hidden', () => {
  for (const value of [
    'ホテルの予約は tel ではなく画面からできます。',
    'profile: 山田さん',
    'データ: 3 件',
    'a < b かつ b > c です。',
    '1 + (2 * 3) = 7',
  ])
    assert.deepEqual(admit(value), show(value), value);
});

test('reply text: the order of the checks is intent, then input kind, then text', () => {
  // 対象でない意図は、入力の種類が声でも文が空でもその理由が先。
  assert.deepEqual(
    admit(null, 'create_task', 'voice_live'),
    hide('intent_not_allowed'),
  );
  // 声の入力は、文が空でもリンクでも「声には使わない」が先。
  assert.deepEqual(
    admit('http://example.com', 'smalltalk', 'voice_live'),
    hide('voice_output'),
  );
});
