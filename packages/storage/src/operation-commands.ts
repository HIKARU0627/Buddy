// DB worker へ渡す命令と結果の約束（設計 11 §9 P06、08 §3・§5、07 §2・§3、ADR 0018）。
//
// - 命令は Core main が作り、DB worker が一つずつ短い同期 transaction で処理する。
// - どの命令にも command_id・種類・expected_state_revision・依頼／許可／忘却の版を付け、
//   worker の中で DB の現在値と照合する（domain の commandGuard と同じ形）。
// - 版・世代は契約と同じ 10 進の文字列で渡し、DB の INTEGER とは worker の中で変換する。
// - 本文（確定 intent）は B02-02 が暗号化した sealed_blobs の行として渡し、平文を渡さない。
// - 結果は durable（コミット済みの state_revision）・accepted（受付のみ、状態は変えていない）・
//   rejected（適用していないことが確か）・unknown（成否不明）のどれか。
//   送出の許可（DispatchPermit）は db-client.ts だけが durable の結果から作る。

export const DB_COMMAND_KINDS = [
  'operation.create',
  'operation.approve',
  'operation.prepare',
  'operation.dispatch_intent',
  'operation.record_result',
  'operation.cancel',
  // 起動時の回復（08 §4、ADR 0019）。送出意図の記録の後に中枢が止まった試行を unknown_held へ回す。
  'operation.recover_after_restart',
  // 内容版の更新（D1、ADR 0027・0029）。同じ operation_id で content_version を上げ、承認待ちへ戻す。
  'operation.revise_content',
] as const;

export type DbCommandKind = (typeof DB_COMMAND_KINDS)[number];

// 端末からの要求の受付（07 §3）。Core が接続範囲・request_id・要求の照合値を渡す。
// null は Core 内部の命令で、command_receipts には内部の接続範囲と command_id で記録する。
export interface DeviceRequestRef {
  readonly command_scope_id: string;
  readonly request_id: string;
  // 要求内容の照合値（SHA-256 の小文字の 16 進）。計算は Core（07 §3）。
  readonly request_hash: string;
}

// 内部の命令の受付を記録する接続範囲。端末の接続範囲（UUID）と重ならない値にする。
export const INTERNAL_COMMAND_SCOPE = 'core-internal';

interface DbCommandBase<K extends DbCommandKind> {
  readonly command_id: string;
  readonly kind: K;
  readonly operation_id: string;
  // 作成では 0（操作がまだない）。以後はコミット済みの state_revision。
  readonly expected_state_revision: string;
  // 依頼の版（workflows.current_request_revision）。workflow のない操作は null。
  readonly request_revision: string | null;
  // 許可の版。connection_id があれば connections.permission_revision と照合する。
  readonly permission_revision: string;
  // 忘却台帳の世代（forget_ledger の最大の世代、なければ 0）。
  readonly forgetting_generation: string;
  // 操作が使う連携の接続。外部変更（remote_mutation）の送出意図では必須。
  readonly connection_id: string | null;
  readonly request: DeviceRequestRef | null;
}

// 暗号化済みの本文（sealed_blobs の 1 行）。暗号化と追加認証データの結び付けは B02-02。
export interface SealedBlobInput {
  readonly blob_id: string;
  readonly format_version: number;
  readonly key_id: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly tag: Uint8Array;
}

export interface CreateOperationCommand extends DbCommandBase<'operation.create'> {
  readonly workflow_id: string | null;
  readonly operation_kind: string;
  readonly effect_route: 'local_command' | 'remote_mutation';
  // 確定 intent の JCS＋SHA-256（08 §2、H01）。計算は呼び出し側。
  readonly content_hash: string;
  readonly intent: SealedBlobInput;
  // 方針による自動承認（08 §1、X21）。あれば同じ transaction で承認を記録し approved から始める。
  readonly auto_approval: {
    readonly approval_id: string;
    readonly policy_version: string;
    readonly current_policy_version: string;
  } | null;
}

export interface ApproveOperationCommand extends DbCommandBase<'operation.approve'> {
  readonly approval_id: string;
  readonly route: 'screen' | 'policy_auto';
  readonly content_version: string;
  readonly content_hash: string;
  readonly device_id: string | null;
  readonly preview_id: string | null;
  // preview の有効性と方針の現在の版は Core が判定して渡す（DB に正本がない）。
  readonly preview_valid: boolean;
  readonly policy_version: string | null;
  readonly current_policy_version: string;
}

export interface PrepareOperationCommand extends DbCommandBase<'operation.prepare'> {
  // 新しい試行の ID（呼び出し側が作る）。再到着でも同じ ID になる。
  readonly attempt_id: string;
}

export interface DispatchIntentCommand extends DbCommandBase<'operation.dispatch_intent'> {
  readonly attempt_id: string;
  // 予算予約（05、ADR 0006）。費用のない操作は null。あれば reserved であること。
  readonly reservation_id: string | null;
}

