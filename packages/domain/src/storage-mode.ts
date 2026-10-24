// 記録しない会話（保存モードの private）の保存の境界（設計 03 保存期限・記録しない会話の境界、10 §1A・§6、
// 09 X17・X36・X44・X48・X59、ADR 0032・0038・0040・0045）。
// 純粋な規則だけを持つ。Core の StorageModeGate（B06-07）が呼び、DB・音声・キャンバスへの副作用は命令として返す。
// 安全の境界なので、決まっていない・判別できない値は記録しない側・禁止の側に倒す。

import type { IntentName } from './intents.js';
import { RETENTION_RULES, turnRetentionRule } from './retention.js';

export const STORAGE_MODE_NAMES = ['normal', 'extended', 'private'] as const;
export type StorageModeName = (typeof STORAGE_MODE_NAMES)[number];

export const isStorageModeName = (value: unknown): value is StorageModeName =>
  typeof value === 'string' &&
  (STORAGE_MODE_NAMES as readonly string[]).includes(value);

// ---- 保存モードごとの許可表 -------------------------------------------------------------------------------

// 表の行。persist_* は Buddy 内への永続化（DB・スナップショット・イベントの記録・ログ）を指す。
// 既存の保存先と行の対応は ADR 0045 の「保存先の分類」。
export const STORAGE_EFFECTS = [
  // 発言の本文（sessions / turns と本文の sealed_blobs）。
  'persist_turns',
  // 発言のイベント（event_outbox。07 §4 の「記録しない会話の発言のイベントは永続化しない」）。
  'persist_turn_events',
  // 会話の要約・区切りをつなぐ要約（sessions.summary_blob_id、ADR 0032 の CarriedSummary）。
  'persist_summary',
  // 入力の版（input_snapshots）。
  'persist_input_snapshot',
  // 聞き返しの保留（PendingClarification の scope が session。private では ram_only。ADR 0005）。
  'persist_clarification',
  // 「今回は」の指示（user_directives の this_time。区切りの終わりで捨てる。ADR 0032）。
  'persist_this_time_directive',
  // 「今後は」の指示（user_directives の from_now_on。設定として残る）。
  'persist_from_now_on_directive',
  // 記憶の保存（本人の明示依頼の memory_save を含む。X59）。
  'save_memory',
  // 会話の終了時・無発言時の記憶の抽出（X44）。
  'extract_memory',
  // 影モードの比較記録（intent_shadow。X48）。
  'record_shadow',
  // 会話から作った派生物の要約・抄録（request_entities・related_analyses・notification_candidates の題・抄録）。
  'persist_derived_summary',
  // 依頼の行（workflows。session_id を必須にする）。
  'persist_workflow',
  // 完了した依頼の結果・未確定案（03 の「完了した依頼の結果」。7 日）。
  'persist_workflow_result',
  // 発言の受付の応答の記録（turn_responses。同じ要求の再送に同じ応答を返すため）。
  'persist_turn_response',
  // 受付の記録（command_receipts。本文なしの ID・結果。7 日）。
  'persist_command_receipt',
  // Live（GPT-Live-1）の接続を開く（X17・X36）。
  'open_live',
  // 端末内で文字にする③（質問 110）。
  'local_asr',
  // 保存してよいキャンバスの記述への書き込み（ADR 0032 の CanvasStore.persisted・スナップショット）。
  'write_persisted_canvas',
  // 記録しない区切りの間だけ RAM に持つ一時のキャンバスの記述（CanvasStore.ephemeral）。
  'write_ephemeral_canvas',
  // 会話・依頼（session・workflow・入力の版）につながる通常の操作の記録。
  'record_full_operation',
  // 独立した確認の後の最小の操作記録（ADR 0040 U42。会話へたどれる ID を持たない）。
  'record_minimal_operation',
  // 予算の予約の行（会話の内容を持たない。J4・ADR 0040）。
  'reserve_budget',
] as const;
export type StorageEffect = (typeof STORAGE_EFFECTS)[number];

export const isStorageEffect = (value: unknown): value is StorageEffect =>
  typeof value === 'string' &&
  (STORAGE_EFFECTS as readonly string[]).includes(value);

// after_independent_confirmation: 独立した確認の画面で本人が一度承認したときだけ許す。
export type StoragePermission =
  'allow' | 'deny' | 'after_independent_confirmation';

const NORMAL_PERMISSIONS: Readonly<Record<StorageEffect, StoragePermission>> = {
  persist_turns: 'allow',
  persist_turn_events: 'allow',
  persist_summary: 'allow',
  persist_input_snapshot: 'allow',
  persist_clarification: 'allow',
  persist_this_time_directive: 'allow',
  persist_from_now_on_directive: 'allow',
  save_memory: 'allow',
  extract_memory: 'allow',
  record_shadow: 'allow',
  persist_derived_summary: 'allow',
  persist_workflow: 'allow',
  persist_workflow_result: 'allow',
  persist_turn_response: 'allow',
  persist_command_receipt: 'allow',
  open_live: 'allow',
  local_asr: 'allow',
  write_persisted_canvas: 'allow',
  // 一時の記述は記録しない区切りの間だけある。通常の区切りでは書く先がない。
  write_ephemeral_canvas: 'deny',
  record_full_operation: 'allow',
  // 通常の区切りの操作は通常の記録だけ（record_kind は normal）。
  record_minimal_operation: 'deny',
  reserve_budget: 'allow',
};

export const STORAGE_MODE_PERMISSIONS: Readonly<
  Record<StorageModeName, Readonly<Record<StorageEffect, StoragePermission>>>
