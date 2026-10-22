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
  | { readonly kind: 'rejected'; readonly status: number; readonly code: string }
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
// - 「今日の予定を見せて」→ query_schedule（今日）
// - 「「牛乳を買う」を用事に登録して」→ create_task（題名つき）
// - 「用事を登録して」→ create_task（題名なし。必須の不足で聞き返し）
export function createMockInterpreter(): Interpreter {
  return {
    interpret(context) {
      const text = context.text.normalize('NFC').trim();
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
      if (text === '今日の予定を見せて')
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
