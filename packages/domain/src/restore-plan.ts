// 復元の 6 段階の判定（設計 03 バックアップ・復元、08 §4、ADR 0008・0040・0047、B06-05）。
// 台帳の確認 → 期限切れの削除 → 忘却の適用 → DB の検証 → 画面と索引の作り直し → 外部の状態の照合、の順に、
// 段階ごとの合否と理由を決め、復元の結果（RestoreResult の形）を組み立てる。ファイルを開く・鍵を開く・削除・差し替えは
// Core（B06-08）が行い、その観測を入力として渡す。最新の台帳を確認できない・判別できないときは記憶と会話を戻さない。

import {
  BACKUP_ZERO_HASH,
  backupManifestProblems,
  backupTablePlan,
  isBackupGeneration,
  keyWrapFor,
  parseBackupTime,
  type BackupKeyPurpose,
  type BackupManifestLike,
} from './backup-plan.js';
import { restoreReasons, type LedgerCopy } from './memory.js';
import { checkClock } from './retention-sweep.js';

export const RESTORE_STAGES = [
  'ledger_check',
  'expiry_purge',
  'forget_apply',
  'db_verify',
  'rebuild_views',
  'external_reconcile',
] as const;
export type RestoreStageName = (typeof RESTORE_STAGES)[number];

// 契約の RestoreRejectionReason と同じ値・同じ順（理由を返すときはこの順に並べる）。
export const RESTORE_REJECTIONS = [
  'latest_ledger_unconfirmed',
  'latest_ledger_missing',
  'backup_newer_than_ledger',
  'ledger_chain_invalid',
  'ledger_lineage_mismatch',
  'backup_ledger_hash_mismatch',
  'manifest_invalid',
  'backup_unreadable',
  'clock_regression',
  'expiry_purge_failed',
  'forget_apply_failed',
  'db_integrity_failed',
  'schema_newer_than_code',
  'rebuild_failed',
] as const;
export type RestoreRejection = (typeof RESTORE_REJECTIONS)[number];

// 段階ごとに出せる理由（ADR 0040 の表。scripts/contract-tools.mjs の RESTORE_STAGE_REASONS と同じ）。
export const RESTORE_STAGE_REJECTIONS: Readonly<
  Record<RestoreStageName, readonly RestoreRejection[]>
> = {
  ledger_check: [
    'latest_ledger_unconfirmed',
    'latest_ledger_missing',
    'backup_newer_than_ledger',
    'ledger_chain_invalid',
    'ledger_lineage_mismatch',
    'backup_ledger_hash_mismatch',
    'manifest_invalid',
  ],
  expiry_purge: [
    'backup_unreadable',
    'clock_regression',
    'expiry_purge_failed',
  ],
  forget_apply: ['forget_apply_failed'],
  db_verify: ['db_integrity_failed', 'schema_newer_than_code'],
  rebuild_views: ['rebuild_failed'],
  external_reconcile: [],
};

// 台帳の確認で止まったときに、非機密の設定だけを戻してよい理由（最新の台帳がない・確認できない・台帳が巻き戻った）。
// 系譜・連鎖・hash・封筒の不一致は、別の・壊れた・書き換えたバックアップの印なので、設定も戻さない（U75）。
export const RESTORE_SETTINGS_ONLY_REJECTIONS: readonly RestoreRejection[] = [
  'latest_ledger_unconfirmed',
  'latest_ledger_missing',
  'backup_newer_than_ledger',
];

// settings_only で戻す表（U75）。本文・個人の内容・認可（端末・接続・承認）・実行の状態・予算を持たず、
// 他の表を参照しない表だけ。user_directives（会話の内容に由来し忘却の対象になり得る）・home_networks（端末を参照）・
// safety_breaker（停止の状態を古い値へ戻し得る）は含めない。予算・バックアップの設定はファイルで、DB の外。
export const RESTORE_SETTINGS_ONLY_TABLES: readonly string[] = ['deployments'];

