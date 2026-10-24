// 記録しない会話（保存モードの private）の保存の境界（設計 03 保存期限・記録しない会話の境界、10 §1A・§6、
// 09 X17・X36・X44・X48・X59、ADR 0032・0038・0040・0045）。
// 純粋な規則だけを持つ。Core の StorageModeGate（B06-07）が呼び、DB・音声・キャンバスへの副作用は命令として返す。
// 安全の境界なので、決まっていない・判別できない値は記録しない側・禁止の側に倒す。

import {
  ARG_FIELDS,
  INTENT_NAMES,
  INTENT_POLICIES,
  checkIntentArgs,
  type ArgField,
  type ArgValues,
  type IntentName,
} from './intents.js';
import { RETENTION_RULES, turnRetentionRule } from './retention.js';

export const STORAGE_MODE_NAMES = ['normal', 'extended', 'private'] as const;
export type StorageModeName = (typeof STORAGE_MODE_NAMES)[number];

export const isStorageModeName = (value: unknown): value is StorageModeName =>
  typeof value === 'string' &&
  (STORAGE_MODE_NAMES as readonly string[]).includes(value);

// ---- 保存モードごとの許可表 -------------------------------------------------------------------------------

// 表の行。persist_* は Buddy 内への永続化（DB・スナップショット・イベントの記録・ログ）を指す。
export const STORAGE_EFFECTS = [
  // 発言の本文（sessions / turns）。
  'persist_turns',
  // 発言のイベント（event_outbox。07 §4 の「記録しない会話の発言のイベントは永続化しない」）。
  'persist_turn_events',
  // 会話の要約・区切りをつなぐ要約（ADR 0032 の CarriedSummary）。
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
  // Live（GPT-Live-1）の接続を開く（X17・X36）。
  'open_live',
  // 端末内で文字にする③（質問 110）。
  'local_asr',
  // 保存してよいキャンバスの記述への書き込み（ADR 0032 の CanvasStore.persisted）。
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

// 確認の中身に置ける欄（許可リスト）。会話の本文・文字起こし・音声・要約・解釈の結果・発言・会話・依頼・入力の版・
// 影モード・記憶の由来は、名前によらず、ここにない欄としてすべて拒否する。
export const PRIVATE_CONFIRMATION_FIELDS = [
  'operation_id',
  'content_version',
  'content_hash',
  'intent',
  'account_id',
  'target',
  'change',
] as const;
const TARGET_FIELDS = ['remote_id', 'source_revision'] as const;
const APPROVAL_FIELDS = ['route', 'device_id', 'approved_at'] as const;

export interface PrivateTargetLike {
  readonly remote_id: string;
  readonly source_revision: string;
}

export interface PrivateConfirmationContent {
  readonly operation_id: string;
  readonly content_version: string;
  readonly content_hash: string;
  readonly intent: IntentName;
  readonly account_id: string;
  readonly target: PrivateTargetLike | null;
  // 元サービスへ実際に渡す内容（確認の画面に出す）。キーは意図の許可引数から target_candidate_id を除いたもの。
  readonly change: Readonly<Partial<Record<ArgField, unknown>>>;
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

// 承認の後に残す最小の操作記録。会話・依頼へのつながりを持たない（workflow_id は null）。
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
const UTC_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9](\.[0-9]+)?Z$/u;
const CONTROL = /\p{Cc}/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// JSON の値の写し（呼び出し側の物を共有しない）。
function copyJson<T>(value: T): T {
  if (Array.isArray(value))
    return value.map((item: unknown) => copyJson(item)) as T;
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, copyJson(item)]),
    ) as T;
  return value;
}

