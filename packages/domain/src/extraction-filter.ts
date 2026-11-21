// 抽出前フィルター（LLM に送らない条件）と判定の記録（B10-05 P3、ADR 0102）。設計 11 §2、設計 09 X38・X62、QA10。
// - 条件 A（自動配信と判定）と条件 B（期限・依頼・変更の手がかりがない）の**両方**を満たすメールだけを LLM の解析から外す。
// - 条件 B は件名・本文（引用を除く）・許可範囲内で選んだ添付の抽出テキストをすべて見る。対象の添付が未取得・読取失敗・
//   切詰めなら条件 B は未確定で、期限なしとして外さない（取得範囲を広げない）。
// - 外した結果（解析済み／自動配信のため未解析）は本文なしのメタデータとして持ち、診断に件数を出す。気づきには出さない。
// - 宛先・自動配信の判定（addressed_to_me・from_automated_sender）はヘッダーからコードが決める。モデルに判定させない。
import { isQuotedLine } from './extraction-source.js';

// --- ヘッダーの事実（条件 A・宛先） ---

export interface PrefilterHeaders {
  // Auto-Submitted ヘッダーの値。無ければ null。
  readonly auto_submitted: string | null;
  // Precedence ヘッダーの値。無ければ null。
  readonly precedence: string | null;
  // List-Unsubscribe ヘッダーがあるか。
  readonly has_list_unsubscribe: boolean;
  // 送信者のローカル部（@ の前）。
  readonly from_local_part: string;
  // text/calendar の招待か。
  readonly is_calendar_invite: boolean;
}

const AUTOMATED_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'no-reply',
  'noreply',
  'donotreply',
  'mailer-daemon',
  'notification',
  'notifications',
  'newsletter',
]);

const BULK_PRECEDENCE: ReadonlySet<string> = new Set(['bulk', 'list', 'junk']);

// 条件 A を満たす理由（空なら満たさない）。大文字小文字を区別しない。
export function automatedSenderReasons(
  headers: PrefilterHeaders,
): readonly string[] {
  const reasons: string[] = [];
  // Auto-Submitted は "no" 以外の値（auto-generated・auto-replied など）。パラメーター（; 以降）は見ない。
  const auto = headers.auto_submitted?.split(';')[0]?.trim().toLowerCase();
  if (auto !== undefined && auto !== '' && auto !== 'no')
    reasons.push('auto_submitted');
  const precedence = headers.precedence?.trim().toLowerCase();
  if (precedence !== undefined && BULK_PRECEDENCE.has(precedence))
    reasons.push('precedence_bulk');
  if (headers.has_list_unsubscribe) reasons.push('list_unsubscribe');
  if (AUTOMATED_LOCAL_PARTS.has(headers.from_local_part.trim().toLowerCase()))
    reasons.push('automated_local_part');
  return reasons;
}

export interface MailRecipients {
  readonly to: readonly string[];
  readonly cc: readonly string[];
}

const normalizeAddress = (address: string): string =>
  address.trim().toLowerCase();

export interface MessageFactsOfHeaders {
  readonly addressed_to_me: boolean;
  readonly from_automated_sender: boolean;
}

// 宛先と自動配信の判定。To に本人のアドレスがあるときだけ本人宛て（CC だけは false）。
export function deriveMessageFacts(
  headers: PrefilterHeaders,
  recipients: MailRecipients,
  ownAddresses: readonly string[],
): MessageFactsOfHeaders {
  const own = new Set(ownAddresses.map(normalizeAddress));
  return {
    addressed_to_me: recipients.to.some((address) =>
      own.has(normalizeAddress(address)),
    ),
    from_automated_sender: automatedSenderReasons(headers).length > 0,
  };
}

// --- 条件 B（手がかり） ---

export type CueCategory = 'date' | 'deadline' | 'request' | 'change';