export interface RestoreStageDecision {
  readonly stage: RestoreStageName;
  readonly status: 'passed' | 'failed' | 'pending';
  readonly reasons: readonly RestoreRejection[];
}

const ordered = (reasons: Iterable<RestoreRejection>): RestoreRejection[] => {
  const set = new Set(reasons);
  return RESTORE_REJECTIONS.filter((reason) => set.has(reason));
};

const decision = (
  stage: RestoreStageName,
  reasons: Iterable<RestoreRejection>,
): RestoreStageDecision => {
  const list = ordered(reasons);
  return {
    stage,
    status: list.length === 0 ? 'passed' : 'failed',
    reasons: list,
  };
};

// --- 段階 1: 台帳の確認 ---

export interface RestoreLedgerCandidate {
  // 'hub' は中枢の台帳。それ以外は端末の複製（端末の ID）。
  readonly holder: string;
  readonly ledger_id: string;
  // 台帳のファイルの意味検査（欠番・連鎖・head・1 件の重複）に通ったか。
  readonly chain_valid: boolean;
  // 世代 1 から head までの全体か（部分の複製は使えない）。
  readonly complete: boolean;
  readonly head_generation: string;
  // 封筒の forgetting_generation の世代の entry_hash（世代 0 は 64 個の 0）。head より先なら null。
  readonly hash_at_backup_generation: string | null;
}

export interface RestoreLedgerCheckInput {
  readonly manifest: BackupManifestLike;
  readonly ledgers: readonly RestoreLedgerCandidate[];
  // 中枢と端末が知っている最新の世代（null は確認できない）。
  readonly latest_known_generation: string | null;
  // 中枢の台帳の鍵（schema_meta に記録した ID と、KeyStore にある ID。どちらも null はない）。
  readonly hub_ledger_key: {
    readonly recorded_key_id: string | null;
    readonly keystore_key_id: string | null;
  };
}

export interface RestoreLedgerCheck {
  readonly decision: RestoreStageDecision;
  // 段階 3 で当てる台帳（最も新しい使える台帳）。止まったときは null。
  readonly ledger: {
    readonly holder: string;
    readonly head_generation: string;
  } | null;
  readonly settings_only_eligible: boolean;
}