// 確認の中身の検査。理由は決まった順に返す（欄の名前は辞書順）。空なら確認の画面へ出してよい。
export function privateConfirmationErrors(draft: unknown): string[] {
  if (!isRecord(draft)) return ['not_object'];
  const errors: string[] = [];
  for (const key of Object.keys(draft).sort())
    if (!(PRIVATE_CONFIRMATION_FIELDS as readonly string[]).includes(key))
      errors.push(`field_not_allowed:${key}`);
  for (const key of PRIVATE_CONFIRMATION_FIELDS)
    if (!(key in draft)) errors.push(`field_missing:${key}`);
  if ('operation_id' in draft && !matches(draft['operation_id'], UUID_V4))
    errors.push('operation_id_invalid');
  if ('content_version' in draft && !matches(draft['content_version'], DECIMAL))
    errors.push('content_version_invalid');
  if ('content_hash' in draft && !matches(draft['content_hash'], SHA256_HEX))
    errors.push('content_hash_invalid');
  if ('account_id' in draft && !matches(draft['account_id'], UUID_V4))
    errors.push('account_id_invalid');
  const intent = draft['intent'];
  const known =
    typeof intent === 'string' &&
    (INTENT_NAMES as readonly string[]).includes(intent);
  if ('intent' in draft && !known) errors.push('intent_unknown');
  // 切り出せるのは外部変更（RemoteMutation）だけ。LocalCommand（用事・メモ・記憶）は Buddy 内に内容を残し、
  // Read は操作の記録が要らない。どちらも独立した確認の対象にしない（ADR 0045 U64）。
  if (
    known &&
    INTENT_POLICIES[intent as IntentName].route !== 'remote_mutation'
  )
    errors.push('intent_not_external_change');
  if ('target' in draft) errors.push(...targetErrors(draft['target']));
  if ('change' in draft) {
    const change = draft['change'];
    if (!isRecord(change)) errors.push('change_not_object');
    else {
      for (const key of Object.keys(change).sort())
        if (
          key === 'target_candidate_id' ||
          !(ARG_FIELDS as readonly string[]).includes(key)
        )
          errors.push(`change_field_not_allowed:${key}`);
      if (known && errors.every((e) => !e.startsWith('change_field'))) {
        // 対象は target に解決済みなので、引数の検査では target の有無を target_candidate_id として渡す。
        const args = Object.fromEntries(
          ARG_FIELDS.map((field) => [field, change[field] ?? null]),
        ) as Record<ArgField, unknown>;
        args.target_candidate_id = isRecord(draft['target'])
          ? draft['target']['remote_id']
          : null;
        const result = checkIntentArgs(intent as IntentName, args as ArgValues);
        for (const field of result.unexpected)
          errors.push(
            field === 'target_candidate_id'
              ? 'target_not_allowed'
              : `change_field_not_allowed:${field}`,
          );
        for (const field of result.missing)
          errors.push(
            field === 'target_candidate_id'
              ? 'target_missing'
              : `change_missing:${field}`,
          );
      }
    }
  }
  return errors;
}

function matches(value: unknown, pattern: RegExp): boolean {
  return typeof value === 'string' && pattern.test(value);
}

function targetErrors(target: unknown): string[] {
  if (target === null) return [];
  if (!isRecord(target)) return ['target_not_object'];
  const errors: string[] = [];
  for (const key of Object.keys(target).sort())
    if (!(TARGET_FIELDS as readonly string[]).includes(key))
      errors.push(`target_field_not_allowed:${key}`);
  if (!matches(target['remote_id'], ORIGINAL_SOURCE_ID))
    errors.push('target_remote_id_invalid');
  const revision = target['source_revision'];
  if (
    typeof revision !== 'string' ||
    revision.length === 0 ||
    revision.length > 256 ||
    CONTROL.test(revision)
  )
    errors.push('target_source_revision_invalid');
  return errors;
}

// 承認の検査。独立した確認は画面で一度だけ承認する（音声の「はい」・方針による自動承認は使わない）。
export function privateApprovalErrors(approval: unknown): string[] {
  if (!isRecord(approval)) return ['not_object'];
  const errors: string[] = [];
  for (const key of Object.keys(approval).sort())
    if (!(APPROVAL_FIELDS as readonly string[]).includes(key))
      errors.push(`field_not_allowed:${key}`);
  if (approval['route'] !== 'screen') errors.push('route_not_screen');
  if (!matches(approval['device_id'], UUID_V4))
    errors.push('device_id_invalid');
  if (
    !matches(approval['approved_at'], UTC_TIME) ||
    Number.isNaN(Date.parse(approval['approved_at'] as string))
  )
    errors.push('approved_at_invalid');
  return errors;
}