> = {
  normal: NORMAL_PERMISSIONS,
  extended: NORMAL_PERMISSIONS,
  private: {
    persist_turns: 'deny',
    persist_turn_events: 'deny',
    persist_summary: 'deny',
    persist_input_snapshot: 'deny',
    persist_clarification: 'deny',
    persist_this_time_directive: 'deny',
    // 原本に決めなし。UserDirective は会話と発言の ID を必須にしていて、記録しない会話にはその行がない（ADR 0045）。
    persist_from_now_on_directive: 'deny',
    save_memory: 'deny',
    extract_memory: 'deny',
    record_shadow: 'deny',
    persist_derived_summary: 'deny',
    persist_workflow: 'deny',
    persist_workflow_result: 'deny',
    persist_turn_response: 'deny',
    persist_command_receipt: 'deny',
    open_live: 'deny',
    local_asr: 'allow',
    write_persisted_canvas: 'deny',
    write_ephemeral_canvas: 'allow',
    record_full_operation: 'deny',
    record_minimal_operation: 'after_independent_confirmation',
    reserve_budget: 'allow',
  },
};

export type StorageDenyReason =
  | 'storage_mode_unknown'
  | 'effect_unknown'
  | 'denied_in_mode'
  | 'independent_confirmation_required';

export type StorageDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: StorageDenyReason };

// 表の 1 つの升目の判定。知らない保存モード・知らない行は、すべて禁止にする（③・一時のキャンバス・予算の予約も）。
// independentConfirmationApproved は true（真偽値の true）のときだけ承認済みとして扱う。
export function storageModeDecision(
  mode: unknown,
  effect: unknown,
  context: { readonly independentConfirmationApproved?: unknown } = {},
): StorageDecision {
  if (!isStorageModeName(mode))
    return { allowed: false, reason: 'storage_mode_unknown' };
  if (!isStorageEffect(effect))
    return { allowed: false, reason: 'effect_unknown' };
  const permission = STORAGE_MODE_PERMISSIONS[mode][effect];
  if (permission === 'allow') return { allowed: true };
  if (permission === 'deny')
    return { allowed: false, reason: 'denied_in_mode' };
  return context.independentConfirmationApproved === true
    ? { allowed: true }
    : { allowed: false, reason: 'independent_confirmation_required' };
}

// 契約の StorageModeState の effects（ADR 0040）を表から作る。知らない保存モードは null。
export interface StorageModeStateEffects {
  readonly persist_turns: boolean;
  readonly persist_summary: boolean;
  readonly save_memory: boolean;
  readonly extract_memory: boolean;
  readonly record_shadow: boolean;
  readonly open_live: boolean;
  readonly local_asr: boolean;
  readonly turn_retention_days: number | null;
  readonly operation_record: 'full' | 'minimal_after_confirmation';
}

const DAY_MS = 86_400_000;

export function storageModeStateEffects(
  mode: unknown,
): StorageModeStateEffects | null {
  if (!isStorageModeName(mode)) return null;
  const table = STORAGE_MODE_PERMISSIONS[mode];
  const rule = turnRetentionRule(mode);
  const retention = rule === null ? undefined : RETENTION_RULES[rule];
  return {
    persist_turns: table.persist_turns === 'allow',
    persist_summary: table.persist_summary === 'allow',
    save_memory: table.save_memory === 'allow',
    extract_memory: table.extract_memory === 'allow',
    record_shadow: table.record_shadow === 'allow',
    open_live: table.open_live === 'allow',
    local_asr: table.local_asr === 'allow',
    turn_retention_days: retention === undefined ? null : retention.ms / DAY_MS,
    operation_record:
      table.record_full_operation === 'allow'
        ? 'full'
        : 'minimal_after_confirmation',
  };
}

// ---- 記録しない会話から外部変更を頼まれたときの、独立した確認の中身（ADR 0040 U42・ADR 0045） ------------------
//
// 確認の中身は、Core が解決した確定済みの変更（契約の OperationIntent）と、その内容の hash だけ。解釈の段階の引数
// （INTENT_POLICIES）は使わない。元サービスへ実際に渡す内容（宛先・件名・本文・ラベル）が揃っていなければ拒否する。
// 対象（target）の ID と版は、Core が元サービスの読み取りから解決した値を入れる前提で、domain は型と形だけを検査する。
// 確定した型が契約にない外部変更（送信・予定・ごみ箱など）は、型ができるまで記録しない会話からは切り出さない。

export const PRIVATE_CONFIRMATION_FIELDS = [
  'operation',
  'content_hash',
] as const;
const OPERATION_FIELDS = [
  'schema',
  'operation_id',
  'content_version',
  'permission_revision',
  'provider',
  'account_id',
  'target',
  'action',
  'effects',
] as const;
const TARGET_FIELDS = ['remote_id', 'source_revision'] as const;
const EFFECTS_FIELDS = ['external_recipients', 'reconcile_scope'] as const;
const PROVIDERS = ['mock', 'gmail', 'microsoft_graph'] as const;
export const PRIVATE_APPROVAL_FIELDS = [
  'route',
  'device_id',
  'approved_at',
  'segment_generation',
  'operation_id',
  'content_version',
  'content_hash',
] as const;

// 記録しない会話から切り出せる確定済みの変更の種類。キーは OperationIntent の action.kind。
const CONFIRMABLE_KINDS = {
  'mail.labels.change': 'label_mail',
  'mail.draft.create': 'draft_reply',
} as const satisfies Readonly<Record<string, IntentName>>;
type ConfirmableKind = keyof typeof CONFIRMABLE_KINDS;
// 契約にはあるが Buddy 内の変更（LocalCommand）なので切り出さない種類。
const LOCAL_KINDS = ['task.create'];

export interface PrivateTargetLike {
  readonly remote_id: string;
  readonly source_revision: string;
}

