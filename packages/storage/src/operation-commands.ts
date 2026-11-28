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
  // LocalCommand の適用（D5、ADR 0030）。用事の行・試行・承認の使用・最終状態・イベント・受付を一つの transaction で書く。
  'operation.apply_local',
  // LocalCommand の取り消し（ADR 0157）。自動で登録した用事を、変わっていなければ一つの transaction で消す。
  'operation.delete_local',
] as const;

export type DbCommandKind = (typeof DB_COMMAND_KINDS)[number];

// 取り消しの補償としてだけ作れる操作の種類（ADR 0156・0157・0198）。
export const UNDO_ONLY_KINDS: readonly string[] = [
  'mail.draft.delete',
  'task.delete',
  'calendar.event.delete',
];

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
    // 同じ対象への反復を数える鍵（03 の安全停止。ADR 0147）。Core が操作の種類と対象から作る。
    readonly safety_target_key: string;
  } | null;
  // 取り消しの補償の操作（03、ADR 0074・0147）。あれば同じ transaction で取り消しの記録を作る。
  readonly undo_of?: {
    readonly undo_id: string;
    // 取り消す自動実行の操作。
    readonly operation_id: string;
    // 一覧で本人が押した取り消し（J12 の確認）。あれば同じ transaction で画面の承認を記録し approved から始める
    // （preview_id は undo_id。ADR 0153）。無ければ承認待ちから始める。
    readonly screen_approval?: {
      readonly approval_id: string;
      // 押した端末（登録済みで失効していないこと）。
      readonly device_id: string;
    } | null;
  } | null;
  // 気づきの候補を起点にした方針による自動承認（11 §5A・§5B、ADR 0148）。auto_approval と一緒にだけ使う。
  // 判定に使った依頼と関連解析の版は、保存層が候補の行から読んで承認の行に写す（Core の値を信用しない）。
  readonly candidate_origin?: {
    readonly candidate_id: string;
    // 書込み先のアカウント（同じ依頼・操作・アカウント・カレンダーにつき一度だけ）。
    readonly account_id: string;
    // 予定のカレンダー。予定以外は null。
    readonly calendar_id: string | null;
  } | null;
  // 記録しない会話の独立した確認の承認から作る最小の操作記録（ADR 0045・0192、U42）。あれば operations.record_kind を
  // private_minimal にし、同じ transaction で画面の承認を記録して approved から始める。
  // 依頼（workflow_id）・方針による自動承認・取り消し・候補の起点とは一緒に使わない（会話・依頼へのつながりを持たない）。
  // 作れる操作の種類はラベルの変更（mail.labels.change）だけ（U502）。
  readonly private_minimal?: {
    readonly approval_id: string;
    // 承認した端末（登録済みで失効していないこと）。
    readonly device_id: string;
    // 画面の承認の preview_id。記録のために新しく作った値で、独立した確認の ID（記録しない会話の応答で端末へ返した値）とは
    // 別にする（DB の操作から記録しない会話へたどれる ID を持たない。ADR 0040・0045、U506）。
    readonly preview_id: string;
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
  // 方針による自動承認（route が policy_auto）で必須。同じ対象への反復を数える鍵（ADR 0147）。
  readonly safety_target_key?: string | null;
}

export interface PrepareOperationCommand extends DbCommandBase<'operation.prepare'> {
  // 新しい試行の ID（呼び出し側が作る）。再到着でも同じ ID になる。
  readonly attempt_id: string;
  // 本人の明示の再試行（ADR 0030）。true なら未実行が確定した（not_executed）操作からだけ始める。
  readonly retry?: boolean;
}

// 送出の直前に Core が provider から読み直した接続（ADR 0030）。DB の connections に行のない接続（B04 の模擬
// provider）の照合に使う。preview の有効性と同じく Core が判定の材料を渡し、DB worker が transaction の中で確かめる。
export interface ObservedConnection {
  readonly status:
    'active' | 'needs_reauth' | 'needs_attention' | 'disconnected';
  readonly access: 'read' | 'read_write';
  // 読み直した許可の版。命令の permission_revision（確定 intent の許可の版）と一致すること。
  readonly permission_revision: string;
}