export function restoreLedgerCheck(
  input: RestoreLedgerCheckInput,
): RestoreLedgerCheck {
  const fail = (reasons: Iterable<RestoreRejection>): RestoreLedgerCheck => {
    const result = decision('ledger_check', reasons);
    return {
      decision: result,
      ledger: null,
      settings_only_eligible:
        result.reasons.length > 0 &&
        result.reasons.every((reason) =>
          RESTORE_SETTINGS_ONLY_REJECTIONS.includes(reason),
        ),
    };
  };
  const manifest = input.manifest;
  if (backupManifestProblems(manifest).length > 0)
    return fail(['manifest_invalid']);
  const reasons = new Set<RestoreRejection>();
  const holders = input.ledgers.map((ledger) => ledger.holder);
  // 同じ持ち主の台帳が 2 つあると、どちらが正しいかを決められない。
  if (new Set(holders).size !== holders.length)
    reasons.add('latest_ledger_unconfirmed');
  const hub = input.ledgers.find((ledger) => ledger.holder === 'hub') ?? null;
  if (hub !== null && hub.ledger_id !== manifest.ledger_id)
    reasons.add('ledger_lineage_mismatch');
  if (
    hub === null &&
    input.ledgers.length > 0 &&
    input.ledgers.every((ledger) => ledger.ledger_id !== manifest.ledger_id)
  )
    reasons.add('ledger_lineage_mismatch');
  if (hub !== null && hub.ledger_id === manifest.ledger_id && !hub.chain_valid)
    reasons.add('ledger_chain_invalid');

  // 台帳の鍵（取り違え・欠落）。同じ系譜の中では台帳の鍵は変えないので、記録・KeyStore の鍵と封筒の鍵の ID が
  // 違えば、別の HMAC の空間（別の系譜）として拒否する。台帳に項目があるのに鍵を記録していなければ確かめられない。
  const ledgerWrap = keyWrapFor(manifest.key_wraps, 'ledger_hmac_key');
  const { recorded_key_id: recorded, keystore_key_id: keystore } =
    input.hub_ledger_key;
  if (
    ledgerWrap === null ||
    (recorded !== null && recorded !== ledgerWrap.key_id) ||
    (keystore !== null && keystore !== ledgerWrap.key_id)
  )
    reasons.add('ledger_lineage_mismatch');
  if (
    recorded === null &&
    hub !== null &&
    hub.ledger_id === manifest.ledger_id &&
    hub.head_generation !== '0'
  )
    reasons.add('latest_ledger_unconfirmed');

  const usable = input.ledgers.filter(
    (ledger) =>
      ledger.ledger_id === manifest.ledger_id &&
      ledger.chain_valid &&
      ledger.complete &&
      isBackupGeneration(ledger.head_generation),
  );
  const copies: LedgerCopy[] = usable.map((ledger) => ({
    holder: ledger.holder,
    forgetting_generation: ledger.head_generation,
    complete: true,
  }));
  let latest: string | null = null;
  if (isBackupGeneration(input.latest_known_generation)) {
    let max = BigInt(input.latest_known_generation);
    for (const ledger of usable) {
      const head = BigInt(ledger.head_generation);
      if (head > max) max = head;
    }
    latest = max.toString();
  }
  for (const reason of restoreReasons({
    backupForgettingGeneration: manifest.forgetting_generation,
    latestKnownGeneration: latest,
    copies,
  }).reasons)
    reasons.add(reason as RestoreRejection);

  // 封筒の台帳の hash が、使える台帳の同じ世代の hash と一致すること（同じ歴史から取ったバックアップか）。
  const backupGeneration = BigInt(manifest.forgetting_generation);
  for (const ledger of usable) {
    if (BigInt(ledger.head_generation) < backupGeneration) continue;
    const expected =
      backupGeneration === 0n ? BACKUP_ZERO_HASH : manifest.ledger_head_hash;
    if (ledger.hash_at_backup_generation !== expected)
      reasons.add('backup_ledger_hash_mismatch');
  }
  if (reasons.size > 0) return fail(reasons);

  // 最も新しい台帳（同じ世代なら中枢を優先）。
  const best = [...usable].sort((a, b) => {
    const diff = BigInt(b.head_generation) - BigInt(a.head_generation);
    if (diff !== 0n) return diff > 0n ? 1 : -1;
    return (a.holder === 'hub' ? 0 : 1) - (b.holder === 'hub' ? 0 : 1);
  })[0];
  return {
    decision: decision('ledger_check', []),
    ledger:
      best === undefined
        ? null
        : { holder: best.holder, head_generation: best.head_generation },
    settings_only_eligible: false,
  };
}

// --- 段階 2: 期限切れの削除の前提（開けるか・時計を信じられるか） ---

export interface RestoreOpenInput {
  readonly manifest_created_at: string;
  readonly started_at: string;
  readonly now: string;
  readonly last_checked_at: string | null;
  // 入力した復旧キーの確認値と、記録の確認値の比較（記録がなければ unavailable）。
  readonly recovery_check: 'match' | 'mismatch' | 'unavailable';
  // 3 つの包みを開けたか（AES-GCM の認証タグが合ったか）。
  readonly unwrap: Readonly<Record<BackupKeyPurpose, 'ok' | 'failed'>>;
  // keyInstallPlan が通ったか（同じ ID で素材が違う鍵・台帳の鍵の衝突がない）。
  readonly key_install_ok: boolean;
  // 本体の大きさと SHA-256 が封筒と一致したか。
  readonly payload_matches: boolean;
  // 期限切れの削除（sweepPlan の計画の実行）を作業用の DB に当て終えた時刻（Core が記録する）。null は実行していない
  // （Sonnet の P2-5。開けることと時計だけでは、期限切れの内容を消したことにならない）。
  readonly purge_applied_at: string | null;
}