export type PrivateOperationAction =
  | {
      readonly kind: 'mail.labels.change';
      readonly add: readonly string[];
      readonly remove: readonly string[];
    }
  | {
      readonly kind: 'mail.draft.create';
      readonly to: readonly string[];
      readonly cc: readonly string[];
      readonly subject: string;
      readonly body: string;
    };

// 契約の LabelOperationIntent・DraftReplyOperationIntent と同じ形。
export interface PrivateConfirmedOperation {
  readonly schema: 'buddy.operation.v1';
  readonly operation_id: string;
  readonly content_version: string;
  readonly permission_revision: string;
  readonly provider: (typeof PROVIDERS)[number];
  readonly account_id: string;
  readonly target: PrivateTargetLike;
  readonly action: PrivateOperationAction;
  readonly effects: {
    readonly external_recipients: readonly [];
    readonly reconcile_scope: 'exact_target' | 'operation_marker';
  };
}

export interface PrivateConfirmationContent {
  readonly intent: 'label_mail' | 'draft_reply';
  readonly operation: PrivateConfirmedOperation;
  // 確定した operation 全体の JCS＋SHA-256（Core が求める。domain は形だけを検査する）。
  readonly content_hash: string;
}

export interface PrivateApprovalLike {
  readonly route: 'screen';
  readonly device_id: string;
  readonly approved_at: string;
}

// 確認の画面に出すもの。記録する内容と「会話の内容は保存されない」こと。
export interface PrivateConfirmationView extends PrivateConfirmationContent {
  readonly conversation_saved: false;
}

// 承認の後に残す最小の操作記録。会話・区切り・依頼へのつながりを持たない（workflow_id は null）。
export interface PrivateMinimalRecord extends PrivateConfirmationContent {
  readonly record_kind: 'private_minimal';
  readonly workflow_id: null;
  readonly approval: PrivateApprovalLike;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
// 元サービスの対象 ID（OriginalSourceId と同じ文字種。空白・日本語の文を入れられない）。
const ORIGINAL_SOURCE_ID = /^[A-Za-z0-9._:=+~-]{1,256}$/u;
// 元サービスの版（etag・履歴 ID など）。空白のない表示可能な ASCII に限る（文を入れられない）。契約の SourceRevision
// より狭い（空白や日本語を含む版は、記録しない会話からは切り出さない）。
const SOURCE_REVISION = /^[\x21-\x7e]{1,256}$/u;
const UTC_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9](\.[0-9]+)?Z$/u;
// 宛先（RFC 5322 の厳密な検査ではなく、空白・制御文字・区切りの記号（, < >）のない local@domain の形と長さだけ。
// 「名前 <addr>」や複数の宛先を 1 つの要素に入れられない）。
const MAIL_ADDRESS = /^[^\s@\p{Cc},<>]{1,64}@[^\s@\p{Cc},<>]{1,189}$/u;
// 1 行の文字列（ラベル名・件名）に制御文字を入れられない。本文は改行とタブだけを許す。
const CONTROL = /\p{Cc}/u;
const BODY_CONTROL = /[^\P{Cc}\n\r\t]/u;
const LABEL_MAX = 225;
const LABELS_MAX = 100;
const SUBJECT_MAX = 998;
const BODY_MAX = 100_000;
const RECIPIENTS_MAX = 100;

// UTC の時刻の形で、実在する日時か（2030-02-31 のような値は Date が翌月へ繰り上げるので、書き戻して比べる）。
function utcTimeOk(value: unknown): boolean {
  if (!matches(value, UTC_TIME)) return false;
  const time = Date.parse(value);
  return (
    !Number.isNaN(time) &&
    new Date(time).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === 'string' && pattern.test(value);

function keyErrors(
  value: Record<string, unknown>,
  fields: readonly string[],
  prefix: string,
): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(value).sort())
    if (!fields.includes(key)) errors.push(`${prefix}field_not_allowed:${key}`);
  for (const key of fields)
    if (!Object.hasOwn(value, key))
      errors.push(`${prefix}field_missing:${key}`);
  return errors;
}

// 文字列の配列（重複なし・件数の上限・各要素の検査）。
function stringListOk(
  value: unknown,
  max: number,
  item: (text: string) => boolean,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    // 疎な配列（穴）は every が飛ばすので、Array.from で穴を undefined にしてから確かめる。
    Array.from(value as unknown[]).every(
      (entry) => typeof entry === 'string' && item(entry),
    ) &&
    new Set(value).size === value.length
  );
}

const labelOk = (text: string): boolean =>
  text.length > 0 &&
  text.length <= LABEL_MAX &&
  text.trim() === text &&
  !CONTROL.test(text);
const addressOk = (text: string): boolean =>
  text.length <= 254 && MAIL_ADDRESS.test(text);