export interface DispatchIntentCommand extends DbCommandBase<'operation.dispatch_intent'> {
  readonly attempt_id: string;
  // 予算予約（05、ADR 0006）。費用のない操作は null。あれば reserved であること。
  readonly reservation_id: string | null;
  // connection_id が null の外部変更で使う、送出の直前の接続の読み直し。
  readonly observed_connection?: ObservedConnection | null;
  // 送出する工程（D3、ADR 0030）。あれば operation_steps に送出意図と同じ transaction で記録する。
  readonly step?: {
    readonly step_id: string;
    readonly step_kind: string;
  } | null;
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

// 内容版の更新（D1、ADR 0027・0029・0030）。新しい版の確定 intent（暗号化済み）と hash を渡す。旧版の有効な承認は
// 同じ transaction で revoked にし、送出意図の前の試行（preparing）は superseded にする。
export interface ReviseContentCommand extends DbCommandBase<'operation.revise_content'> {
  // 新しい内容版（現在の版＋1）。
  readonly content_version: string;
  readonly content_hash: string;
  readonly intent: SealedBlobInput;
}

// LocalCommand の適用（D5、ADR 0030）。外部 HTTP を使わない。承認済み（approved）の操作だけ。
export interface ApplyLocalCommand extends DbCommandBase<'operation.apply_local'> {
  // 成功の試行（送出意図の時刻＝適用の時刻）と、作る用事の ID。
  readonly attempt_id: string;
  readonly task_id: string;
  // 登録先の一覧（確定 intent の target.list_id。復号は Core が行う）。
  readonly list_id: string;
  // 用事の題名・期限・本文の暗号文（purpose = task_content、所有者は tasks の task_id・版 0。ADR 0051）。
  // 用事の正本は操作の確定 intent から分け、確定 intent は J5 のとおり完了から 7 日で消える。
  readonly content: SealedBlobInput;
}

// LocalCommand の取り消し（ADR 0157）。外部 HTTP を使わない。承認済み（approved）の task.delete だけ。
// 消す用事は、取り消しの記録（undo_records）が結ぶ元の操作が作った用事で、まだ開いているものに限る。
export interface DeleteLocalCommand extends DbCommandBase<'operation.delete_local'> {
  // 成功の試行（送出意図の時刻＝適用の時刻）と、消す用事の ID。
  readonly attempt_id: string;
  readonly task_id: string;
}

export type DbCommand =
  | CreateOperationCommand
  | ApplyLocalCommand
  | DeleteLocalCommand
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

export function isId(value: unknown): value is string {
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

export function isSealedBlob(value: unknown): boolean {
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
          !isRevision(auto.current_policy_version) ||
          !isExternalId(auto.safety_target_key))
      )
        reasons.push('auto_approval_invalid');
      const undo = command.undo_of;
      if (undo !== undefined && undo !== null) {
        if (
          typeof undo !== 'object' ||
          !isId(undo.undo_id) ||
          !isId(undo.operation_id) ||
          undo.operation_id === command.operation_id ||
          (undo.screen_approval !== undefined &&
            undo.screen_approval !== null &&
            (typeof undo.screen_approval !== 'object' ||
              !isId(undo.screen_approval.approval_id) ||
              !isId(undo.screen_approval.device_id)))
        )
          reasons.push('undo_of_invalid');
        // 取り消しは本人の画面操作が起点で、方針による自動承認では作らない（03 J12）。
        else if (auto !== null) reasons.push('undo_auto_approval');
      }
      // 下書き・用事・予定の削除は、自動で作ったものの取り消しの補償だけに使う（ADR 0156・0157・0198）。それ以外では作らない。
      if (
        UNDO_ONLY_KINDS.includes(command.operation_kind) &&
        (undo === undefined || undo === null)
      )
        reasons.push('undo_only_kind');
      const origin = command.candidate_origin;
      if (origin !== undefined && origin !== null) {
        if (
          typeof origin !== 'object' ||
          !isId(origin.candidate_id) ||
          !isExternalId(origin.account_id) ||
          !isNullable(origin.calendar_id, isExternalId)
        )
          reasons.push('candidate_origin_invalid');
        // 候補の起点は方針による自動承認の判定の記録。画面の承認や取り消しには付けない（ADR 0148）。
        else if (auto === null) reasons.push('candidate_origin_without_auto');
      }
      const minimal = command.private_minimal;
      if (minimal !== undefined && minimal !== null) {
        if (
          typeof minimal !== 'object' ||
          !isId(minimal.approval_id) ||
          !isId(minimal.device_id) ||
          !isId(minimal.preview_id)
        )
          reasons.push('private_minimal_invalid');
        // 最小の操作記録は会話・依頼へつながらない外部変更だけ（ADR 0045 の U64）で、2d ではラベルの変更だけ（U502。
        // 返信の下書きは本文が本人の発言なので作らない）。依頼・自動承認・取り消し・候補の起点・端末からの要求の受付と
        // 一緒に作らない。
        else if (
          command.workflow_id !== null ||
          command.effect_route !== 'remote_mutation' ||
          command.operation_kind !== 'mail.labels.change' ||
          auto !== null ||
          (undo !== undefined && undo !== null) ||
          (origin !== undefined && origin !== null) ||
          command.request !== null
        )
          reasons.push('private_minimal_conflict');
      }
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
      // 方針の承認は同じ対象への反復を数える鍵を必要とする（ADR 0147）。
      if (
        command.route === 'policy_auto' &&
        !isExternalId(command.safety_target_key)
      )
        reasons.push('safety_target_key_invalid');
      if (
        command.route === 'screen' &&
        command.safety_target_key !== undefined &&
        command.safety_target_key !== null
      )
        reasons.push('safety_target_key_invalid');
      break;
    case 'operation.prepare':
      if (!isId(command.attempt_id)) reasons.push('attempt_id_invalid');
      if (command.retry !== undefined && typeof command.retry !== 'boolean')
        reasons.push('retry_invalid');
      break;
    case 'operation.dispatch_intent':
      if (!isId(command.attempt_id)) reasons.push('attempt_id_invalid');
      if (!isNullable(command.reservation_id, isId))
        reasons.push('reservation_id_invalid');
      if (
        command.observed_connection !== undefined &&
        command.observed_connection !== null &&
        (typeof command.observed_connection !== 'object' ||
          ![
            'active',
            'needs_reauth',
            'needs_attention',
            'disconnected',
          ].includes(command.observed_connection.status) ||
          !['read', 'read_write'].includes(
            command.observed_connection.access,
          ) ||
          !isRevision(command.observed_connection.permission_revision))
      )
        reasons.push('observed_connection_invalid');
      if (
        command.step !== undefined &&
        command.step !== null &&
        (typeof command.step !== 'object' ||
          typeof command.step.step_id !== 'string' ||
          !/^[1-9][0-9]{0,3}-[a-z_]{1,32}$/u.test(command.step.step_id) ||
          ![
            'apply_labels',
            'create_draft',
            'send',
            'create_task',
            'delete_draft',
            'delete_task',
            'create_event',
            'delete_event',
          ].includes(command.step.step_kind))
      )
        reasons.push('step_invalid');
      break;
    case 'operation.apply_local':
      if (!isId(command.attempt_id)) reasons.push('attempt_id_invalid');
      if (!isId(command.task_id)) reasons.push('task_id_invalid');
      if (
        typeof command.list_id !== 'string' ||
        command.list_id.length < 1 ||
        command.list_id.length > 128
      )
        reasons.push('list_id_invalid');
      if (!isSealedBlob(command.content)) reasons.push('content_invalid');
      break;
    case 'operation.delete_local':
      if (!isId(command.attempt_id)) reasons.push('attempt_id_invalid');
      if (!isId(command.task_id)) reasons.push('task_id_invalid');
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
