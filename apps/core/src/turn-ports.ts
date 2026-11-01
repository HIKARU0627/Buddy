// 発言の解釈と対象の解決の差し込み口、模擬の解釈、試験用の方針表（設計 10 §5・§6A、09 §1〜3、ADR 0004・0029）。
//
// - 解釈（Interpreter）はモデルの代わりの差し込み口。返す値は信用しない（Core が意図表・契約・意味検証で確かめる）。
//   B04 では模擬（createMockInterpreter）を入れ、合成の入力に決まった応答を返し、知らない文は聞き返しにする。
// - 対象の解決（ProviderReader）は provider の読み取りだけの差し込み口。形は模擬 provider のアダプター（#87、
//   packages/connectors の MockMailConnector の読み取り）に合わせ、後でつなぐ。外部変更の命令は持たない。
// - 対象の候補（CandidateSource）は、解釈に渡す候補 ID と provider の対象 ID の対応。正本は同期（B07）で、
//   B04 では差し込み口に合成の対応を入れる。
// - 方針表は試験用で、自動実行はすべて off（D5。LocalCommand も画面承認を通す）。

import { INTENT_NAMES } from '@buddy/domain';
import type { IntentName } from '@buddy/domain';

export interface MailCandidate {
  // Buddy の候補 ID（契約の Id。解釈は対象をこの ID で指す）。
  readonly candidate_id: string;
  // provider のメールの ID。
  readonly remote_id: string;
}

export interface InterpretationContext {
  readonly text: string;
  // Core の時計と設定の時差から決めた今日の日付（YYYY-MM-DD）。
  readonly today: string;
  readonly mail_candidates: readonly MailCandidate[];
}

// 解釈の結果。intent・args は Core が意図表と契約（IntentArgs）で検査するまで信用しない。
export type InterpreterReply =
  | {
      readonly kind: 'intent';
      readonly intent: string;
      readonly args: Readonly<Record<string, unknown>>;
      // 直前の依頼との関係（new・clarification・correction・cancel）と、その対象の依頼の ID（B05-05、10 §5A-4）。
      // 省略・知らない値は「分からない」として扱い、保留中の変更を勝手に再開しない。コードが対象の存在・一意性を検証する。
      readonly relation?: string;
      readonly target_workflow_id?: string;
    }
  | { readonly kind: 'unclear' };

export interface Interpreter {
  interpret(context: InterpretationContext): Promise<InterpreterReply>;
}

// --- provider の読み取り（#87 のアダプターの形） ---

export interface ProviderConnection {
  readonly provider: 'mock' | 'gmail' | 'microsoft_graph';
  readonly account_id: string;
  readonly status:
    'active' | 'needs_reauth' | 'needs_attention' | 'disconnected';
  readonly access: 'read' | 'read_write';
  // 口座の表示名（承認画面で口座を見分けるための表示用）。読めなければ省略か null。
  readonly account_label?: string | null;
  // 書込みできる操作の種類（connector が許可の範囲から決める。B04-07）。省略すると access だけで判断する。
  readonly writable_kinds?: readonly string[];
  // 読める対象（connector の読み取りの種類。例: calendar.events）。省略すると接続が active なら読めるとする。
  readonly readable_kinds?: readonly string[];
}

// 対象の読み取りが今の接続の許可に含まれるか（Read の経路の権限の検査、QA27）。
export function canRead(
  connection: Pick<ProviderConnection, 'status' | 'readable_kinds'>,
  kind: string,
): boolean {
  return (
    connection.status === 'active' &&
    (connection.readable_kinds === undefined ||
      connection.readable_kinds.includes(kind))
  );
}

// 操作の種類の書込みが今の接続で許されているか（access と、あれば writable_kinds）。
export function canWrite(
  connection: Pick<ProviderConnection, 'access' | 'writable_kinds'>,
  kind: string,
): boolean {
  return (
    connection.access === 'read_write' &&
    (connection.writable_kinds === undefined ||
      connection.writable_kinds.includes(kind))
  );
}

