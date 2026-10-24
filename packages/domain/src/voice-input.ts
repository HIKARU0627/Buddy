// 音声の委譲の入力の規則（B05-02、ADR 0041。設計 10 §5・§5A・§6A、07 §1、09 X51・QA05・QA08・QA41・X58）。
// 方式 A（区間リングと sealed・blocked）、方式 C の 4 操作の限定、Live と端末の ASR の比較、会話の操作の照合。
// 音声は扱わない（フレームの番号と sample の範囲だけ）。sealed は入力区間を固定したという意味で、
// 誤認識がないことでも実行の許可でもない（実行の可否は readiness.ts と 08 の最終検査）。

import {
  normalizeUtterance,
  matchSessionControl,
  type SessionControlAction,
} from './conversation.js';
import type { InputKind } from './audio.js';
import { INTENT_POLICIES, type IntentName } from './intents.js';
import { SESSION_CONTROL_EFFECTS, type SessionControlEffect } from './voice.js';

// ---- 方式 A: 区間リング・sealed・blocked（10 §5A） ---------------------------------------------------------------

export const SEGMENT_SAMPLE_RATE = 16000;
export const SEGMENT_CHANNELS = 1;
export const SEGMENT_BITS_PER_SAMPLE = 16;
// リングの上限は 60 秒。超えた区間は実行の入力に使わず、文字入力か区切った再入力へ案内する。
export const SEGMENT_RING_MAX_SECONDS = 60;
export const SEGMENT_RING_CAPACITY_SAMPLES =
  SEGMENT_RING_MAX_SECONDS * SEGMENT_SAMPLE_RATE;
// 15 秒を超える区間が見込まれるときは、先につなぎ発話を出す（10 §5A）。
export const SEGMENT_BRIDGE_SECONDS = 15;

export interface RingFrame {
  // 連続する番号。再接続・端末交代で audio_epoch が変わる。
  readonly frame_seq: number;
  readonly start_sample: number;
  readonly sample_count: number;
}

export interface SegmentRing {
  readonly audio_epoch: string;
  readonly frames: readonly RingFrame[];
  // 容量を超えて捨てた sample の数。0 でなければ、捨てた範囲を含む区間は truncated。
  readonly evicted_samples: number;
}

export const emptyRing = (audio_epoch: string): SegmentRing => ({
  audio_epoch,
  frames: [],
  evicted_samples: 0,
});

export type RingPush =
  | {
      readonly ok: true;
      readonly ring: SegmentRing;
      readonly duplicate: boolean;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid_frame'
        | 'frame_seq_regressed'
        | 'frame_conflict'
        | 'audio_epoch_changed';
    };

const isCount = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

// フレームを足す。同じ番号・同じ内容の再配送は冪等に無視し、番号が戻る・同じ番号で内容が違うものは拒否する。
// 番号や sample の飛び（欠落）はここでは拒否せず（後から届く順序の入れ替えを拒否で壊さない）、sealSegment が見つける。
// 上限（60 秒分の sample）を超えたら古いフレームから捨てる。世代が違うフレームは入れない。
export function pushFrame(
  ring: SegmentRing,
  audio_epoch: string,
  frame: RingFrame,
): RingPush {
  if (audio_epoch !== ring.audio_epoch)
    return { ok: false, reason: 'audio_epoch_changed' };
  if (
    !isCount(frame.frame_seq) ||
    !isCount(frame.start_sample) ||
    !Number.isSafeInteger(frame.sample_count) ||
    frame.sample_count <= 0 ||
    frame.sample_count > SEGMENT_RING_CAPACITY_SAMPLES
  )
    return { ok: false, reason: 'invalid_frame' };
  const last = ring.frames.at(-1);
  if (last !== undefined) {
    if (frame.frame_seq === last.frame_seq)
      return last.start_sample === frame.start_sample &&
        last.sample_count === frame.sample_count
        ? { ok: true, ring, duplicate: true }
        : { ok: false, reason: 'frame_conflict' };
    if (frame.frame_seq < last.frame_seq)
      return { ok: false, reason: 'frame_seq_regressed' };
  }
  const frames = [...ring.frames, frame];
  let total = frames.reduce((sum, entry) => sum + entry.sample_count, 0);
  let evicted = ring.evicted_samples;
  while (total > SEGMENT_RING_CAPACITY_SAMPLES) {
    const dropped = frames.shift();
    if (dropped === undefined) break;
    total -= dropped.sample_count;
    evicted += dropped.sample_count;
  }
  return {
    ok: true,
    duplicate: false,
    ring: { audio_epoch: ring.audio_epoch, frames, evicted_samples: evicted },
  };
}