// 確定済みの変更の検査。理由は決まった順に返す。
function operationErrors(operation: unknown): string[] {
  if (!isRecord(operation)) return ['operation_not_object'];
  const errors = keyErrors(operation, OPERATION_FIELDS, 'operation_');
  if (operation['schema'] !== 'buddy.operation.v1')
    errors.push('operation_schema_invalid');
  if (!matches(operation['operation_id'], UUID_V4))
    errors.push('operation_id_invalid');
  if (!matches(operation['content_version'], DECIMAL))
    errors.push('content_version_invalid');
  if (!matches(operation['permission_revision'], DECIMAL))
    errors.push('permission_revision_invalid');
  if (!(PROVIDERS as readonly unknown[]).includes(operation['provider']))
    errors.push('provider_invalid');
  if (!matches(operation['account_id'], UUID_V4))
    errors.push('account_id_invalid');
  const target = operation['target'];
  if (!isRecord(target)) errors.push('target_not_object');
  else {
    errors.push(...keyErrors(target, TARGET_FIELDS, 'target_'));
    if (!matches(target['remote_id'], ORIGINAL_SOURCE_ID))
      errors.push('target_remote_id_invalid');
    if (!matches(target['source_revision'], SOURCE_REVISION))
      errors.push('target_source_revision_invalid');
  }
  const action = operation['action'];
  const kind = isRecord(action) ? action['kind'] : undefined;
  if (!isRecord(action)) errors.push('action_not_object');
  else if (typeof kind === 'string' && LOCAL_KINDS.includes(kind))
    errors.push('intent_not_external_change');
  else if (kind === 'mail.labels.change') {
    errors.push(...keyErrors(action, ['kind', 'add', 'remove'], 'action_'));
    const add = action['add'];
    const remove = action['remove'];
    const addOk = stringListOk(add, LABELS_MAX, labelOk);
    const removeOk = stringListOk(remove, LABELS_MAX, labelOk);
    if (!addOk) errors.push('labels_add_invalid');
    if (!removeOk) errors.push('labels_remove_invalid');
    if (addOk && removeOk) {
      if (add.length === 0 && remove.length === 0) errors.push('labels_empty');
      if (add.some((label) => remove.includes(label)))
        errors.push('labels_conflicting');
    }
  } else if (kind === 'mail.draft.create') {
    errors.push(
      ...keyErrors(action, ['kind', 'to', 'cc', 'subject', 'body'], 'action_'),
    );
    const to = action['to'];
    const cc = action['cc'];
    const toOk = stringListOk(to, RECIPIENTS_MAX, addressOk) && to.length > 0;
    const ccOk = stringListOk(cc, RECIPIENTS_MAX, addressOk);
    if (!toOk) errors.push('recipients_to_invalid');
    if (!ccOk) errors.push('recipients_cc_invalid');
    if (toOk && ccOk && cc.some((address) => to.includes(address)))
      errors.push('recipients_duplicated');
    const subject = action['subject'];
    if (
      typeof subject !== 'string' ||
      subject.trim().length === 0 ||
      subject.length > SUBJECT_MAX ||
      CONTROL.test(subject)
    )
      errors.push('subject_invalid');
    const body = action['body'];
    if (
      typeof body !== 'string' ||
      body.trim().length === 0 ||
      body.length > BODY_MAX ||
      BODY_CONTROL.test(body)
    )
      errors.push('body_invalid');
  } else errors.push('action_kind_not_confirmable');
  const effects = operation['effects'];
  const scope =
    kind === 'mail.labels.change'
      ? 'exact_target'
      : kind === 'mail.draft.create'
        ? 'operation_marker'
        : null;
  if (!isRecord(effects)) errors.push('effects_not_object');
  else {
    errors.push(...keyErrors(effects, EFFECTS_FIELDS, 'effects_'));
    const recipients = effects['external_recipients'];
    if (!Array.isArray(recipients) || recipients.length !== 0)
      errors.push('effects_external_recipients_invalid');
    if (scope !== null && effects['reconcile_scope'] !== scope)
      errors.push('effects_reconcile_scope_invalid');
  }
  return errors;
}

// 確認の中身の検査。空なら確認の画面へ出してよい。
export function privateConfirmationErrors(draft: unknown): string[] {
  if (!isRecord(draft)) return ['not_object'];
  const errors = keyErrors(draft, PRIVATE_CONFIRMATION_FIELDS, '');
  if (Object.hasOwn(draft, 'operation'))
    errors.push(...operationErrors(draft['operation']));
  if (
    Object.hasOwn(draft, 'content_hash') &&
    !matches(draft['content_hash'], SHA256_HEX)
  )
    errors.push('content_hash_invalid');
  return errors;
}

// 承認の形の検査。独立した確認は画面で一度だけ承認する（音声の「はい」・方針による自動承認は使わない）。
// 承認は、確認を出した区切りの世代と、操作の ID・内容版・内容の hash に結び付ける（照合は遷移で行う）。
export function privateApprovalErrors(approval: unknown): string[] {
  if (!isRecord(approval)) return ['not_object'];
  const errors: string[] = [];
  for (const key of Object.keys(approval).sort())
    if (!(PRIVATE_APPROVAL_FIELDS as readonly string[]).includes(key))
      errors.push(`field_not_allowed:${key}`);
  for (const key of PRIVATE_APPROVAL_FIELDS)
    if (!Object.hasOwn(approval, key)) errors.push(`field_missing:${key}`);
  if (approval['route'] !== 'screen') errors.push('route_not_screen');
  if (!matches(approval['device_id'], UUID_V4))
    errors.push('device_id_invalid');
  if (!utcTimeOk(approval['approved_at'])) errors.push('approved_at_invalid');
  if (!matches(approval['segment_generation'], DECIMAL))
    errors.push('segment_generation_invalid');
  if (!matches(approval['operation_id'], UUID_V4))
    errors.push('operation_id_invalid');
  if (!matches(approval['content_version'], DECIMAL))
    errors.push('content_version_invalid');
  if (!matches(approval['content_hash'], SHA256_HEX))
    errors.push('content_hash_invalid');
  return errors;
}