export interface RestoreOpenCheck {
  readonly decision: RestoreStageDecision;
  // 期限の判定に使う時刻（止まったときは null）。
  readonly effective_now: string | null;
}

// 開けない（鍵がない・取り違え・本体の破損）は backup_unreadable。時計が最終確認時刻・復元の開始・バックアップの
// 作成より前へ戻っているときは clock_regression（期限を判定できない。03）。掃除と違い、復元は戻った時計で進めない。
// 開けて時計も正しいのに、削除を当てた記録がない・復元の開始より前の記録は expiry_purge_failed。当てた時刻が今より
// 先なら、時計が戻った（clock_regression）。
export function restoreOpenCheck(input: RestoreOpenInput): RestoreOpenCheck {
  const reasons = new Set<RestoreRejection>();
  if (
    input.recovery_check === 'mismatch' ||
    (['backup_file', 'data_key', 'ledger_hmac_key'] as const).some(
      (purpose) => input.unwrap[purpose] !== 'ok',
    ) ||
    !input.key_install_ok ||
    !input.payload_matches
  )
    reasons.add('backup_unreadable');
  const clock = checkClock(input.now, input.last_checked_at);
  const now = parseBackupTime(input.now);
  const started = parseBackupTime(input.started_at);
  const created = parseBackupTime(input.manifest_created_at);
  if (
    !clock.ok ||
    clock.state === 'regressed' ||
    now === null ||
    started === null ||
    created === null ||
    now < started ||
    now < created
  )
    reasons.add('clock_regression');
  const purged =
    input.purge_applied_at === null
      ? null
      : parseBackupTime(input.purge_applied_at);
  if (now !== null && purged !== null && purged > now)
    reasons.add('clock_regression');
  if (
    reasons.size === 0 &&
    (purged === null || started === null || purged < started)
  )
    reasons.add('expiry_purge_failed');
  const result = decision('expiry_purge', reasons);
  return {
    decision: result,
    effective_now: result.status === 'passed' ? input.now : null,
  };
}

// --- 段階 3〜6 ---

// 忘却の適用: 段階 1 で選んだ台帳の head まで当てたこと。
export function restoreForgetCheck(input: {
  readonly applied_generation: string | null;
  readonly required_generation: string;
}): RestoreStageDecision {
  const ok =
    isBackupGeneration(input.applied_generation) &&
    isBackupGeneration(input.required_generation) &&
    BigInt(input.applied_generation) >= BigInt(input.required_generation);
  return decision('forget_apply', ok ? [] : ['forget_apply_failed']);
}

export interface RestoreDbVerifyInput {
  readonly integrity_ok: boolean;
  readonly foreign_keys_ok: boolean;
  // 取り出した DB の schema_meta の版・封筒の版・このコードの版（ADR 0016: ダウングレードしない）。
  readonly restored_schema_version: number;
  readonly manifest_schema_version: number;
  readonly code_schema_version: number;
  // 操作の隔離の計画（quarantineRestoredOperations）が通ったか（読めない状態・経路の操作がない）。
  readonly operations_plan_ok: boolean;
  // 取り出した DB の実際の表（Core が sqlite_schema から、SQLite の内部の表を除いて読む）と、DB の中の値（Sonnet の P2-6）。
  readonly restored_tables: readonly string[];
  readonly restored_store_generation: string;
  readonly restored_ledger_id: string;
  readonly restored_forgetting_generation: string;
  // 照合の相手: 封筒の store_generation・ledger_id と、段階 1 で選び段階 3 で当てた台帳の head の世代。
  readonly expected: {
    readonly store_generation: string;
    readonly ledger_id: string;
    readonly forgetting_generation: string;
  };
}