export interface SegmentRequest {
  readonly audio_epoch: string;
  // [start_sample, end_sample)。対象ターンの区間。
  readonly start_sample: number;
  readonly end_sample: number;
  // Live の offset と端末の sample の対応を確かめられたか（B05 で検証する。確かめられなければ blocked）。
  readonly live_offset_mapping: 'verified' | 'unknown';
  // 委譲の対象のターンの数（1 でなければ blocked）。
  readonly target_turn_count: number;
  readonly asr: 'pending' | 'completed' | 'failed';
}

export interface SegmentVerdict {
  readonly state: 'sealed' | 'collecting' | 'blocked';
  readonly reasons: readonly string[];
  readonly truncated: boolean;
  // 15 秒を超える区間。先につなぎ発話を出す。
  readonly bridge_first: boolean;
  // sealed のときだけ。sealed は固定の意味で、誤認識がないという意味ではない。
  readonly input_evidence: 'full_audio_segment' | null;
  readonly seal_reason: 'local_asr_segment' | null;
  readonly guidance: 'text_or_resplit' | 'ask_again' | null;
}

// 区間を sealed にしてよいか。区間全体を取得でき（フレームの番号と sample が途切れず）、ASR が完了したときだけ sealed。
// blocked: 世代が変わった・区間が 60 秒を超えた（truncated）・フレームの欠落・offset の対応が確かめられない・
//   対象のターンが 1 つでない・ASR の失敗。collecting: 区間の終わりまで取得できていない・ASR の完了待ち。
export function sealSegment(
  ring: SegmentRing,
  segment: SegmentRequest,
): SegmentVerdict {
  const blocked: string[] = [];
  const collecting: string[] = [];
  let truncated = false;
  const result = (): SegmentVerdict => {
    const state: SegmentVerdict['state'] =
      blocked.length > 0
        ? 'blocked'
        : collecting.length > 0
          ? 'collecting'
          : 'sealed';
    return {
      state,
      reasons: [...blocked, ...collecting],
      truncated,
      bridge_first:
        Number.isSafeInteger(segment.start_sample) &&
        Number.isSafeInteger(segment.end_sample) &&
        segment.end_sample - segment.start_sample >
          SEGMENT_BRIDGE_SECONDS * SEGMENT_SAMPLE_RATE,
      input_evidence: state === 'sealed' ? 'full_audio_segment' : null,
      seal_reason: state === 'sealed' ? 'local_asr_segment' : null,
      guidance: truncated
        ? 'text_or_resplit'
        : state === 'blocked'
          ? 'ask_again'
          : null,
    };
  };
  if (segment.audio_epoch !== ring.audio_epoch) {
    blocked.push('audio_epoch_changed');
    return result();
  }
  const { start_sample: start, end_sample: end } = segment;
  if (!isCount(start) || !isCount(end) || end <= start) {
    blocked.push('invalid_segment');
    return result();
  }
  if (end - start > SEGMENT_RING_CAPACITY_SAMPLES) {
    truncated = true;
    blocked.push('segment_truncated');
  } else {
    const first = ring.frames[0];
    if (first === undefined || start < first.start_sample) {
      if (ring.evicted_samples > 0) {
        truncated = true;
        blocked.push('segment_truncated');
      } else blocked.push('frame_gap');
    } else {
      const inside = ring.frames.filter(
        (frame) =>
          frame.start_sample + frame.sample_count > start &&
          frame.start_sample < end,
      );
      let gap = false;
      for (let i = 1; i < inside.length; i += 1) {
        const before = inside[i - 1] as RingFrame;
        const after = inside[i] as RingFrame;
        if (
          after.frame_seq !== before.frame_seq + 1 ||
          after.start_sample !== before.start_sample + before.sample_count
        )
          gap = true;
      }
      const head = inside[0];
      if (head === undefined || head.start_sample > start) gap = true;
      if (gap) blocked.push('frame_gap');
      else {
        const tail = inside.at(-1) as RingFrame;
        if (tail.start_sample + tail.sample_count < end) {
          // 区間の終わりまで取得できていない。区間の後ろに、つながらない後続のフレームがすでに届いていれば、
          // 間のフレームは後から届いても番号の逆行として拒否されるので、取得待ちではなく既知の欠落（blocked）。
          if (ring.frames.some((frame) => frame.frame_seq > tail.frame_seq))
            blocked.push('frame_gap');
          else collecting.push('segment_not_fully_captured');
        }
      }
    }
  }
  if (segment.live_offset_mapping !== 'verified')
    blocked.push('offset_mapping_unverified');
  if (segment.target_turn_count !== 1) blocked.push('target_turn_not_unique');
  if (segment.asr === 'failed') blocked.push('asr_failed');
  else if (segment.asr === 'pending') collecting.push('asr_incomplete');
  return result();
}