// 返信の下書きの宛先と件名（B04-07）。宛先は返信元の差出人だけ、件名は返信元の件名に「Re: 」を付けた値
// （既に「Re:」で始まれば、大文字・小文字を問わずそのまま）。Core が返信元の読み取りから決め、モデルに作らせない
// （ADR 0004）。差出人か件名が読めなければ null（作らない・内容版を上げない）。発言の時と、送る前の確かめ直しで
// 返信元が変わった時（D1）の両方で使う。
export function replyFields(
  target: Pick<ProviderMailTarget, 'sender' | 'subject'>,
): { readonly to: readonly string[]; readonly subject: string } | null {
  const sender = target.sender ?? null;
  const subject = target.subject ?? null;
  if (
    sender === null ||
    sender.length === 0 ||
    subject === null ||
    subject.length === 0
  )
    return null;
  return {
    to: [sender],
    subject: /^re:/iu.test(subject) ? subject : `Re: ${subject}`,
  };
}

// 目印で探した下書き（結果不明の照合、by_operation_marker。読み取りだけ）。
export interface ProviderDraft {
  readonly draft_id: string;
  readonly marker: string;
  readonly in_reply_to: string | null;
}

export interface ProviderPermission {
  readonly account_id: string;
  readonly permission_revision: string;
  readonly scopes: readonly string[];
}

export interface ProviderMailTarget {
  readonly remote_id: string;
  readonly source_revision: string;
  readonly mailbox: string;
  readonly labels: readonly string[];
  // 承認画面で対象のメールを見分けるための表示用（読めなければ省略か null）。
  readonly subject?: string | null;
  readonly sender?: string | null;
  readonly received_at?: string | null;
}

export interface ProviderEvent {
  readonly event_id: string;
  readonly title: string;
  // 時差つきの ISO 8601 の日時。
  readonly start: string;
  readonly end: string;
}

export interface ProviderReader {
  // 連携の接続の状態。接続がなければ null。
  connection(): Promise<ProviderConnection | null>;
  readPermission(accountId: string): Promise<ProviderPermission | null>;
  readTarget(remoteId: string): Promise<ProviderMailTarget | null>;
  listEvents(): Promise<readonly ProviderEvent[]>;
  // 操作の目印で下書きを探す（照合だけに使う）。持たない provider では下書きの保存を実行しない。
  findDrafts?(marker: string): Promise<readonly ProviderDraft[]>;
}

// 連携の provider への書込み（B04-04、ADR 0030）。形は #87 の MockMailConnector の書込みに合わせた。
// 毎回 1 回だけ送り、自動では再送しない（再送・照合は Core の実行担当が決める）。
export interface ProviderWriteIdentity {
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly step_id?: string;
}

export type ProviderWriteOutcome<T> =
  // 相手が適用して応答した。
  | { readonly kind: 'applied'; readonly status: number; readonly value: T }
  // 相手が適用せずに拒否した（4xx）。
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly code: string;
    }
  // 接続できず、要求は送られていない。
  | { readonly kind: 'not_sent' }
  // 適用されたか分からない（時間切れ・切断・5xx・形の違う応答）。
  | { readonly kind: 'unknown'; readonly reason: string };

export interface ProviderWriter {
  changeLabels(
    identity: ProviderWriteIdentity,
    change: {
      readonly remote_id: string;
      readonly add: readonly string[];
      readonly remove: readonly string[];
    },
  ): Promise<ProviderWriteOutcome<ProviderMailTarget>>;
  // 返信の下書きの保存（B04-07）。目印（buddy-op:<operation_id>:<content_version>）を付けて 1 回だけ送る。
  // 持たない provider では下書きの保存を実行しない。
  createDraft?(
    identity: ProviderWriteIdentity,
    draft: {
      readonly in_reply_to: string;
      readonly to: readonly string[];
      readonly cc: readonly string[];
      readonly subject: string;
      readonly body: string;
      readonly marker: string;
    },
  ): Promise<ProviderWriteOutcome<{ readonly draft_id: string }>>;
}