export function restoreDbVerifyCheck(
  input: RestoreDbVerifyInput,
): RestoreStageDecision {
  const reasons = new Set<RestoreRejection>();
  const versions = [
    input.restored_schema_version,
    input.manifest_schema_version,
    input.code_schema_version,
  ];
  if (versions.some((version) => !Number.isSafeInteger(version) || version < 1))
    reasons.add('db_integrity_failed');
  else if (
    input.restored_schema_version > input.code_schema_version ||
    input.manifest_schema_version > input.code_schema_version
  )
    reasons.add('schema_newer_than_code');
  if (
    !input.integrity_ok ||
    !input.foreign_keys_ok ||
    input.restored_schema_version !== input.manifest_schema_version ||
    !input.operations_plan_ok ||
    // 表の一覧に未知の表・必須の表の欠けがない（取れない DB・別の作りの DB を戻さない）。
    !backupTablePlan(input.restored_tables).ok ||
    // DB の中の世代・系譜が、封筒と当てた台帳に一致する（封筒と中身の取り違えを戻さない）。
    input.restored_store_generation !== input.expected.store_generation ||
    input.restored_ledger_id !== input.expected.ledger_id ||
    input.restored_forgetting_generation !==
      input.expected.forgetting_generation
  )
    reasons.add('db_integrity_failed');
  return decision('db_verify', reasons);
}

export function restoreRebuildCheck(input: {
  readonly ok: boolean;
}): RestoreStageDecision {
  return decision('rebuild_views', input.ok ? [] : ['rebuild_failed']);
}

// 外部の状態の照合は失敗で復元を止めない。再認証が済むまで pending（OAuth トークンはバックアップにないので、
// 復元の直後はいつも pending）。照合できない操作は隔離のまま残る（restore-aftermath.ts）。
export function restoreReconcileCheck(input: {
  readonly reauth_complete: boolean;
}): RestoreStageDecision {
  return {
    stage: 'external_reconcile',
    status: input.reauth_complete ? 'passed' : 'pending',
    reasons: [],
  };
}

// --- 結果の組み立て ---

export interface RestoreAftermathLike {
  readonly new_store_generation: string;
  readonly applied_forgetting_generation: string;
  readonly expired_deleted_count: number;
  readonly forgotten_applied_count: number;
  readonly approvals_revoked_count: number;
  readonly operations_held_count: number;
  readonly operations_unverified_count: number;
  readonly consents_reset: true;
  readonly connections_reauth_required: true;
}

export interface RestoreResultLike {
  readonly schema: 'buddy.restore-result.v1';
  readonly restore_id: string;
  readonly backup_id: string;
  readonly backup_store_generation: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly outcome: 'restored' | 'settings_only' | 'rejected';
  readonly failed_stage: RestoreStageName | null;
  readonly stages: readonly {
    readonly stage: RestoreStageName;
    readonly status: 'passed' | 'failed' | 'not_run' | 'pending';
    readonly reasons: readonly RestoreRejection[];
  }[];
  readonly after_restore: RestoreAftermathLike | null;
}

export interface RestoreResultInput {
  readonly restore_id: string;
  readonly backup_id: string;
  readonly backup_store_generation: string;
  readonly started_at: string;
  readonly finished_at: string;
  // 実行した段階の判定（この順。止まった段階まで）。
  readonly decisions: readonly RestoreStageDecision[];
  // 段階 1 の settings_only_eligible と、非機密の設定を実際に読めたか（復旧キーで本体を開けたか）。
  readonly settings_only: {
    readonly eligible: boolean;
    readonly settings_readable: boolean;
  };
  readonly after_restore: RestoreAftermathLike | null;
}