// 検査を通った下書きから、検査した項目だけを 1 つずつ写して中身を作る（呼び出し側の物を共有しない）。
function confirmationContent(
  draft: Record<string, unknown>,
): PrivateConfirmationContent {
  const operation = draft['operation'] as Record<string, unknown>;
  const target = operation['target'] as Record<string, string>;
  const action = operation['action'] as Record<string, unknown>;
  const kind = action['kind'] as ConfirmableKind;
  const strings = (value: unknown): string[] => [...(value as string[])];
  const copied: PrivateOperationAction =
    kind === 'mail.labels.change'
      ? {
          kind,
          add: strings(action['add']),
          remove: strings(action['remove']),
        }
      : {
          kind,
          to: strings(action['to']),
          cc: strings(action['cc']),
          subject: action['subject'] as string,
          body: action['body'] as string,
        };
  return {
    intent: CONFIRMABLE_KINDS[kind],
    operation: {
      schema: 'buddy.operation.v1',
      operation_id: operation['operation_id'] as string,
      content_version: operation['content_version'] as string,
      permission_revision: operation['permission_revision'] as string,
      provider: operation['provider'] as PrivateConfirmedOperation['provider'],
      account_id: operation['account_id'] as string,
      target: {
        remote_id: target['remote_id'] as string,
        source_revision: target['source_revision'] as string,
      },
      action: copied,
      effects: {
        external_recipients: [],
        reconcile_scope:
          kind === 'mail.labels.change' ? 'exact_target' : 'operation_marker',
      },
    },
    content_hash: draft['content_hash'] as string,
  };
}

function copyContent(
  content: PrivateConfirmationContent,
): PrivateConfirmationContent {
  return confirmationContent({
    operation: content.operation,
    content_hash: content.content_hash,
  });
}

// ---- 処理の由来（遅れて届いた結果の照合） -------------------------------------------------------------------

// 処理を始めたときの区切り。入力の命令に付けて返し、Core は後段の処理（要約・抽出・影モード・派生物）の結果に
// そのまま持たせて、保存の直前に write の事象で戻す。
export interface StorageOrigin {
  readonly segment_id: string;
  readonly segment_generation: string;
  readonly storage_mode: StorageModeName;
}
const ORIGIN_FIELDS = ['segment_id', 'segment_generation', 'storage_mode'];

export type StorageOriginRejection =
  'origin_invalid' | 'origin_private' | 'origin_stale' | 'origin_mismatch';

// 由来の照合。null なら今の区切りの結果。
// - 形が違う・保存モードが判別できない: origin_invalid（記録しない由来かもしれないので捨てる）。
// - 記録しない区切りが由来で、今の区切りと違う（出た後・入り直した後）: origin_private（永続化しない。RAM も捨て済み）。
// - それ以外で今の区切りと違う（失効した区切り）: origin_stale（捨てる）。
// - 区切りは同じで保存モードが違う: origin_mismatch。
export function storageOriginRejection(
  state: Pick<
    StorageBoundaryState,
    'mode' | 'segment_id' | 'segment_generation'
  >,
  origin: unknown,
): StorageOriginRejection | null {
  if (
    !isRecord(origin) ||
    Object.keys(origin).length !== ORIGIN_FIELDS.length ||
    !ORIGIN_FIELDS.every((key) => Object.hasOwn(origin, key)) ||
    typeof origin['segment_id'] !== 'string' ||
    !matches(origin['segment_generation'], DECIMAL) ||
    !isStorageModeName(origin['storage_mode'])
  )
    return 'origin_invalid';
  const same =
    origin['segment_id'] === state.segment_id &&
    origin['segment_generation'] === state.segment_generation;
  if (!same)
    return origin['storage_mode'] === 'private'
      ? 'origin_private'
      : 'origin_stale';
  return origin['storage_mode'] === state.mode ? null : 'origin_mismatch';
}

// ---- 遷移（入る・出る・音声・外部変更の確認） -------------------------------------------------------------

// Live の接続の段階（Core から見た値。制御接続の細かい状態は voice.ts の LiveControl）。
export type LivePhase = 'closed' | 'connecting' | 'open' | 'closing';

// 記録しない区切りの間だけ RAM に持つ物の種類。出るときにすべて捨てる。
export const PRIVATE_RAM_KINDS = [
  'turn',
  'summary',
  'input_snapshot',
  'clarification',
  'this_time_directive',
  'derived_summary',
  'workflow',
  'workflow_result',
  'turn_response',
  'command_receipt',
  'canvas',
] as const;
export type PrivateRamKind = (typeof PRIVATE_RAM_KINDS)[number];

// 記録しない区切りで永続化を禁じられたときに、RAM に持つ先。ない行（記憶・抽出・影モード・「今後は」・発言のイベント・
// 通常の操作の記録）は RAM にも持たず、拒否する。
const RAM_FALLBACK: Readonly<Partial<Record<StorageEffect, PrivateRamKind>>> = {
  persist_turns: 'turn',
  persist_summary: 'summary',
  persist_input_snapshot: 'input_snapshot',
  persist_clarification: 'clarification',
  persist_this_time_directive: 'this_time_directive',
  persist_derived_summary: 'derived_summary',
  persist_workflow: 'workflow',
  persist_workflow_result: 'workflow_result',
  persist_turn_response: 'turn_response',
  persist_command_receipt: 'command_receipt',
  write_persisted_canvas: 'canvas',
};

// write の事象で扱えない行（接続・③・最小の記録は専用の事象で扱う）。
const NOT_WRITES: readonly StorageEffect[] = [
  'open_live',
  'local_asr',
  'record_minimal_operation',
  'write_ephemeral_canvas',
];

export interface PendingPrivateConfirmation {
  readonly confirmation_id: string;
  readonly content: PrivateConfirmationContent;
}