export type ResultState =
  'reconciling' | 'succeeded' | 'not_executed' | 'unknown_held';

export interface RecordResultCommand extends DbCommandBase<'operation.record_result'> {
  readonly attempt_id: string;
  readonly to: ResultState;
  readonly external_id: string | null;
}

export type CancelOperationCommand = DbCommandBase<'operation.cancel'>;

// 起動時の回復（08 §4、ADR 0019）。dispatching のまま残った試行（送出意図の COMMIT の後に中枢が止まったもの）を
// unknown_held へ回す。送っていない可能性があっても自動で再送しない。Core が起動時に、制御チャネルを開く前に送る。
// 依頼・許可・忘却の版では拒否しない（送出済みかもしれない結果を失わないため。record_result と同じ）。
export interface RecoverAfterRestartCommand extends DbCommandBase<'operation.recover_after_restart'> {
  readonly attempt_id: string;
}

// 内容版の更新（D1、ADR 0027・0029）。新しい版の確定 intent（暗号化済み）と hash を渡す。旧版の有効な承認は
// 同じ transaction で revoked にする。実行中の試行（preparing）がある操作の更新は B04-04（試行の superseded）で、
// それまでは拒否する（attempt_active）。
export interface ReviseContentCommand extends DbCommandBase<'operation.revise_content'> {
  // 新しい内容版（現在の版＋1）。
  readonly content_version: string;
  readonly content_hash: string;
  readonly intent: SealedBlobInput;
}

export type DbCommand =
  | CreateOperationCommand
  | ReviseContentCommand
  | ApproveOperationCommand
  | PrepareOperationCommand
  | DispatchIntentCommand
  | RecordResultCommand
  | CancelOperationCommand
  | RecoverAfterRestartCommand;

// 送出意図をコミットした試行。DispatchPermit の材料。
export interface DispatchedAttempt {
  readonly attempt_id: string;
  readonly content_version: string;
  readonly content_hash: string;
}

export type StoreOutcome =
  | {
      readonly outcome: 'durable';
      readonly command_id: string;
      readonly kind: DbCommandKind;
      readonly operation_id: string;
      readonly committed_state_revision: string;
      // 同じ command_id・同じ要求の再到着で、保存済みの受付結果を返した。
      readonly replayed: boolean;
      // 同じ内容版の有効な承認が既にあり、新しく作らなかった（X02）。
      readonly existing: boolean;
      // 今回の命令で送出意図をコミットした試行（再到着では null）。
      readonly dispatched: DispatchedAttempt | null;
    }
  | {
      readonly outcome: 'accepted';
      readonly command_id: string;
      readonly kind: DbCommandKind;
      readonly operation_id: string;
      readonly state_revision: string;
      readonly replayed: boolean;
      // 送出境界を越えた後の取消は照合へ回し、取消済みにしない（X05）。
      readonly reason: 'dispatch_boundary_crossed';
    }
  | {
      readonly outcome: 'rejected';
      readonly command_id: string;
      readonly kind: DbCommandKind;
      readonly reasons: readonly string[];
    }
  | {
      readonly outcome: 'unknown';
      readonly command_id: string;
      readonly kind: DbCommandKind;
      readonly reason: string;
    };

const ID_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REVISION_TEXT = /^(0|[1-9][0-9]*)$/u;
const HASH_TEXT = /^[0-9a-f]{64}$/u;

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_TEXT.test(value);
}

export function isRevision(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    REVISION_TEXT.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}

// 外部サービスの対象 ID。形はサービスごとに違うため、長さと制御文字だけを見る。
function isExternalId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    ![...value].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  );
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_TEXT.test(value);
}

function isNullable<T>(
  value: unknown,
  check: (value: unknown) => value is T,
): boolean {
  return value === null || check(value);
}

function isBytes(value: unknown, length?: number): boolean {
  return (
    value instanceof Uint8Array &&
    value.length > 0 &&
    (length === undefined || value.length === length)
  );
}

function isSealedBlob(value: unknown): boolean {
  const intent = value as SealedBlobInput | null | undefined;
  return (
    typeof intent === 'object' &&
    intent !== null &&
    isId(intent.blob_id) &&
    Number.isSafeInteger(intent.format_version) &&
    intent.format_version >= 1 &&
    typeof intent.key_id === 'string' &&
    intent.key_id.length > 0 &&
    isBytes(intent.nonce, 12) &&
    isBytes(intent.ciphertext) &&
    isBytes(intent.tag, 16)
  );
}