// ---- 方式 C: 4 操作の限定（10 §5A、09 X51・QA41。質問 130） ----------------------------------------------------

// Live の文字起こしから進めてよい自動実行の 4 操作（D05）。用事・メモの登録、ラベルの変更、返信の下書きの保存、
// 自分だけの予定の作成。これ以外（画面承認が要る操作・記憶の保存・表示先の移動を含む）は全文の確定か方式 A・③へ戻す。
export const METHOD_C_OPERATIONS = [
  'register_task_or_note',
  'change_label',
  'save_reply_draft',
  'create_own_event',
] as const;
export type MethodCOperation = (typeof METHOD_C_OPERATIONS)[number];

const METHOD_C_BY_INTENT: Readonly<
  Partial<Record<IntentName, MethodCOperation>>
> = {
  create_task: 'register_task_or_note',
  create_note: 'register_task_or_note',
  label_mail: 'change_label',
  draft_reply: 'save_reply_draft',
  create_event: 'create_own_event',
};

// 発話終了候補の後、最後の断片から変化がない時間（ms）。経過だけでは ready にしない。
export const METHOD_C_STABLE_MS = 300;

export interface MethodCFacts {
  // 発話終了候補（端末の VAD。無音 0.8 秒）を観測した。
  readonly end_candidate_observed: boolean;
  // 時刻対応を確かめられた対象範囲の文字起こしがそろっている。
  readonly target_range_mapped: boolean;
  // 最後の断片から変化がない時間。
  readonly stable_ms: number;
  readonly known_fragment_gap: boolean;
  readonly target_turn_unique: boolean;
  readonly unresolved_correction: boolean;
  readonly missing_args: boolean;
  // 新しい本人の発話の開始による一時保留（10 §5A-3）。
  readonly utterance_hold: boolean;
  // 暫定方針の版（live_transcript_policy には必須）。
  readonly policy_version: string | null;
  // 予定が自分だけのもの（他の参加者・宛先がない。J11）。
  readonly own_event_only: boolean;
}

export type MethodCAdmission =
  | { readonly decision: 'read_allowed' }
  | {
      readonly decision: 'proceed';
      readonly operation: MethodCOperation;
      readonly input_evidence: 'live_policy_observed';
      readonly seal_reason: 'live_transcript_policy';
    }
  | { readonly decision: 'blocked'; readonly reasons: readonly string[] }
  | {
      readonly decision: 'requires_full_text';
      readonly reasons: readonly string[];
    };