export interface StorageBoundaryState {
  readonly mode: StorageModeName;
  readonly segment_id: string;
  // 区切りの世代（10 進の文字列）。入る・出るたびに 1 進める。由来と承認の照合に使う。
  readonly segment_generation: string;
  readonly live: LivePhase;
  // 記録しない区切りで RAM に持っている物（種類を受けた順に）。通常の区切りでは null。
  readonly private_ram: readonly PrivateRamKind[] | null;
  // 承認を待つ独立した確認（RAM だけ）。
  readonly pending_confirmations: readonly PendingPrivateConfirmation[];
  // この区切りの世代で使った確認の ID（承認・取り下げ・失敗の後も再利用させない）。
  readonly used_confirmation_ids: readonly string[];
  // この区切りの世代で受け付けた操作の ID（保留中と承認済み）。同じ操作の新しい確認を受けない。
  readonly accepted_operation_ids: readonly string[];
  // この区切りの世代で承認済みの確認の ID。承認の再送には記録を出さずに already_approved を返す。
  readonly approved_confirmation_ids: readonly string[];
}

export type StorageBoundaryEvent =
  | { readonly type: 'enter_private'; readonly segment_id: string }
  | {
      readonly type: 'exit_private';
      readonly segment_id: string;
      readonly mode: unknown;
    }
  | { readonly type: 'live_requested' }
  | { readonly type: 'live_connected' }
  | { readonly type: 'live_closed' }
  | {
      readonly type: 'input';
      readonly input_kind: unknown;
      // 端末が見ていた区切りの ID・世代・保存モード（必須）。出た後に届いた記録しない区切りの文字を通常の発言にしない。
      readonly origin: unknown;
    }
  | {
      readonly type: 'write';
      readonly effect: unknown;
      readonly origin: unknown;
    }
  | {
      readonly type: 'external_change_requested';
      readonly confirmation_id: string;
      readonly origin: unknown;
      readonly draft: unknown;
    }
  | {
      readonly type: 'confirmation_approved';
      readonly confirmation_id: string;
      readonly approval: unknown;
    }
  | {
      readonly type: 'confirmation_declined';
      readonly confirmation_id: string;
    };

export type StorageBoundaryCommand =
  | {
      readonly type: 'close_voice_session';
      readonly reason: 'private_conversation';
    }
  | { readonly type: 'begin_private_canvas' }
  | { readonly type: 'end_private_canvas' }
  | {
      readonly type: 'discard_private_ram';
      readonly confirmation_ids: readonly string[];
    }
  | {
      readonly type: 'open_segment';
      readonly segment_id: string;
      readonly segment_generation: string;
      readonly storage_mode: StorageModeName;
      readonly open_reason: 'private_started' | 'private_ended';
      readonly carried_summary: null;
    }
  | { readonly type: 'start_live' }
  | {
      readonly type: 'write';
      readonly effect: StorageEffect;
      readonly origin: StorageOrigin;
    }
  | {
      readonly type: 'hold_in_ram';
      readonly kind: PrivateRamKind;
      readonly origin: StorageOrigin;
    }
  | {
      readonly type: 'show_independent_confirmation';
      readonly confirmation_id: string;
      readonly segment_generation: string;
      readonly view: PrivateConfirmationView;
    }
  | {
      readonly type: 'record_minimal_operation';
      readonly record: PrivateMinimalRecord;
    };

export type StorageBoundaryRejection =
  | 'storage_mode_unknown'
  | 'state_invalid'
  | 'already_private'
  | 'not_private'
  | 'segment_id_reused'
  | 'private_conversation'
  | 'live_not_closed'
  | 'live_not_open'
  | 'invalid_transition'
  | 'input_kind_unknown'
  | 'effect_unknown'
  | 'not_a_write'
  | 'denied_in_mode'
  | 'independent_confirmation_required'
  | StorageOriginRejection
  | 'confirmation_invalid'
  | 'confirmation_id_reused'
  | 'confirmation_not_found'
  | 'approval_invalid'
  | 'approval_mismatch'
  | 'operation_id_reused'
  | 'already_approved';

export interface StorageBoundaryResult {
  readonly state: StorageBoundaryState;
  readonly commands: readonly StorageBoundaryCommand[];
  readonly rejected: StorageBoundaryRejection | null;
  readonly errors: readonly string[];
}

const CLOSE_LIVE: StorageBoundaryCommand = {
  type: 'close_voice_session',
  reason: 'private_conversation',
};

const nextGeneration = (generation: string): string =>
  (BigInt(generation) + 1n).toString();