// 検査を通った下書きから、許可リストの欄だけを写した中身を作る（呼び出し側の物を共有しない）。
function confirmationContent(
  draft: Record<string, unknown>,
): PrivateConfirmationContent {
  const target = draft['target'] as PrivateTargetLike | null;
  const change = draft['change'] as Record<string, unknown>;
  return {
    operation_id: draft['operation_id'] as string,
    content_version: draft['content_version'] as string,
    content_hash: draft['content_hash'] as string,
    intent: draft['intent'] as IntentName,
    account_id: draft['account_id'] as string,
    target:
      target === null
        ? null
        : {
            remote_id: target['remote_id'],
            source_revision: target['source_revision'],
          },
    change: copyJson(change),
  };
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
  'canvas',
] as const;
export type PrivateRamKind = (typeof PRIVATE_RAM_KINDS)[number];

// 記録しない区切りで永続化を禁じられたときに、RAM に持つ先。ない行（記憶・抽出・影モード・「今後は」・通常の操作の記録）は
// RAM にも持たず、拒否する。
const RAM_FALLBACK: Readonly<Partial<Record<StorageEffect, PrivateRamKind>>> = {
  persist_turns: 'turn',
  persist_summary: 'summary',
  persist_input_snapshot: 'input_snapshot',
  persist_clarification: 'clarification',
  persist_this_time_directive: 'this_time_directive',
  write_persisted_canvas: 'canvas',
};

// write の命令で扱えない行（接続・③・最小の記録は専用の事象で扱う）。
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
  readonly live: LivePhase;
  // 記録しない区切りで RAM に持っている物（種類を受けた順に）。通常の区切りでは null。
  readonly private_ram: readonly PrivateRamKind[] | null;
  // 承認を待つ独立した確認（RAM だけ）。
  readonly pending_confirmations: readonly PendingPrivateConfirmation[];
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
  | { readonly type: 'input'; readonly input_kind: unknown }
  | { readonly type: 'write'; readonly effect: unknown }
  | {
      readonly type: 'external_change_requested';
      readonly confirmation_id: string;
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
      readonly storage_mode: StorageModeName;
      readonly open_reason: 'private_started' | 'private_ended';
      readonly carried_summary: null;
    }
  | { readonly type: 'start_live' }
  | { readonly type: 'write'; readonly effect: StorageEffect }
  | { readonly type: 'hold_in_ram'; readonly kind: PrivateRamKind }
  | {
      readonly type: 'show_independent_confirmation';
      readonly confirmation_id: string;
      readonly view: PrivateConfirmationView;
    }
  | {
      readonly type: 'record_minimal_operation';
      readonly record: PrivateMinimalRecord;
    };

export type StorageBoundaryRejection =
  | 'storage_mode_unknown'
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
  | 'confirmation_invalid'
  | 'confirmation_id_reused'
  | 'confirmation_not_found'
  | 'approval_invalid';

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