// 設計 11 §2 の語。含まれていれば手がかりありとする（広めに拾う側。外しすぎない）。
const DATE_PATTERNS: readonly RegExp[] = [
  /[0-9０-９]{1,2}\s*月\s*[0-9０-９]{1,2}\s*日/u,
  /[0-9０-９]{4}\s*[/／.\-－]\s*[0-9０-９]{1,2}\s*[/／.\-－]\s*[0-9０-９]{1,2}/u,
  /[月火水木金土日]曜/u,
  /明日|明後日|今週|来週|今月末|本日中/u,
  // 設計の語の一覧より広く拾う（期限を黙って落とさない側。U246）。
  // 年なしの「11/30」「11/20（金）」と、「20日」「11月」だけの表現。
  /[0-9０-９]{1,2}\s*[/／]\s*[0-9０-９]{1,2}/u,
  /[0-9０-９]{1,2}\s*[日月]/u,
  // 英語: 月名と日（Nov 20・20 November）、曜日、相対語。
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+[0-9]{1,2}\b/iu,
  /\b[0-9]{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/iu,
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu,
  /\b(?:mon|tue|wed|thu|fri|sat|sun)[.,]/iu,
  /\b(?:today|tomorrow|tonight|next\s+(?:week|month)|this\s+(?:week|month)|end\s+of\s+(?:the\s+)?(?:day|week|month)|eod|asap)\b/iu,
];
const DEADLINE_WORDS: readonly string[] = [
  '締切',
  '締め切り',
  '〆切',
  '期限',
  '期日',
  'までに',
  'deadline',
  'due',
];
const REQUEST_WORDS: readonly string[] = [
  '返信',
  'ご返答',
  '回答',
  'お返事',
  'ご連絡',
  '提出',
  '参加可否',
  '出欠',
  'rsvp',
  'reply',
  'respond',
  'confirm',
];
const CHANGE_WORDS: readonly string[] = [
  '取消',
  '取り消し',
  '中止',
  '不要',
  '完了',
  '対応済み',
  '訂正',
  '変更',
  'cancel',
  'complete',
  'no longer required',
];

// 引用された行（行頭が `>`）を除く。引用の中だけにある語は、このメールの手がかりに数えない。
export function withoutQuotedLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !isQuotedLine(line))
    .join('\n');
}

// 手がかりの種類（空なら手がかりなし）。
export function cueCategories(text: string): readonly CueCategory[] {
  const lower = text.toLowerCase();
  const found: CueCategory[] = [];
  if (DATE_PATTERNS.some((pattern) => pattern.test(text))) found.push('date');
  if (DEADLINE_WORDS.some((word) => lower.includes(word.toLowerCase())))
    found.push('deadline');
  if (REQUEST_WORDS.some((word) => lower.includes(word.toLowerCase())))
    found.push('request');
  if (CHANGE_WORDS.some((word) => lower.includes(word.toLowerCase())))
    found.push('change');
  return found;
}

// --- 判定 ---

export interface PrefilterAttachment {
  // 本人が許可した取得範囲（J16）の添付か。範囲外は見ない・取得しない。
  readonly permitted: boolean;
  readonly state: 'extracted' | 'unread' | 'failed';
  readonly text: string | null;
  // 抽出テキストが途中までしかないか。
  readonly truncated: boolean;
}

export interface PrefilterMail {
  readonly subject: string;
  // 本文が未取得なら null。
  readonly body: string | null;
  readonly attachments: readonly PrefilterAttachment[];
}

export interface PrefilterContext {
  // 本人が「このメールを見て」と頼んだ。フィルターに関係なく解析する。
  readonly user_requested: boolean;
  // 同じスレッドに依頼候補・依頼抽出待ち・自動実行履歴がある。この除外を根拠に関連解析を完了扱いにしない。
  readonly thread_has_activity: boolean;
  // 設定画面で ON（既定 ON、質問 102）。OFF なら全て解析する。
  readonly filter_enabled: boolean;
}

export const PREFILTER_RULE_ID = 'prefilter_automated_no_cue_v1';

export type PrefilterReason =
  | 'user_requested'
  | 'filter_disabled'
  | 'thread_activity'
  | 'not_automated'
  | 'cue_found'
  | 'cue_undetermined'
  | 'calendar_invite'
  | 'automated_no_cue';

export type PrefilterDecision =
  // LLM で解析する。
  | { readonly kind: 'analyze'; readonly reasons: readonly PrefilterReason[] }
  // 自動配信で手がかりがないので LLM に送らない（条件 A かつ B）。
  | {
      readonly kind: 'skip_automated';
      readonly rule_id: typeof PREFILTER_RULE_ID;
      readonly reasons: readonly PrefilterReason[];
    }
  // text/calendar の招待。LLM に送らず、予定はカレンダー連携で扱う。
  | {
      readonly kind: 'handled_elsewhere';
      readonly reasons: readonly PrefilterReason[];
    };