// 1 つの事象を当てる。命令は Core が返した順に行う（順序に意味がある）。
// - 入る: 開いている・開きかけの Live を先に閉じ、一時のキャンバスを始め、要約をつながない記録しない区切りを開く。
// - 出る: RAM（発言・要約・入力の版・聞き返し・「今回は」・派生物・依頼と結果・受付の記録・一時のキャンバス・承認前の
//   確認）を先に捨て、一時のキャンバスを終え、前の要約を持ち込まない区切りを開く。出る先の保存モードが判別できなければ
//   出ない（記録しない側に留まる）。
// - 入る・出るたびに区切りの世代を進める。結果の保存（write）は由来の区切りと世代を照合し、記録しない区切りが由来の
//   結果は出た後も永続化しない。失効した区切りへ遅れて届いた結果は捨てる。
// - 記録しない区切りの間: Live は開かない（遅れて届いた接続は閉じる）。③と文字は RAM に持つ。外部変更は独立した確認に
//   切り出し、同じ世代・同じ操作の内容への画面での一度の承認の後に、最小の操作記録だけを残す。
export function applyStorageBoundaryEvent(
  state: StorageBoundaryState,
  event: StorageBoundaryEvent,
): StorageBoundaryResult {
  const done = (
    next: StorageBoundaryState,
    commands: StorageBoundaryCommand[] = [],
  ): StorageBoundaryResult => ({
    state: next,
    commands,
    rejected: null,
    errors: [],
  });
  const reject = (
    reason: StorageBoundaryRejection,
    errors: string[] = [],
    next: StorageBoundaryState = state,
    commands: StorageBoundaryCommand[] = [],
  ): StorageBoundaryResult => ({
    state: next,
    commands,
    rejected: reason,
    errors,
  });
  const liveActive = state.live === 'connecting' || state.live === 'open';
  const closeIfActive = (reason: StorageBoundaryRejection) =>
    reject(
      reason,
      [],
      { ...state, live: liveActive ? 'closing' : state.live },
      liveActive ? [CLOSE_LIVE] : [],
    );

  // 世代が読めなければ、次の世代も決められない。何も書かず、開いている Live を閉じる。
  if (!matches(state.segment_generation, DECIMAL))
    return closeIfActive('state_invalid');
  const current: StorageOrigin = {
    segment_id: state.segment_id,
    segment_generation: state.segment_generation,
    storage_mode: state.mode,
  };

  if (event.type === 'enter_private') {
    // 判別できない保存モードからは、記録しない側へ入ることだけを許す。
    if (state.mode === 'private') return reject('already_private');
    if (event.segment_id === state.segment_id)
      return reject('segment_id_reused');
    const generation = nextGeneration(state.segment_generation);
    return done(
      {
        mode: 'private',
        segment_id: event.segment_id,
        segment_generation: generation,
        live: liveActive ? 'closing' : state.live,
        private_ram: [],
        pending_confirmations: [],
        used_confirmation_ids: [],
        accepted_operation_ids: [],
        approved_confirmation_ids: [],
      },
      [
        ...(liveActive ? [CLOSE_LIVE] : []),
        { type: 'begin_private_canvas' },
        {
          type: 'open_segment',
          segment_id: event.segment_id,
          segment_generation: generation,
          storage_mode: 'private',
          open_reason: 'private_started',
          carried_summary: null,
        },
      ],
    );
  }

  // 判別できない保存モードでは何も書かず、開いている Live を閉じる。
  if (!isStorageModeName(state.mode))
    return closeIfActive('storage_mode_unknown');
  const isPrivate = state.mode === 'private';

  switch (event.type) {
    case 'exit_private': {
      if (!isPrivate) return reject('not_private');
      if (event.mode !== 'normal' && event.mode !== 'extended')
        return reject('storage_mode_unknown');
      if (event.segment_id === state.segment_id)
        return reject('segment_id_reused');
      const generation = nextGeneration(state.segment_generation);
      return done(
        {
          mode: event.mode,
          segment_id: event.segment_id,
          segment_generation: generation,
          live: state.live,
          private_ram: null,
          pending_confirmations: [],
          used_confirmation_ids: [],
          accepted_operation_ids: [],
          approved_confirmation_ids: [],
        },
        [
          {
            type: 'discard_private_ram',
            confirmation_ids: state.pending_confirmations.map(
              (pending) => pending.confirmation_id,
            ),
          },
          { type: 'end_private_canvas' },
          {
            type: 'open_segment',
            segment_id: event.segment_id,
            segment_generation: generation,
            storage_mode: event.mode,
            open_reason: 'private_ended',
            carried_summary: null,
          },
        ],
      );
    }
    case 'live_requested':
      if (isPrivate) return reject('private_conversation');
      if (state.live !== 'closed') return reject('live_not_closed');
      return done({ ...state, live: 'connecting' }, [{ type: 'start_live' }]);
    case 'live_connected':
      // 記録しない区切りに入った後に届いた接続（X31）は使わずに閉じる。閉じる命令を出し済みなら重ねない。
      if (isPrivate)
        return reject(
          'private_conversation',
          [],
          { ...state, live: 'closing' },
          state.live === 'closing' ? [] : [CLOSE_LIVE],
        );
      // 閉じているはずなのに届いた接続は、使わずに閉じる（安全な側）。開いている・閉じる途中なら重ねない。
      if (state.live === 'closed')
        return reject('invalid_transition', [], { ...state, live: 'closing' }, [
          CLOSE_LIVE,
        ]);
      if (state.live !== 'connecting') return reject('invalid_transition');
      return done({ ...state, live: 'open' });
    case 'live_closed':
      return done({ ...state, live: 'closed' });
    case 'input': {
      const kind = event.input_kind;
      if (kind === 'voice_live') {
        if (isPrivate) return reject('private_conversation');
        if (state.live !== 'open') return reject('live_not_open');
      } else if (kind === 'voice_local') {
        // ③は表で許す行。表が変わったときにも、ここで同じ表を見る。
        const asr = storageModeDecision(state.mode, 'local_asr');
        if (!asr.allowed) return reject(asr.reason);
      } else if (kind !== 'text') return reject('input_kind_unknown');
      // 端末が見ていた区切りと今の区切りを照合する（enter → exit → input の順で届いた記録しない区切りの文字を拒否）。
      const staleInput = storageOriginRejection(state, event.origin);
      if (staleInput !== null) return reject(staleInput);
      // 入力は今の区切りで始まる処理。命令に由来を付けて返す。
      return write(state, 'persist_turns', current, done, reject);
    }
    case 'write': {
      if (!isStorageEffect(event.effect)) return reject('effect_unknown');
      if (NOT_WRITES.includes(event.effect)) {
        // 最小の記録は独立した確認の承認だけが作る。
        if (event.effect === 'record_minimal_operation')
          return reject(
            isPrivate ? 'independent_confirmation_required' : 'denied_in_mode',
          );
        return reject('not_a_write');
      }
      const stale = storageOriginRejection(state, event.origin);
      if (stale !== null) return reject(stale);
      return write(state, event.effect, current, done, reject);
    }
    case 'external_change_requested': {
      if (!isPrivate) return reject('not_private');
      const stale = storageOriginRejection(state, event.origin);
      if (stale !== null) return reject(stale);
      if (state.used_confirmation_ids.includes(event.confirmation_id))
        return reject('confirmation_id_reused');
      const used = [...state.used_confirmation_ids, event.confirmation_id];
      const errors = privateConfirmationErrors(event.draft);
      if (errors.length > 0)
        return reject('confirmation_invalid', errors, {
          ...state,
          used_confirmation_ids: used,
        });
      const content = confirmationContent(
        event.draft as Record<string, unknown>,
      );
      // 同じ世代で受け付けた操作（保留中・承認済み）の新しい確認は受けない。世代をまたぐ重複は Core・DB の一意制約で防ぐ。
      if (state.accepted_operation_ids.includes(content.operation.operation_id))
        return reject('operation_id_reused', [], {
          ...state,
          used_confirmation_ids: used,
        });
      return done(
        {
          ...state,
          used_confirmation_ids: used,
          accepted_operation_ids: [
            ...state.accepted_operation_ids,
            content.operation.operation_id,
          ],
          pending_confirmations: [
            ...state.pending_confirmations,
            { confirmation_id: event.confirmation_id, content },
          ],
        },
        [
          {
            type: 'show_independent_confirmation',
            confirmation_id: event.confirmation_id,
            segment_generation: state.segment_generation,
            view: { ...copyContent(content), conversation_saved: false },
          },
        ],
      );
    }
    case 'confirmation_approved': {
      const pending = state.pending_confirmations.find(
        (entry) => entry.confirmation_id === event.confirmation_id,
      );
      // 承認済みの確認への再送は、記録を出さずに決まった応答を返す。
      // 出るときに捨てた確認・知らない確認は承認できない（記録も外部変更も作らない）。
      if (pending === undefined)
        return reject(
          state.approved_confirmation_ids.includes(event.confirmation_id)
            ? 'already_approved'
            : 'confirmation_not_found',
        );
      const errors = privateApprovalErrors(event.approval);
      if (errors.length > 0) return reject('approval_invalid', errors);
      const approval = event.approval as Record<string, string>;
      // 承認は、確認を出した世代と、同じ操作の同じ内容へのものだけ（入り直した後の古い承認を別の操作へ当てない）。
      const operation = pending.content.operation;
      const mismatched = [
        approval['segment_generation'] !== state.segment_generation &&
          'segment_generation',
        approval['operation_id'] !== operation.operation_id && 'operation_id',
        approval['content_version'] !== operation.content_version &&
          'content_version',
        approval['content_hash'] !== pending.content.content_hash &&
          'content_hash',
      ].filter((name): name is string => typeof name === 'string');
      if (mismatched.length > 0)
        return reject(
          'approval_mismatch',
          mismatched.map((name) => `${name}_mismatch`),
        );
      const decision = storageModeDecision(
        state.mode,
        'record_minimal_operation',
        { independentConfirmationApproved: true },
      );
      if (!decision.allowed) return reject(decision.reason);
      return done(
        {
          ...state,
          pending_confirmations: state.pending_confirmations.filter(
            (entry) => entry !== pending,
          ),
          approved_confirmation_ids: [
            ...state.approved_confirmation_ids,
            event.confirmation_id,
          ],
        },
        [
          {
            type: 'record_minimal_operation',
            record: {
              record_kind: 'private_minimal',
              workflow_id: null,
              ...copyContent(pending.content),
              approval: {
                route: 'screen',
                device_id: approval['device_id'] as string,
                approved_at: approval['approved_at'] as string,
              },
            },
          },
        ],
      );
    }
    case 'confirmation_declined': {
      const declined = state.pending_confirmations.find(
        (entry) => entry.confirmation_id === event.confirmation_id,
      );
      if (declined === undefined)
        return reject(
          state.approved_confirmation_ids.includes(event.confirmation_id)
            ? 'already_approved'
            : 'confirmation_not_found',
        );
      // 取り下げた操作は受け付けた一覧から外す（同じ操作を新しい確認の ID で頼み直せる）。
      return done({
        ...state,
        pending_confirmations: state.pending_confirmations.filter(
          (entry) => entry !== declined,
        ),
        accepted_operation_ids: state.accepted_operation_ids.filter(
          (id) => id !== declined.content.operation.operation_id,
        ),
      });
    }
    default:
      return reject('invalid_transition');
  }
}