// 方式 C から進めてよいか。参照と聞き返しは入力が確定していなくてもよい（read_allowed）。変更は、観測の条件がすべて
// 成立し 4 操作に当たるときだけ proceed。条件が欠ければ blocked（既知の欠落・対応不明・未解決の訂正も C で blocked）、
// 4 操作でなければ requires_full_text（全文の確定・方式 A・③へ戻す。C のまま画面承認へ昇格させない）。
// proceed でも、実行の可否は readiness.ts と 08 の最終検査が別に決める（C の観測条件の成立は完全性の証明ではない）。
export function admitMethodC(
  intent: IntentName,
  facts: MethodCFacts,
): MethodCAdmission {
  if (INTENT_POLICIES[intent].route === 'read')
    return { decision: 'read_allowed' };
  const blocked: string[] = [];
  if (!facts.end_candidate_observed) blocked.push('end_candidate_missing');
  if (!facts.target_range_mapped) blocked.push('time_mapping_unconfirmed');
  if (!(facts.stable_ms >= METHOD_C_STABLE_MS)) blocked.push('not_stable');
  if (facts.known_fragment_gap) blocked.push('known_fragment_gap');
  if (!facts.target_turn_unique) blocked.push('target_turn_not_unique');
  if (facts.unresolved_correction) blocked.push('unresolved_correction');
  if (facts.missing_args) blocked.push('missing_args');
  if (facts.utterance_hold) blocked.push('utterance_hold');
  if (facts.policy_version === null || facts.policy_version === '')
    blocked.push('policy_version_missing');
  if (blocked.length > 0) return { decision: 'blocked', reasons: blocked };
  const operation = METHOD_C_BY_INTENT[intent];
  if (operation === undefined)
    return {
      decision: 'requires_full_text',
      reasons: ['outside_four_operations'],
    };
  if (operation === 'create_own_event' && !facts.own_event_only)
    return { decision: 'requires_full_text', reasons: ['event_not_own_only'] };
  return {
    decision: 'proceed',
    operation,
    input_evidence: 'live_policy_observed',
    seal_reason: 'live_transcript_policy',
  };
}

// ---- Live の文字起こしと端末の ASR の比較（方式 A。10 §5A、QA08） -------------------------------------------

export type TranscriptDifference =
  'number' | 'datetime' | 'negation' | 'recipient';

export interface TranscriptComparison {
  readonly action: 'proceed' | 'ask_back';
  readonly differences: readonly TranscriptDifference[];
  readonly reasons: readonly string[];
}

