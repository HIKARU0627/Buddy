// 復元の後の保留を DB に書く（J3、設計 03 バックアップ・復元、08 §3・§4、ADR 0040・0047・0054）。
//
// 復元は、取り出した別の DB（作業用の DB）で段階 2〜5 を行い、最後に今の DB と差し替える（ADR 0040）。この関数は、
// 差し替える前の作業用の DB に、ADR 0047 の取り直し（RESTORE_RESETS）を 1 つの BEGIN IMMEDIATE の transaction で書く。
// 差し替えの後に書く手順にすると、書く前に止まったときに、承認が生きたまま・隔離の印がないまま・端末が有効なままの DB が
// 今の DB になる。作業用の DB に書いてから差し替えれば、今の DB はいつも「取り直しの済んだ DB」か「元の DB」のどちらか。
// - 計画は domain の関数（quarantineRestoredOperations・restoreDevicePlan・restoreOverageApprovalPlan・
//   restoreSafetyBreaker・restoreDeploymentPlan・restoreVoicePlan）が決める。ここは読む・書く・読み戻して確かめるだけ。
// - 書いた後に、復元の直後の操作の記録を restoredOperationProblems で読み戻して確かめ、食い違えば巻き戻す。
// - 差し替えは Core を止めてから行う（apps/core の restore-install.ts）。Core の再起動で、メモリーの上の接続・リース・
//   端末の世代・イベントの購読は残らない（ADR 0047 の P3-5）。
// 結果には件数だけを入れ、本文・ID の一覧を入れない。

import {
  quarantineRestoredOperations,
  restoreDeploymentPlan,
  restoreDevicePlan,
  restoreOverageApprovalPlan,
  restoreSafetyBreaker,
  restoreVoicePlan,
  restoredOperationProblems,
} from '@buddy/domain';
import type {
  DeviceEpochRow,
  IoStopRow,
  OperationBeforeRestore,
  RestoredDevice,
  RestoredOperationLike,
} from '@buddy/domain';
import type { SqliteDatabase } from './connection.js';
import {
  COMPLETED_OPERATION_STATES as DOMAIN_COMPLETED,
  runImmediate,
} from './operation-store.js';

export interface PreRestoreState {
  // 復元の前の今の DB の端末（中枢と同じマシンの端末を残すかの判定）。中枢を失ったときは null。
  readonly devices: readonly RestoredDevice[];
  readonly device_epochs: readonly DeviceEpochRow[];
  readonly io_stop: IoStopRow;
  readonly safety_revision: string;
}

export interface RestoreAftermathInput {
  // UTC の Unix ミリ秒。
  readonly restored_at: number;
  readonly backup_created_at: number;
  // 新しい DB の世代（UUID v4。バックアップの世代とも、復元の前の世代とも違う値）。
  readonly new_store_generation: string;
  readonly pre_restore: PreRestoreState | null;
  // 操作の種類ごとの承認の要否（承認の要らない LocalCommand は承認待ちへ戻さず取り消す）。ない種類は承認が要る側。
  readonly approval_requirements?: Readonly<
    Record<string, 'required' | 'none'>
  >;
}

export interface RestoreAftermathValue {
  readonly approvals_revoked_count: number;
  readonly operations_held_count: number;
  readonly operations_unverified_count: number;
  readonly local_operations_reset_count: number;
  readonly devices_revoked_count: number;
  readonly command_scopes_revoked_count: number;
  readonly overage_approvals_expired_count: number;
  readonly budget_reservations_unknown_count: number;
  readonly deployments_demoted_count: number;
  readonly live_sessions_closed_count: number;
  readonly connections_reauth_count: number;
  readonly sync_scopes_reset_count: number;
  readonly safety_revision: string;
}