// 1 つの事象を当てる。命令は Core が返した順に行う（順序に意味がある）。
// - 入る: 開いている・開きかけの Live を先に閉じ、一時のキャンバスを始め、要約をつながない記録しない区切りを開く。
// - 出る: RAM（発言・要約・入力の版・聞き返し・「今回は」・一時のキャンバス・承認前の確認）を先に捨て、一時のキャンバスを
//   終え、前の要約を持ち込まない区切りを開く。出る先の保存モードが判別できなければ出ない（記録しない側に留まる）。
// - 記録しない区切りの間: Live は開かない（遅れて届いた接続は閉じる）。③と文字は RAM に持つ。外部変更は独立した確認に
//   切り出し、画面での一度の承認の後に最小の操作記録だけを残す。
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

  if (event.type === 'enter_private') {
    // 判別できない保存モードからは、記録しない側へ入ることだけを許す。
    if (state.mode === 'private') return reject('already_private');
    if (event.segment_id === state.segment_id)
      return reject('segment_id_reused');
    return done(
      {
        mode: 'private',
        segment_id: event.segment_id,
        live: liveActive ? 'closing' : state.live,
        private_ram: [],
        pending_confirmations: [],
      },
      [
        ...(liveActive ? [CLOSE_LIVE] : []),
        { type: 'begin_private_canvas' },
        {
          type: 'open_segment',
          segment_id: event.segment_id,
          storage_mode: 'private',
          open_reason: 'private_started',
          carried_summary: null,
        },
      ],
    );
  }

  if (!isStorageModeName(state.mode)) {
    // 判別できない保存モードでは何も書かず、開いている Live を閉じる。
    return reject(
      'storage_mode_unknown',
      [],
      { ...state, live: liveActive ? 'closing' : state.live },
      liveActive ? [CLOSE_LIVE] : [],
    );
  }
  const isPrivate = state.mode === 'private';

  switch (event.type) {
    case 'exit_private': {
      if (!isPrivate) return reject('not_private');
      if (event.mode !== 'normal' && event.mode !== 'extended')
        return reject('storage_mode_unknown');
      if (event.segment_id === state.segment_id)
        return reject('segment_id_reused');
      return done(
        {
          mode: event.mode,
          segment_id: event.segment_id,
          live: state.live,
          private_ram: null,
          pending_confirmations: [],
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
      return write(state, 'persist_turns', done, reject);
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
      return write(state, event.effect, done, reject);
    }
    case 'external_change_requested': {
      if (!isPrivate) return reject('not_private');
      const errors = privateConfirmationErrors(event.draft);
      if (errors.length > 0) return reject('confirmation_invalid', errors);
      if (
        state.pending_confirmations.some(
          (pending) => pending.confirmation_id === event.confirmation_id,
        )
      )
        return reject('confirmation_id_reused');
      const content = confirmationContent(
        event.draft as Record<string, unknown>,
      );
      return done(
        {
          ...state,
          pending_confirmations: [
            ...state.pending_confirmations,
            { confirmation_id: event.confirmation_id, content },
          ],
        },
        [
          {
            type: 'show_independent_confirmation',
            confirmation_id: event.confirmation_id,
            view: { ...copyJson(content), conversation_saved: false },
          },
        ],
      );
    }
    case 'confirmation_approved': {
      const pending = state.pending_confirmations.find(
        (entry) => entry.confirmation_id === event.confirmation_id,
      );
      // 出るときに捨てた確認・知らない確認は承認できない（記録も外部変更も作らない）。
      if (pending === undefined) return reject('confirmation_not_found');
      const errors = privateApprovalErrors(event.approval);
      if (errors.length > 0) return reject('approval_invalid', errors);
      const decision = storageModeDecision(
        state.mode,
        'record_minimal_operation',
        { independentConfirmationApproved: true },
      );
      if (!decision.allowed) return reject(decision.reason);
      const approval = event.approval as PrivateApprovalLike;
      return done(
        {
          ...state,
          pending_confirmations: state.pending_confirmations.filter(
            (entry) => entry !== pending,
          ),
        },
        [
          {
            type: 'record_minimal_operation',
            record: {
              record_kind: 'private_minimal',
              workflow_id: null,
              ...copyJson(pending.content),
              approval: {
                route: 'screen',
                device_id: approval.device_id,
                approved_at: approval.approved_at,
              },
            },
          },
        ],
      );
    }
    case 'confirmation_declined': {
      const remaining = state.pending_confirmations.filter(
        (entry) => entry.confirmation_id !== event.confirmation_id,
      );
      if (remaining.length === state.pending_confirmations.length)
        return reject('confirmation_not_found');
      return done({ ...state, pending_confirmations: remaining });
    }
    default:
      return reject('invalid_transition');
  }
}

function write(
  state: StorageBoundaryState,
  effect: StorageEffect,
  done: (
    next: StorageBoundaryState,
    commands?: StorageBoundaryCommand[],
  ) => StorageBoundaryResult,
  reject: (reason: StorageBoundaryRejection) => StorageBoundaryResult,
): StorageBoundaryResult {
  const decision = storageModeDecision(state.mode, effect);
  if (decision.allowed) return done(state, [{ type: 'write', effect }]);
  const kind = RAM_FALLBACK[effect];
  if (state.mode === 'private' && kind !== undefined)
    return done(
      { ...state, private_ram: [...(state.private_ram ?? []), kind] },
      [{ type: 'hold_in_ram', kind }],
    );
  return reject(decision.reason);
}

// 通常の区切りの初めの状態（流れの最初）。
export function initialStorageBoundaryState(
  segmentId: string,
  mode: 'normal' | 'extended',
): StorageBoundaryState {
  return {
    mode,
    segment_id: segmentId,
    live: 'closed',
    private_ram: null,
    pending_confirmations: [],
  };
}