const KANJI_DIGITS: Readonly<Record<string, number>> = {
  〇: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const KANJI_UNITS: Readonly<Record<string, number>> = {
  十: 10,
  百: 100,
  千: 1000,
};

// 数字と漢数字の連なりを数にする（十・百・千・万と、位取りの「二〇二六」、「3千」「1万5千」のような混在）。
// 変える必要がない連なり（アラビア数字だけ）と、読めない連なりは null。
function numberRunToValue(run: string): number | null {
  const tokens = run.match(/\d+|[〇一二三四五六七八九十百千万]/gu) ?? [];
  const hasUnit = tokens.some(
    (token) => token in KANJI_UNITS || token === '万',
  );
  if (!hasUnit) {
    if (/^\d+$/u.test(run)) return null;
    let digits = '';
    for (const token of tokens) {
      const digit = KANJI_DIGITS[token];
      digits += digit === undefined ? token : String(digit);
    }
    return digits === '' ? null : Number(digits);
  }
  let total = 0;
  let section = 0;
  let current = 0;
  for (const token of tokens) {
    const digit = KANJI_DIGITS[token];
    const unit = KANJI_UNITS[token];
    if (digit !== undefined) current = digit;
    else if (/^\d+$/u.test(token)) current = Number(token);
    else if (unit !== undefined) {
      section += (current === 0 ? 1 : current) * unit;
      current = 0;
    } else {
      total += (section + current === 0 ? 1 : section + current) * 10000;
      section = 0;
      current = 0;
    }
  }
  return total + section + current;
}

const READING_TO_WORD: ReadonlyArray<readonly [string, string]> = [
  ['あさって', '明後日'],
  ['あした', '明日'],
  ['きょう', '今日'],
  ['きのう', '昨日'],
  ['らいしゅう', '来週'],
  ['こんしゅう', '今週'],
  ['せんしゅう', '先週'],
  ['らいげつ', '来月'],
  ['こんげつ', '今月'],
  ['らいねん', '来年'],
];

const COUNTER_AFTER_KANJI = '年月日時分秒週回個件円人本枚番歳';
// 小数も 1 つの値として単位まで取る（「1.5時間」と「1.5分」を区別する）。
const DATETIME_TOKEN =
  /\d+(?:\.\d+)?(?:年|月|日|時間|時|分|秒|週間|か月|週)|明々後日|明後日|明日|一昨日|昨日|今日|再来週|来週|今週|先週|再来月|来月|今月|先月|来年|去年|今年|午前|午後|正午|夕方|今晩|今朝|明朝|[月火水木金土日]曜日?/gu;
const NUMBER_TOKEN = /\d+(?:\.\d+)?[円個件人本枚番歳回]?/gu;
// 数字・日時は、出現順と、範囲の役割（から・まで・より）を保って並べる（「3時から5時へ」と「5時から3時へ」を区別する）。
const VALUE_TOKEN = new RegExp(
  `(?:${DATETIME_TOKEN.source})|(?:${NUMBER_TOKEN.source})`,
  'gu',
);
const ROLE_SUFFIX = /^(?:から|まで|より)/u;
const NEGATION = /ません|ない|なかっ|なく|ぬ|ず|なし|[不無未非]/gu;
// 否定は、その直前の 3 文字（対象の述語）と組にして順に並べる（差分の説明のため。判定の正本ではない）。
const NEGATION_TARGET_CHARS = 3;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gu;
const HONORIFIC =
  '(?:さん|さま|様|せんせい|先生|どの|殿|くん|君|ちゃん|氏|あて|宛)';
const HONORIFIC_NAME = new RegExp(
  `([\\p{Script=Han}]{1,6}|[\\p{Script=Hiragana}]{2,8}|[a-z]{2,16})${HONORIFIC}`,
  'gu',
);
const HONORIFIC_TAIL = new RegExp(`${HONORIFIC}$`, 'u');
// 送る表現（に・へ + 送る・返信・メール・連絡・転送・伝える）の直前を宛先とする（差分の説明のため。判定の正本ではない）。
// 敬称がなくても、漢字・ひらがな・カタカナ・英字のどの書き方でも取り出す（カタカナは折りたたむ前の文字で見る）。
const SEND_EXPRESSION = '(?:送|返信|メール|めーる|連絡|転送|伝え)';
const BEFORE_SEND = new RegExp(
  `([\\p{Script=Han}々]+|[\\p{Script=Hiragana}]+|[\\p{Script=Katakana}ー]+|[a-z]+)(?:に|へ|宛て?|あて)(?=${SEND_EXPRESSION})`,
  'gu',
);
const RECIPIENT_MAX_CHARS = 10;
// 危険な印（送る表現・否定・数字・日時・宛先の印「に・へ」・敬称・メールアドレス）。どちらかの文に 1 つでもあれば、
// 正規化した文の全体が一致しなければ聞き返す（抽出の取りこぼしで見逃さない安全側の方針。ADR 0041、U36）。
const RISK_MARKER = new RegExp(
  [
    SEND_EXPRESSION,
    NEGATION.source,
    '\\d',
    DATETIME_TOKEN.source,
    '[にへ]',
    HONORIFIC,
  ].join('|'),
  'u',
);

interface TranscriptFeatures {
  // 出現順（範囲の役割つき）。並べ替えない。
  readonly numbers: string[];
  readonly datetimes: string[];
  // 否定ごとの対象（直前の文字）。出現順。
  readonly negations: string[];
  readonly recipients: string[];
}

const foldKana = (text: string): string =>
  text.replace(/[ァ-ヶ]/gu, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60),
  );

interface NormalizedText {
  // 折りたたむ前の文字（カタカナのまま）。折りたたみは文字数を変えないので、位置は folded と同じ。
  readonly raw: string;
  readonly folded: string;
  // 読み・漢数字・曜日・敬称をそろえた、比較用の文。
  readonly normalized: string;
}

// 正規化（NFKC・小文字・漢数字を数へ・「半」・曜日・敬称・カタカナをひらがなへ・記号と空白の除去）。
// 正規化の細部は原本に決めなし（初期の規則。B05 の実測で調整する）。
function normalizeText(text: string): NormalizedText {
  let t = text.normalize('NFKC').toLowerCase();
  t = t.replace(/[ヶヵケ]月/gu, 'か月');
  t = t.replace(
    new RegExp(
      `[0-9〇一二三四五六七八九十百千万]+(?=[${COUNTER_AFTER_KANJI}])`,
      'gu',
    ),
    (run) => {
      const value = numberRunToValue(run);
      return value === null ? run : String(value);
    },
  );
  t = t.replace(/(\d+)時半/gu, '$1時30分');
  t = t.replace(/(?<=\d)[,，](?=\d{3})/gu, '');
  t = t.replace(/[\s\p{P}\p{S}]/gu, (mark) => (mark === '.' ? mark : ''));
  const raw = t.replace(/(?<!\d)\.|\.(?!\d)/gu, '');
  const folded = foldKana(raw);
  let normalized = folded;
  for (const [reading, word] of READING_TO_WORD)
    normalized = normalized.split(reading).join(word);
  normalized = normalized
    .replace(/([月火水木金土日])曜日/gu, '$1曜')
    .replace(/様|さま/gu, 'さん');
  return { raw, folded, normalized };
}