export class RestoreAftermathRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'RestoreAftermathRejection';
    this.reasons = reasons;
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// 復元の前の今の DB から、復元の後の計画に要る値を読む（中枢が生きているとき）。
export function readPreRestoreState(db: SqliteDatabase): PreRestoreState {
  const devices = (
    db
      .prepare(
        'SELECT device_id, hub_local, revoked_at FROM devices ORDER BY device_id',
      )
      .all() as {
      device_id: string;
      hub_local: number;
      revoked_at: number | null;
    }[]
  ).map((row) => ({
    device_id: row.device_id,
    hub_local: row.hub_local === 1,
    revoked_at: row.revoked_at === null ? null : iso(row.revoked_at),
  }));
  return {
    devices,
    device_epochs: readDeviceEpochs(db),
    io_stop: readIoStop(db),
    safety_revision: readSafetyRevision(db),
  };
}

function readDeviceEpochs(db: SqliteDatabase): DeviceEpochRow[] {
  return (
    db
      .prepare(
        'SELECT device_id, io_epoch, output_epoch, audio_epoch, session_epoch, local_stop FROM device_epochs ORDER BY device_id',
      )
      .all() as {
      device_id: string;
      io_epoch: number;
      output_epoch: number;
      audio_epoch: number;
      session_epoch: number;
      local_stop: number;
    }[]
  ).map((row) => ({
    device_id: row.device_id,
    io_epoch: String(row.io_epoch),
    output_epoch: String(row.output_epoch),
    audio_epoch: String(row.audio_epoch),
    session_epoch: String(row.session_epoch),
    local_stop: row.local_stop === 1,
  }));
}

function readIoStop(db: SqliteDatabase): IoStopRow {
  const row = db
    .prepare(
      'SELECT guest_mode, global_stop FROM io_stop_state WHERE stop_id = 1',
    )
    .get() as { guest_mode: number; global_stop: number } | undefined;
  return {
    guest_mode: row?.guest_mode === 1,
    global_stop: row?.global_stop === 1,
  };
}

function readSafetyRevision(db: SqliteDatabase): string {
  const row = db
    .prepare('SELECT safety_revision FROM safety_breaker WHERE singleton = 1')
    .pluck()
    .get() as number | undefined;
  return String(row ?? 0);
}

function readOperationsBeforeRestore(
  db: SqliteDatabase,
  requirements: Readonly<Record<string, 'required' | 'none'>>,
): OperationBeforeRestore[] {
  const rows = db
    .prepare(
      `SELECT o.operation_id, o.kind, o.effect_route, o.state, o.current_content_version,
              (SELECT count(*) FROM approvals a WHERE a.operation_id = o.operation_id AND a.status = 'valid') AS valid
         FROM operations o ORDER BY o.operation_id`,
    )
    .all() as {
    operation_id: string;
    kind: string;
    effect_route: string;
    state: string;
    current_content_version: number;
    valid: number;
  }[];
  return rows.map((row) => ({
    operation_id: row.operation_id,
    effect_route: row.effect_route,
    state: row.state,
    content_version: String(row.current_content_version),
    valid_approval_count: row.valid,
    approval_requirement:
      Object.hasOwn(requirements, row.kind) && requirements[row.kind] === 'none'
        ? 'none'
        : 'required',
  }));
}

function readRestoredOperations(db: SqliteDatabase): RestoredOperationLike[] {
  return (
    db
      .prepare(
        `SELECT o.operation_id, o.effect_route, o.state, o.current_content_version, o.restore_unverified_at,
                (SELECT count(*) FROM approvals a WHERE a.operation_id = o.operation_id AND a.status = 'valid') AS valid
           FROM operations o ORDER BY o.operation_id`,
      )
      .all() as {
      operation_id: string;
      effect_route: 'local_command' | 'remote_mutation';
      state: RestoredOperationLike['state'];
      current_content_version: number;
      restore_unverified_at: number | null;
      valid: number;
    }[]
  ).map((row) => ({
    schema: 'buddy.restored-operation.v1',
    operation_id: row.operation_id,
    effect_route: row.effect_route,
    state: row.state,
    content_version: String(row.current_content_version),
    restore_unverified_at:
      row.restore_unverified_at === null
        ? null
        : iso(row.restore_unverified_at),
    valid_approval_count: row.valid,
  }));
}