export type RestoreResultProblem =
  | 'stage_order_invalid'
  | 'stages_incomplete'
  | 'stage_after_failure'
  | 'pending_outside_reconcile'
  | 'external_reconcile_cannot_fail'
  | 'failed_stage_without_reason'
  | 'reason_without_failure'
  | 'reason_not_allowed_for_stage'
  | 'after_restore_mismatch'
  | 'store_generation_not_renewed'
  | 'held_exceeds_unverified'
  | 'time_invalid'
  | 'finished_before_started';

export type RestoreResultBuild =
  | { readonly ok: true; readonly result: RestoreResultLike }
  | { readonly ok: false; readonly reasons: readonly RestoreResultProblem[] };

// 段階の判定から、契約の RestoreResult の形を組み立てる。止まった段階より後は not_run。全段階が通れば restored、
// 台帳の確認で止まり設定だけを戻せるときは settings_only、それ以外は rejected。食い違う入力は組み立てない。
export function buildRestoreResult(
  input: RestoreResultInput,
): RestoreResultBuild {
  const problems = new Set<RestoreResultProblem>();
  const decisions = input.decisions;
  decisions.forEach((item, index) => {
    if (item.stage !== RESTORE_STAGES[index])
      problems.add('stage_order_invalid');
    if (item.status === 'failed' && index !== decisions.length - 1)
      problems.add('stage_after_failure');
    if (item.status === 'pending' && item.stage !== 'external_reconcile')
      problems.add('pending_outside_reconcile');
    if (item.status === 'failed' && item.stage === 'external_reconcile')
      problems.add('external_reconcile_cannot_fail');
    if (item.status === 'failed' && item.reasons.length === 0)
      problems.add('failed_stage_without_reason');
    if (item.status !== 'failed' && item.reasons.length > 0)
      problems.add('reason_without_failure');
    if (
      item.reasons.some(
        (reason) => !RESTORE_STAGE_REJECTIONS[item.stage]?.includes(reason),
      )
    )
      problems.add('reason_not_allowed_for_stage');
  });
  const failedIndex = decisions.findIndex((item) => item.status === 'failed');
  if (failedIndex < 0 && decisions.length !== RESTORE_STAGES.length)
    problems.add('stages_incomplete');
  const failed = failedIndex < 0 ? null : decisions[failedIndex];
  const restored = failed === null;
  if (restored !== (input.after_restore !== null))
    problems.add('after_restore_mismatch');
  const after = input.after_restore;
  if (after !== null) {
    if (after.new_store_generation === input.backup_store_generation)
      problems.add('store_generation_not_renewed');
    if (after.operations_held_count > after.operations_unverified_count)
      problems.add('held_exceeds_unverified');
  }
  const started = parseBackupTime(input.started_at);
  const finished = parseBackupTime(input.finished_at);
  if (started === null || finished === null) problems.add('time_invalid');
  else if (
    finished < started &&
    !(
      failed !== null &&
      failed !== undefined &&
      failed.stage === 'expiry_purge' &&
      failed.reasons.includes('clock_regression')
    )
  )
    problems.add('finished_before_started');
  if (problems.size > 0) return { ok: false, reasons: [...problems] };
  const outcome = restored
    ? 'restored'
    : failed?.stage === 'ledger_check' &&
        input.settings_only.eligible &&
        input.settings_only.settings_readable &&
        failed.reasons.every((reason) =>
          RESTORE_SETTINGS_ONLY_REJECTIONS.includes(reason),
        )
      ? 'settings_only'
      : 'rejected';
  return {
    ok: true,
    result: {
      schema: 'buddy.restore-result.v1',
      restore_id: input.restore_id,
      backup_id: input.backup_id,
      backup_store_generation: input.backup_store_generation,
      started_at: input.started_at,
      finished_at: input.finished_at,
      outcome,
      failed_stage: failed?.stage ?? null,
      stages: RESTORE_STAGES.map((stage, index) => {
        const item = decisions[index];
        return item === undefined
          ? { stage, status: 'not_run' as const, reasons: [] }
          : { stage, status: item.status, reasons: [...item.reasons] };
      }),
      after_restore: after,
    },
  };
}