// 数字・日時・否定・宛先を取り出す。差分の説明（differences）のための補助で、聞き返すかどうかの正本ではない
// （危険な印のある文は、文の全体の一致で決める）。
function transcriptFeatures(text: string): TranscriptFeatures {
  const nfkc = text.normalize('NFKC').toLowerCase();
  const recipients: string[] = [];
  const withoutMail = nfkc.replace(EMAIL, (mail) => {
    recipients.push(mail);
    return '';
  });
  const { raw, folded, normalized } = normalizeText(withoutMail);

  const numbers: string[] = [];
  const datetimes: string[] = [];
  for (const match of normalized.matchAll(VALUE_TOKEN)) {
    const after = normalized.slice((match.index ?? 0) + match[0].length);
    const role = ROLE_SUFFIX.exec(after)?.[0] ?? '';
    if (new RegExp(`^(?:${DATETIME_TOKEN.source})$`, 'u').test(match[0]))
      datetimes.push(`${match[0].replace(/曜日$/u, '曜')}${role}`);
    else numbers.push(`${match[0]}${role}`);
  }
  const negations: string[] = [];
  for (const match of normalized.matchAll(NEGATION)) {
    const at = match.index ?? 0;
    negations.push(
      normalized.slice(Math.max(0, at - NEGATION_TARGET_CHARS), at),
    );
  }

  // 宛先は名前だけで取り出す（さん・様・宛のような敬称は外す）。
  for (const match of normalized.matchAll(HONORIFIC_NAME))
    recipients.push(match[1] as string);
  // 数字・日時の文字は宛先の候補から外す（「15時に送って」の「時」を名前にしない）。
  let masked = raw;
  for (const match of folded.matchAll(VALUE_TOKEN)) {
    const at = match.index ?? 0;
    masked =
      masked.slice(0, at) +
      '\u0001'.repeat(match[0].length) +
      masked.slice(at + match[0].length);
  }
  for (const match of masked.matchAll(BEFORE_SEND)) {
    let name = foldKana(match[1] as string);
    for (const [reading, word] of READING_TO_WORD)
      name = name.split(reading).join(word);
    name = name.replace(new RegExp(DATETIME_TOKEN.source, 'gu'), '');
    name = name.replace(HONORIFIC_TAIL, '');
    name = name.slice(-RECIPIENT_MAX_CHARS);
    if (name !== '') recipients.push(name);
  }
  return {
    numbers,
    datetimes,
    negations,
    recipients: [...new Set(recipients)].filter((name) => name !== '').sort(),
  };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

// Live の文字断片と端末の ASR の結果を比べ、危険な印のある文は、正規化した文の全体が一致しなければ実行せず聞き返す。
// 危険な印（送る表現・否定・数字・日時・宛先の印の「に・へ」・敬称・メールアドレス）が、2 つの文のどちらかに 1 つでもあれば、
// 全体の一致だけが proceed で、抽出（数字・日時・否定・宛先）は差分の説明のための補助にとどめる。抽出の取りこぼし
// （混在表記・送信動詞から離れた宛先・否定の対象の入れ替わりなど）で見逃さないため。危険な印がない文は、4 種類の特徴の比較のまま。
// どちらかが空・ASR がない（null）ときは比べられないので聞き返す。一致しても、完全一致や誤認識のなさの証明ではない
// （C は照合の成功を前提にしない。QA08）。
export function compareTranscripts(
  live: string,
  asr: string | null,
): TranscriptComparison {
  if (asr === null)
    return { action: 'ask_back', differences: [], reasons: ['asr_missing'] };
  const reasons: string[] = [];
  if (live.normalize('NFKC').trim() === '')
    reasons.push('live_transcript_empty');
  if (asr.normalize('NFKC').trim() === '') reasons.push('asr_transcript_empty');
  if (reasons.length > 0)
    return { action: 'ask_back', differences: [], reasons };
  const a = transcriptFeatures(live);
  const b = transcriptFeatures(asr);
  const differences: TranscriptDifference[] = [];
  if (!sameList(a.numbers, b.numbers)) differences.push('number');
  if (!sameList(a.datetimes, b.datetimes)) differences.push('datetime');
  if (!sameList(a.negations, b.negations)) differences.push('negation');
  if (!sameList(a.recipients, b.recipients)) differences.push('recipient');
  const liveText = normalizeText(live).normalized;
  const asrText = normalizeText(asr).normalized;
  // メールアドレスは、記号を除く正規化で「@」が消えるので、元の文で見る。
  const hasMail = (text: string): boolean =>
    text.normalize('NFKC').includes('@');
  const risky =
    RISK_MARKER.test(liveText) ||
    RISK_MARKER.test(asrText) ||
    hasMail(live) ||
    hasMail(asr);
  const textDiffers = liveText !== asrText;
  const ask = differences.length > 0 || (risky && textDiffers);
  return {
    action: ask ? 'ask_back' : 'proceed',
    differences,
    reasons:
      differences.length > 0
        ? differences.map((kind) => `${kind}_differs`)
        : ask
          ? ['text_differs']
          : [],
  };
}

// ---- 会話の操作の照合（SessionControlPhrases。10 §3・§5、X58） --------------------------------------------------

export interface SessionControlTable {
  readonly version: string;
  readonly phrases: readonly {
    readonly phrase: string;
    readonly action: string;
  }[];
}

// 照合表の意味検査（形は Schema）。版は先頭ゼロのない正の整数の文字列、言い回しは正規化したあとに空でなく、
// 知らない操作（cancel_workflow を含む）を持たず、同じ言い回しを別の操作に結び付けない。
export function sessionControlTableErrors(
  table: SessionControlTable,
): string[] {
  const errors: string[] = [];
  if (!/^[1-9][0-9]*$/u.test(table.version)) errors.push('version_not_numeric');
  if (table.phrases.length === 0) errors.push('no_phrases');
  const seen = new Map<string, string>();
  for (const entry of table.phrases) {
    const phrase = normalizeUtterance(entry.phrase);
    if (phrase === '') errors.push('empty_phrase');
    if (!(entry.action in SESSION_CONTROL_EFFECTS))
      errors.push('unknown_action');
    const before = seen.get(phrase);
    if (before !== undefined && before !== entry.action)
      errors.push('ambiguous_phrase');
    seen.set(phrase, entry.action);
  }
  return [...new Set(errors)];
}

export interface SessionControlResolution {
  readonly action: SessionControlAction;
  readonly effect: SessionControlEffect;
  // 照合に当たったら意図判定（LLM）を呼ばない。
  readonly bypass_intent_llm: true;
  // 開いている Live（①）の接続への操作として行う。②③は画面の操作と同じ処理で、接続はない。
  readonly applies_to_live_connection: boolean;
}

// 短い発話の全体が言い回しに一致したときだけ会話の操作にする。依頼を含む発話・言い回しの一部だけの発話・
// 処理の取り消し（cancel_workflow は照合表にない別の命令）は null（通常の意図判定へ回す）。
export function resolveSessionControl(
  utterance: string,
  table: SessionControlTable,
  inputKind: InputKind,
): SessionControlResolution | null {
  if (sessionControlTableErrors(table).length > 0) return null;
  const action = matchSessionControl(
    utterance,
    table.phrases as readonly {
      readonly phrase: string;
      readonly action: SessionControlAction;
    }[],
  );
  if (action === null) return null;
  const effect = SESSION_CONTROL_EFFECTS[action];
  return {
    action,
    effect,
    bypass_intent_llm: true,
    applies_to_live_connection:
      inputKind === 'voice_live' &&
      (effect.audio_action !== null || effect.extends_silence_ms !== null),
  };
}