// Core 側の故障点（tests/integration/fault-points.json の fault_points、ADR 0028）。製品では何もしない。
// 試験は @buddy/connectors の FaultInjector を渡す（構造が同じ）。
export type CoreFaultPoint =
  | 'before_approval_save'
  | 'after_approval_save'
  | 'approval_barrier'
  | 'after_target_recheck'
  | 'after_dispatch_intent_before_send'
  | 'before_result_save'
  | 'after_event_delivery_before_ack';

export interface FaultHook {
  hit(
    point: CoreFaultPoint,
    context?: {
      readonly operation_id?: string | null;
      readonly step_id?: string | null;
    },
  ): Promise<void>;
}

export const NO_FAULTS: FaultHook = { hit: () => Promise.resolve() };

export interface CandidateSource {
  mailCandidates(): Promise<readonly MailCandidate[]>;
}

// --- 試験用の方針表 ---

export interface TurnPolicy {
  readonly policy_version: string;
  // 意図ごとの自動実行（方針による自動承認）。B04-03 の試験用の表はすべて false。
  readonly auto_execution: Readonly<Record<IntentName, boolean>>;
  // Buddy 内の用事の登録先と、その保存先の許可の版（TaskOperationIntent、ADR 0027）。
  readonly task_list_id: string;
  readonly task_permission_revision: string;
}

export const TEST_TURN_POLICY: TurnPolicy = {
  policy_version: '0',
  auto_execution: Object.fromEntries(
    INTENT_NAMES.map((name) => [name, false]),
  ) as Record<IntentName, boolean>,
  task_list_id: 'inbox',
  task_permission_revision: '0',
};

// --- 模擬の解釈（モデルを使わない） ---

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

// 合成の入力と決まった応答。表にない文は聞き返し（unclear）。
// - 「mail-001 に follow-up を付けて」→ label_mail（対象は候補の対応から。候補がなければ対象なし）
// - 「今日の予定を見せて」「今日の用事を見せて」→ query_schedule（今日。UI-03 の用事の一覧のカードは後者でも置く）
// - 「「牛乳を買う」を用事に登録して」→ create_task（題名つき）
// - 「用事を登録して」→ create_task（題名なし。必須の不足で聞き返し）
// - 「mail-001 に「本文」と返信の下書きを保存して」→ draft_reply（対象は候補の対応から、本文つき。B04-07）
// - 「mail-001 に返信の下書きを保存して」→ draft_reply（本文なし。聞き返し）
export function createMockInterpreter(): Interpreter {
  return {
    interpret(context) {
      const text = context.text.normalize('NFC').trim();
      const draft =
        /^(mail-[0-9]{3}) に(?:「(.+)」と)?返信の下書きを保存して$/u.exec(text);
      if (draft !== null) {
        const candidate = context.mail_candidates.find(
          (item) => item.remote_id === draft[1],
        );
        return Promise.resolve({
          kind: 'intent',
          intent: 'draft_reply',
          args: {
            ...EMPTY_ARGS,
            target_candidate_id: candidate?.candidate_id ?? null,
            body: draft[2] ?? null,
          },
        });
      }
      const label = /^(mail-[0-9]{3}) に (\S+) を付けて$/u.exec(text);
      if (label !== null) {
        const candidate = context.mail_candidates.find(
          (item) => item.remote_id === label[1],
        );
        return Promise.resolve({
          kind: 'intent',
          intent: 'label_mail',
          args: {
            ...EMPTY_ARGS,
            target_candidate_id: candidate?.candidate_id ?? null,
            add_labels: [label[2] as string],
          },
        });
      }
      if (text === '今日の予定を見せて' || text === '今日の用事を見せて')
        return Promise.resolve({
          kind: 'intent',
          intent: 'query_schedule',
          args: { ...EMPTY_ARGS, start: context.today },
        });
      const task = /^「(.+)」を用事に登録して$/u.exec(text);
      if (task !== null)
        return Promise.resolve({
          kind: 'intent',
          intent: 'create_task',
          args: { ...EMPTY_ARGS, title: task[1] as string },
        });
      if (text === '用事を登録して')
        return Promise.resolve({
          kind: 'intent',
          intent: 'create_task',
          args: { ...EMPTY_ARGS },
        });
      return Promise.resolve({ kind: 'unclear' });
    },
  };
}