function write(
  state: StorageBoundaryState,
  effect: StorageEffect,
  origin: StorageOrigin,
  done: (
    next: StorageBoundaryState,
    commands?: StorageBoundaryCommand[],
  ) => StorageBoundaryResult,
  reject: (reason: StorageBoundaryRejection) => StorageBoundaryResult,
): StorageBoundaryResult {
  const decision = storageModeDecision(state.mode, effect);
  if (decision.allowed)
    return done(state, [{ type: 'write', effect, origin: { ...origin } }]);
  const kind = RAM_FALLBACK[effect];
  if (state.mode === 'private' && kind !== undefined)
    return done(
      { ...state, private_ram: [...(state.private_ram ?? []), kind] },
      [{ type: 'hold_in_ram', kind, origin: { ...origin } }],
    );
  return reject(decision.reason);
}

// 通常の区切りの初めの状態（流れの最初）。世代は 1 から。
export function initialStorageBoundaryState(
  segmentId: string,
  mode: 'normal' | 'extended',
): StorageBoundaryState {
  return {
    mode,
    segment_id: segmentId,
    segment_generation: '1',
    live: 'closed',
    private_ram: null,
    pending_confirmations: [],
    used_confirmation_ids: [],
    accepted_operation_ids: [],
    approved_confirmation_ids: [],
  };
}