// 取り直しの本体（transaction の中で呼ぶ）。
function writeAftermath(
  db: SqliteDatabase,
  input: RestoreAftermathInput,
): RestoreAftermathValue {
  const restoredIso = iso(input.restored_at);
  if (!UUID_V4.test(input.new_store_generation))
    throw new RestoreAftermathRejection(['store_generation_invalid']);
  const currentGeneration = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'store_generation'")
    .pluck()
    .get() as string | undefined;
  if (currentGeneration === input.new_store_generation)
    throw new RestoreAftermathRejection(['store_generation_not_renewed']);

  // 1. 承認の失効と、操作の隔離（J3）。
  const before = readOperationsBeforeRestore(
    db,
    input.approval_requirements ?? {},
  );
  const quarantine = quarantineRestoredOperations(before, restoredIso);
  if (!quarantine.ok) throw new RestoreAftermathRejection(quarantine.reasons);
  const approvalsRevoked = db
    .prepare("UPDATE approvals SET status = 'revoked' WHERE status = 'valid'")
    .run().changes;
  if (approvalsRevoked !== quarantine.approvals_revoked_count)
    throw new RestoreAftermathRejection(['approval_count_mismatch']);
  const stateOf = new Map(before.map((op) => [op.operation_id, op.state]));
  const updateOperation = db.prepare(
    `UPDATE operations SET state = ?, restore_unverified_at = ?, state_revision = state_revision + 1,
            completed_at = CASE WHEN ? THEN ? ELSE completed_at END
      WHERE operation_id = ?`,
  );
  const closeActiveAttempts = db.prepare(
    "UPDATE operation_attempts SET status = 'unknown_held' WHERE operation_id = ? AND status IN ('dispatching', 'reconciling')",
  );
  const supersedePreparing = db.prepare(
    "UPDATE operation_attempts SET status = 'superseded' WHERE operation_id = ? AND status = 'preparing' AND dispatch_intent_at IS NULL",
  );
  let localReset = 0;
  for (const op of quarantine.operations) {
    const from = stateOf.get(op.operation_id);
    const marked = op.restore_unverified_at !== null;
    if (from === op.state && !marked) continue;
    const completed = (DOMAIN_COMPLETED as readonly string[]).includes(
      op.state,
    );
    updateOperation.run(
      op.state,
      marked ? input.restored_at : null,
      completed && from !== op.state ? 1 : 0,
      input.restored_at,
      op.operation_id,
    );
    if (op.effect_route === 'local_command') localReset += 1;
    // 進行中の試行は、送出の境界を越えたものを結果不明に、送出意図の前のものを置き換え済みにする（同じ操作の
    // 実行中の試行を残さない。どちらも再送しない）。
    if (from !== op.state) {
      closeActiveAttempts.run(op.operation_id);
      supersedePreparing.run(op.operation_id);
    }
  }

  // 2. 中枢以外の端末の失効（U78）と、接続範囲の失効。
  const devices = (
    db
      .prepare(
        'SELECT device_id, hub_local, revoked_at FROM devices ORDER BY device_id',
      )
      .all() as {
      device_id: string;
      hub_local: number;
      revoked_at: number | null;
    }[]
  ).map((row) => ({
    device_id: row.device_id,
    hub_local: row.hub_local === 1,
    revoked_at: row.revoked_at === null ? null : iso(row.revoked_at),
  }));
  const devicePlan = restoreDevicePlan(
    devices,
    restoredIso,
    input.pre_restore?.devices ?? null,
  );
  if (!devicePlan.ok) throw new RestoreAftermathRejection([devicePlan.reason]);
  const revokeDevice = db.prepare(
    'UPDATE devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL',
  );
  for (const id of devicePlan.revoke) revokeDevice.run(input.restored_at, id);
  const scopesRevoked = db
    .prepare(
      'UPDATE command_scopes SET revoked_at = ? WHERE revoked_at IS NULL',
    )
    .run(input.restored_at).changes;

  // 3. 予算: 超過枠の承認の失効・予約中の行を使用量不明に（未送信として解放しない）。
  const overage = restoreOverageApprovalPlan(
    db
      .prepare(
        'SELECT approval_id, status FROM budget_overage_approvals ORDER BY approval_id',
      )
      .all() as { approval_id: string; status: string }[],
  );
  const expireOverage = db.prepare(
    "UPDATE budget_overage_approvals SET status = 'expired' WHERE approval_id = ? AND status IN ('pending', 'approved')",
  );
  for (const id of overage.expire) expireOverage.run(id);
  const reservationsUnknown = db
    .prepare(
      "UPDATE budget_reservations SET status = 'usage_unknown' WHERE status = 'reserved'",
    )
    .run().changes;

  // 4. 安全停止（本人が画面で再開するまで止める）。
  const safety = restoreSafetyBreaker({
    safety_revision: readSafetyRevision(db),
    pre_restore_safety_revision: input.pre_restore?.safety_revision ?? null,
    restored_at: restoredIso,
  });
  if (!safety.ok) throw new RestoreAftermathRejection([safety.reason]);
  db.prepare(
    `INSERT INTO safety_breaker (singleton, state, safety_revision, stop_reason, stopped_at, resumed_by_device_id)
     VALUES (1, 'stopped', ?, 'restored_from_backup', ?, NULL)
     ON CONFLICT (singleton) DO UPDATE SET state = 'stopped', safety_revision = excluded.safety_revision,
       stop_reason = 'restored_from_backup', stopped_at = excluded.stopped_at, resumed_by_device_id = NULL`,
  ).run(Number(safety.safety_revision), input.restored_at);

  // 5. 配備の格下げ（有効にし直すのは本人の操作）。
  const deployments = restoreDeploymentPlan(
    db
      .prepare(
        'SELECT deployment_id, stage FROM deployments ORDER BY deployment_id',
      )
      .all() as { deployment_id: string; stage: string }[],
  );
  const demote = db.prepare(
    "UPDATE deployments SET stage = 'evaluated' WHERE deployment_id = ? AND stage = 'active'",
  );
  for (const id of deployments.demote) demote.run(id);

  // 6. 音声の世代・入出力の停止・開いたままに戻った Live の接続。
  const liveRows = db
    .prepare(
      "SELECT live_session_id, control_state, control_epoch, closure, ended_at, end_reason FROM live_sessions WHERE control_state <> 'closed' ORDER BY live_session_id",
    )
    .all() as {
    live_session_id: string;
    control_state: string;
    control_epoch: number;
    closure: string;
    ended_at: number | null;
    end_reason: string | null;
  }[];
  const voice = restoreVoicePlan({
    restored_at: restoredIso,
    restored_device_ids: devices.map((device) => device.device_id),
    device_epochs: readDeviceEpochs(db),
    pre_restore_device_epochs: input.pre_restore?.device_epochs ?? null,
    io_stop: readIoStop(db),
    pre_restore_io_stop: input.pre_restore?.io_stop ?? null,
    live_sessions: liveRows.map((row) => ({
      live_session_id: row.live_session_id,
      control_state: row.control_state,
      control_epoch: String(row.control_epoch),
      closure: row.closure,
      ended_at: row.ended_at === null ? null : iso(row.ended_at),
      end_reason: row.end_reason,
    })),
  });
  if (!voice.ok) throw new RestoreAftermathRejection(voice.reasons);
  const epochExists = db.prepare(
    'SELECT 1 FROM device_epochs WHERE device_id = ?',
  );
  const updateEpoch = db.prepare(
    'UPDATE device_epochs SET io_epoch = ?, output_epoch = ?, audio_epoch = ?, session_epoch = ?, local_stop = 1, updated_at = ? WHERE device_id = ?',
  );
  const insertEpoch = db.prepare(
    'INSERT INTO device_epochs (device_id, io_epoch, output_epoch, audio_epoch, session_epoch, local_stop, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
  );
  for (const row of voice.device_epochs) {
    const values = [
      Number(row.io_epoch),
      Number(row.output_epoch),
      Number(row.audio_epoch),
      Number(row.session_epoch),
    ] as const;
    if (epochExists.get(row.device_id) !== undefined)
      updateEpoch.run(...values, input.restored_at, row.device_id);
    else insertEpoch.run(row.device_id, ...values, input.restored_at);
  }
  // 0009 が 1 行を作り、消せない（io_stop_state_permanent）。挿入はその行がないときだけ。
  const guest = voice.io_stop.guest_mode ? 1 : 0;
  const stopped = db
    .prepare(
      'UPDATE io_stop_state SET guest_mode = ?, global_stop = 1, updated_at = ? WHERE stop_id = 1',
    )
    .run(guest, input.restored_at).changes;
  if (stopped === 0)
    db.prepare(
      'INSERT INTO io_stop_state (stop_id, guest_mode, global_stop, updated_at) VALUES (1, ?, 1, ?)',
    ).run(guest, input.restored_at);
  const closeLive = db.prepare(
    "UPDATE live_sessions SET control_state = 'closed', control_epoch = ?, closure = 'close_unconfirmed', usage_seconds = NULL, ended_at = ?, end_reason = ? WHERE live_session_id = ?",
  );
  for (const row of voice.live_sessions)
    closeLive.run(
      Number(row.control_epoch),
      Date.parse(row.ended_at),
      row.end_reason,
      row.live_session_id,
    );

  // 7. 外部サービスの再認証（OAuth トークンはバックアップにない）と、同期のカーソルの取り直し。
  const reauth = db
    .prepare(
      "UPDATE connections SET status = 'needs_reauth' WHERE status IN ('active', 'needs_attention')",
    )
    .run().changes;
  const syncReset = db
    .prepare(
      'UPDATE sync_scopes SET provider_cursor = NULL, pending_full = 1, active_scan_id = NULL',
    )
    .run().changes;

  // 8. DB の世代と、効いている復元の時刻（予算の保留・付帯クレジット・候補起点の自動実行の検査が読む）。
  const setMeta = db.prepare(
    'INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  );
  setMeta.run('store_generation', input.new_store_generation);
  setMeta.run('restore_restored_at', String(input.restored_at));
  setMeta.run('restore_backup_created_at', String(input.backup_created_at));

  // 読み戻して確かめる（契約の RestoredOperation の意味検査と同じ）。
  const problems = readRestoredOperations(db).flatMap(
    restoredOperationProblems,
  );
  if (problems.length > 0)
    throw new RestoreAftermathRejection([...new Set(problems)]);
  return {
    approvals_revoked_count: approvalsRevoked,
    operations_held_count: quarantine.operations_held_count,
    operations_unverified_count: quarantine.operations_unverified_count,
    local_operations_reset_count: localReset,
    devices_revoked_count: devicePlan.devices_revoked_count,
    command_scopes_revoked_count: scopesRevoked,
    overage_approvals_expired_count: overage.overage_approvals_expired_count,
    budget_reservations_unknown_count: reservationsUnknown,
    deployments_demoted_count: deployments.deployments_demoted_count,
    live_sessions_closed_count: voice.live_sessions.length,
    connections_reauth_count: reauth,
    sync_scopes_reset_count: syncReset,
    safety_revision: safety.safety_revision,
  };
}

// 作業用の DB に、復元の後の保留を 1 つの transaction で書く。失敗すれば何も書かずに例外を投げる
// （RestoreAftermathRejection は計画できない・読み戻しが食い違う。それ以外は SQLite の制約・書込みの失敗）。
export function applyRestoreAftermath(
  db: SqliteDatabase,
  input: RestoreAftermathInput,
  options: { readonly beforeCommit?: () => void } = {},
): RestoreAftermathValue {
  return runImmediate(db, () => writeAftermath(db, input), options.beforeCommit)
    .value;
}