// 命令の形の検査。理由が空なら形は正しい。状態・版の照合は worker の中で DB と行う。
export function commandShapeReasons(command: DbCommand): string[] {
  const reasons: string[] = [];
  const base = command as unknown as Record<string, unknown>;
  if (!isId(base['command_id'])) reasons.push('command_id_invalid');
  if (!DB_COMMAND_KINDS.includes(base['kind'] as DbCommandKind))
    return [...reasons, 'kind_invalid'];
  if (!isId(base['operation_id'])) reasons.push('operation_id_invalid');
  if (!isRevision(base['expected_state_revision']))
    reasons.push('expected_state_revision_invalid');
  if (!isNullable(base['request_revision'], isRevision))
    reasons.push('request_revision_invalid');
  if (!isRevision(base['permission_revision']))
    reasons.push('permission_revision_invalid');
  if (!isRevision(base['forgetting_generation']))
    reasons.push('forgetting_generation_invalid');
  if (!isNullable(base['connection_id'], isId))
    reasons.push('connection_id_invalid');
  const request = base['request'] as DeviceRequestRef | null | undefined;
  if (request !== null) {
    if (
      typeof request !== 'object' ||
      !isId(request.command_scope_id) ||
      request.command_scope_id === INTERNAL_COMMAND_SCOPE ||
      !isId(request.request_id) ||
      !isHash(request.request_hash)
    )
      reasons.push('request_invalid');
  }
  switch (command.kind) {
    case 'operation.create': {
      if (command.expected_state_revision !== '0')
        reasons.push('expected_state_revision_invalid');
      if (!isNullable(command.workflow_id, isId))
        reasons.push('workflow_id_invalid');
      if (
        typeof command.operation_kind !== 'string' ||
        command.operation_kind.length === 0
      )
        reasons.push('operation_kind_invalid');
      if (!['local_command', 'remote_mutation'].includes(command.effect_route))
        reasons.push('effect_route_invalid');
      if (!isHash(command.content_hash)) reasons.push('content_hash_invalid');
      if (!isSealedBlob(command.intent)) reasons.push('intent_invalid');
      const auto = command.auto_approval;
      if (
        auto !== null &&
        (typeof auto !== 'object' ||
          !isId(auto.approval_id) ||
          !isRevision(auto.policy_version) ||
          !isRevision(auto.current_policy_version))
      )
        reasons.push('auto_approval_invalid');
      break;
    }
    case 'operation.approve':
      if (!isId(command.approval_id)) reasons.push('approval_id_invalid');
      if (!['screen', 'policy_auto'].includes(command.route))
        reasons.push('route_invalid');
      if (
        !isRevision(command.content_version) ||
        command.content_version === '0'
      )
        reasons.push('content_version_invalid');
      if (!isHash(command.content_hash)) reasons.push('content_hash_invalid');
      if (!isNullable(command.device_id, isId))
        reasons.push('device_id_invalid');
      if (!isNullable(command.preview_id, isId))
        reasons.push('preview_id_invalid');
      if (typeof command.preview_valid !== 'boolean')
        reasons.push('preview_valid_invalid');
      if (!isNullable(command.policy_version, isRevision))
        reasons.push('policy_version_invalid');
      if (!isRevision(command.current_policy_version))
        reasons.push('policy_version_invalid');
      // 画面の承認は端末と preview、方針の承認は方針の版を必要とする（0001 の CHECK と同じ）。
      if (
        command.route === 'screen' &&
        (command.device_id === null || command.preview_id === null)
      )
        reasons.push('screen_approval_incomplete');
      if (command.route === 'policy_auto' && command.policy_version === null)
        reasons.push('policy_version_invalid');
      break;
    case 'operation.prepare':
      if (!isId(command.attempt_id)) reasons.push('attempt_id_invalid');
      break;
    case 'operation.dispatch_intent':
      if (!isId(command.attempt_id)) reasons.push('attempt_id_invalid');
      if (!isNullable(command.reservation_id, isId))
        reasons.push('reservation_id_invalid');
      break;
    case 'operation.record_result':
      if (!isId(command.attempt_id)) reasons.push('attempt_id_invalid');
      if (
        !['reconciling', 'succeeded', 'not_executed', 'unknown_held'].includes(
          command.to,
        )
      )
        reasons.push('result_state_invalid');
      if (!isNullable(command.external_id, isExternalId))
        reasons.push('external_id_invalid');
      break;
    case 'operation.cancel':
      break;
    case 'operation.recover_after_restart':
      if (!isId(command.attempt_id)) reasons.push('attempt_id_invalid');
      break;
    case 'operation.revise_content':
      if (
        !isRevision(command.content_version) ||
        command.content_version === '0' ||
        command.content_version === '1'
      )
        reasons.push('content_version_invalid');
      if (!isHash(command.content_hash)) reasons.push('content_hash_invalid');
      if (!isSealedBlob(command.intent)) reasons.push('intent_invalid');
      break;
  }
  return [...new Set(reasons)];
}
