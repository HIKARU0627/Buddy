// 評価セット（意図判定）の 1 行を tests/eval の書き出し形式 IntentEvalCase へ変換する（ADR 0008）。
// 評価データの本文はリポジトリに置かない。ここは変換規則だけで、試験は合成の行で行う。

// 評価セットのキーと IntentArgs の項目名の対応表。表にないキーは変換の失敗にする。
export const ARG_KEY_ALIASES = Object.freeze({
  date_from: 'start',
  date_to: 'end',
  target_candidate_id: 'target_candidate_id',
  start: 'start',
  end: 'end',
  due: 'due',
  title: 'title',
  body: 'body',
  subject: 'subject',
  task_change: 'task_change',
  memory_kind: 'memory_kind',
  query: 'query',
  device_name: 'device_name',
});
const DATE_FIELDS = new Set(['start', 'end', 'due']);
// 配列の書き方は評価セットで未確認のため、推測で区切らない。
const ARRAY_FIELDS = new Set(['add_labels', 'remove_labels']);

const INPUT_KINDS = Object.freeze({
  文字: 'text',
  '音声（GPT-Live-1）': 'voice_live',
  '音声（端末の認識）': 'voice_local',
});
const REVIEW_STATUSES = Object.freeze({
  確認済み: 'confirmed',
  未確認: 'unconfirmed',
  要修正: 'needs_fix',
  保留: 'on_hold',
});
const CATEGORIES = Object.freeze({
  基本: 'basic',
  日時表現: 'datetime',
  指示語: 'deixis',
  聞き返し: 'clarification',
  境界: 'boundary',
  認識誤り: 'recognition_error',
  くだけた言い方: 'casual',
  複数依頼: 'multiple_requests',
  敬語: 'honorific',
});
const OFFSET_TIME =
  /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2})?)(Z|[+-][0-9]{2}:[0-9]{2})$/u;
const DATE_ONLY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;

// 「キー=値; キー=値」を正解の引数へ。日時は本人の地域の時差と一致するものだけを地域日時にする。
export function parseExpectedArgs(text, offset) {
  const trimmed = text.trim();
  if (trimmed === '（なし）') return { ok: true, args: {} };
  if (/^[（(].*[）)]$/u.test(trimmed))
    return { ok: false, error: 'expected_args_pending' };
  const args = {};
  for (const part of trimmed.split('; ')) {
    const index = part.indexOf('=');
    if (index <= 0 || index === part.length - 1)
      return { ok: false, error: `malformed:${part}` };
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (ARRAY_FIELDS.has(key))
      return { ok: false, error: `array_format_unconfirmed:${key}` };
    const field = ARG_KEY_ALIASES[key];
    if (!field) return { ok: false, error: `unknown_arg_key:${key}` };
    if (field in args) return { ok: false, error: `duplicate_arg:${field}` };
    if (DATE_FIELDS.has(field)) {
      if (DATE_ONLY.test(value)) args[field] = value;
      else {
        const match = OFFSET_TIME.exec(value);
        if (!match) return { ok: false, error: `invalid_datetime:${key}` };
        if (match[2] !== offset)
          return { ok: false, error: `offset_mismatch:${key}` };
        args[field] = match[1];
      }
    } else args[field] = value;
  }
  return { ok: true, args };
}

// 評価セットの 1 行を IntentEvalCase へ。split・group_id・基準時刻は書き出す側が決めて渡す。
export function toEvalCase(row, options) {
  const parsed = parseExpectedArgs(row.args, options.offset);
  if (!parsed.ok) return parsed;
  const inputKind = INPUT_KINDS[row.inputKind];
  if (!inputKind) return { ok: false, error: 'unknown_input_kind' };
  const status = REVIEW_STATUSES[row.status];
  if (!status) return { ok: false, error: 'unknown_review_status' };
  const categories = [];
  for (const label of row.categories) {
    const category = CATEGORIES[label];
    if (!category) return { ok: false, error: `unknown_category:${label}` };
    categories.push(category);
  }
  const context = row.context.trim();
  return {
    ok: true,
    value: {
      schema: 'buddy.eval-case.v1',
      case_id: row.id,
      use: 'intent_args',
      split: options.split,
      group_id: options.groupId,
      review_status: status,
      input: {
        text: row.utterance,
        input_kind: inputKind,
        base_time: options.baseTime,
        zone: options.zone,
        context: context === '' || context === '—' ? null : context,
      },
      categories,
      expected: { intent: row.intent, args: parsed.args },
    },
  };
}

// 採否の集計に使える例。本人の確認済みで、判定用に分けた例だけ（05 評価の進め方、09 X57）。
export function judgmentCases(cases) {
  return cases.filter(
    (entry) =>
      entry.review_status === 'confirmed' && entry.split === 'judgment',
  );
}

// 同じ元例の言い換えが調整用と判定用にまたがっていないか（同じ group_id は同じ split）。
export function splitLeaks(cases) {
  const splits = new Map();
  for (const entry of cases) {
    const seen = splits.get(entry.group_id) ?? new Set();
    seen.add(entry.split);
    splits.set(entry.group_id, seen);
  }
  return [...splits]
    .filter(([, seen]) => seen.size > 1)
    .map(([group]) => group)
    .sort();
}