// 条件 B。手がかりがあれば 'cue'、読めていない範囲があれば 'undetermined'、全て読めて手がかりがなければ 'none'。
// 手がかりがあれば、読めていない範囲が残っていても 'cue'（どのみち解析する）。
function conditionB(mail: PrefilterMail): 'cue' | 'undetermined' | 'none' {
  const texts: string[] = [mail.subject];
  let undetermined = false;
  if (mail.body === null) undetermined = true;
  else texts.push(withoutQuotedLines(mail.body));
  for (const attachment of mail.attachments) {
    if (!attachment.permitted) continue;
    if (attachment.state !== 'extracted' || attachment.text === null)
      undetermined = true;
    else {
      texts.push(attachment.text);
      if (attachment.truncated) undetermined = true;
    }
  }
  if (texts.some((text) => cueCategories(text).length > 0)) return 'cue';
  return undetermined ? 'undetermined' : 'none';
}

export function prefilterDecision(
  headers: PrefilterHeaders,
  mail: PrefilterMail,
  context: PrefilterContext,
): PrefilterDecision {
  // 本人の依頼が起点のときは、フィルターにも招待の扱いにも関係なく解析する（設計 11 §2 の例外）。
  if (context.user_requested)
    return { kind: 'analyze', reasons: ['user_requested'] };
  if (headers.is_calendar_invite)
    return { kind: 'handled_elsewhere', reasons: ['calendar_invite'] };
  if (!context.filter_enabled)
    return { kind: 'analyze', reasons: ['filter_disabled'] };
  // 取消・完了は新しい期限や依頼語がなくても解析の対象。同じスレッドに依頼・履歴があるメールは外さない。
  if (context.thread_has_activity)
    return { kind: 'analyze', reasons: ['thread_activity'] };
  if (automatedSenderReasons(headers).length === 0)
    return { kind: 'analyze', reasons: ['not_automated'] };
  const b = conditionB(mail);
  if (b === 'cue') return { kind: 'analyze', reasons: ['cue_found'] };
  if (b === 'undetermined')
    return { kind: 'analyze', reasons: ['cue_undetermined'] };
  return {
    kind: 'skip_automated',
    rule_id: PREFILTER_RULE_ID,
    reasons: ['automated_no_cue'],
  };
}

// --- 判定の記録（本文なしのメタデータ。診断用。気づきには出さない） ---

export interface PrefilterRecord {
  readonly source_account_id: string;
  readonly message_id: string;
  readonly source_revision: string;
  readonly decision: 'analyzed' | 'skipped_automated' | 'handled_elsewhere';
  readonly reasons: readonly PrefilterReason[];
  // 外したときの規則 ID（関連解析で excluded の根拠になる）。外していなければ null。
  readonly rule_id: string | null;
  // 判定した時刻（ISO 8601）。
  readonly decided_at: string;
}

export function prefilterRecord(
  message: {
    readonly source_account_id: string;
    readonly message_id: string;
    readonly source_revision: string;
  },
  decision: PrefilterDecision,
  decidedAt: string,
): PrefilterRecord {
  return {
    source_account_id: message.source_account_id,
    message_id: message.message_id,
    source_revision: message.source_revision,
    decision:
      decision.kind === 'analyze'
        ? 'analyzed'
        : decision.kind === 'skip_automated'
          ? 'skipped_automated'
          : 'handled_elsewhere',
    reasons: decision.reasons,
    rule_id: decision.kind === 'skip_automated' ? decision.rule_id : null,
    decided_at: decidedAt,
  };
}

export interface PrefilterCounts {
  readonly analyzed: number;
  readonly skipped_automated: number;
  readonly handled_elsewhere: number;
}

// 診断画面に出す件数。同じメッセージ・版の記録は最後の判定だけを数える（再判定で二重に数えない）。
export function prefilterCounts(
  records: readonly PrefilterRecord[],
): PrefilterCounts {
  const latest = new Map<string, PrefilterRecord>();
  for (const record of records)
    latest.set(
      JSON.stringify([
        record.source_account_id,
        record.message_id,
        record.source_revision,
      ]),
      record,
    );
  const counts = { analyzed: 0, skipped_automated: 0, handled_elsewhere: 0 };
  for (const record of latest.values()) counts[record.decision] += 1;
  return counts;
}
