// バックアップの中身と世代の判定（設計 03 バックアップ・復元・忘却と再取り込み、ADR 0040・0047、B06-05）。
// 何を含め何を含めないか、封筒（BackupManifest）の意味の検査、古いバックアップの置き換え・削除の計画を返すだけで、
// スナップショットの取得・暗号化・ファイルの削除は Core（B06-08）が行う。時計は引数で注入する。
// 決まっていない・判別できないときは、含めない・バックアップを取らない・消さずに残す側へ倒す（ただし期限は延ばさない）。

import { checkClock } from './retention-sweep.js';

// --- 時刻と数の読み取り（retention-sweep.ts と同じ規則。UTC の RFC 3339 だけ） ---

const UTC_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/u;

export function parseBackupTime(time: unknown): number | null {
  if (typeof time !== 'string' || !UTC_TIME.test(time)) return null;
  const millis = Date.parse(time);
  if (Number.isNaN(millis)) return null;
  return new Date(millis).toISOString().slice(0, 19) === time.slice(0, 19)
    ? millis
    : null;
}

const GENERATION = /^(0|[1-9][0-9]*)$/u;
const HASH = /^[0-9a-f]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const BACKUP_ZERO_HASH = '0'.repeat(64);
const DAY_MS = 86_400_000;

export const isBackupGeneration = (value: unknown): value is string =>
  typeof value === 'string' && GENERATION.test(value);

// --- 含める表・含めない表（U73） ---

// 必ず含める表。忘却台帳の 2 つは除外できない（ADR 0040 の required_table_excluded）。schema_meta は DB の版と鍵の記録。
export const BACKUP_REQUIRED_TABLES: readonly string[] = [
  'schema_meta',
  'forget_ledger',
  'forget_ledger_items',
];

export type BackupTableExclusion =
  // 元情報の本文キャッシュ（03: 24 時間・元サービスが正本）。復元の後は再認証して取り直す。
  | 'source_cache'
  // 進行中の同期の仮置き。復元の後は全体を走査し直す（カーソルの取り直し）。
  | 'sync_in_flight'
  // DB の世代（store_generation）に結び付く。復元で世代を新しくするので意味を失う。
  | 'store_generation_bound'
  // 接続範囲と命令の受付。復元の後に端末が取り直す。
  | 'connection_scope'
  // 5 分の短命のペアリング（秘密の hash を含む）。
  | 'pairing_short_lived'
  // 進行中の非同期処理の再検査の記録。復元の後に届く結果は、記録がないので破棄される（閉じた側）。
  | 'in_flight_guard'
  // 端末の最新の報告（6 分の鮮度）。復元の後に端末が報告し直す。
  | 'device_report';

// 含めない表（03 の 4 つは表ではないので excluded_data に記録する。ここは短命の運用データ。原本に決めなし。U73）。
export const BACKUP_EXCLUDED_TABLES: Readonly<
  Record<string, BackupTableExclusion>
> = {
  source_items: 'source_cache',
  sync_batches: 'sync_in_flight',
  sync_staging: 'sync_in_flight',
  event_outbox: 'store_generation_bound',
  command_scopes: 'connection_scope',
  command_receipts: 'connection_scope',
  pairing_sessions: 'pairing_short_lived',
  pairing_claims: 'pairing_short_lived',
  async_context_guards: 'in_flight_guard',
  home_network_reports: 'device_report',
};

// 含める表（マイグレーション 0001〜0007 の表から、上の除外を引いたもの）。ここにも除外にもない表は未知で、
// バックアップを取らない（何が入っているか分からない表を、黙って含めも捨てもしない）。表を足すマイグレーションは、
// この一覧か除外の一覧に必ず載せる（scripts/backup-restore.test.mjs がマイグレーションの CREATE TABLE と照合する）。
export const BACKUP_INCLUDED_TABLES: readonly string[] = [
  ...BACKUP_REQUIRED_TABLES,
  'sealed_blobs',
  'devices',
  'connections',
  'sessions',
  'turns',
  'turn_responses',
  'workflows',
  'input_snapshots',
  'operations',
  'operation_versions',
  'approvals',
  'operation_attempts',
  'operation_steps',
  'auto_actions',
  'undo_records',
  'safety_breaker',
  'safety_window_counts',
  'budget_reservations',
  'budget_overage_approvals',
  'budget_months',
  'budget_month_confirmations',
  // 採用したクレジットの残高の観測（0008。本文なし・書き換え・削除不可）。予算の記録と同じく含める。復元の後に古い観測で
  // 残高を多く見ないよう、restore-aftermath.ts の restoreCreditReasons で新しい観測まで止める。
  'budget_credit_observations',
  'live_sessions',
  'sync_scopes',
  'request_entities',
  'request_entity_operations',
  'related_analyses',
  'notification_candidates',
  'deliveries',
  'memories',
  'memory_sources',
  'user_directives',
  'intent_shadow',
  'deployments',
  'evaluation_results',
  'home_networks',
  'tasks',
];

const has = (record: object, key: string): boolean =>
  Object.hasOwn(record, key);

export type BackupTablePlan =
  | {
      readonly ok: true;
      // 封筒の excluded_tables（辞書順）。
      readonly excluded_tables: readonly string[];
      readonly included_tables: readonly string[];
      // 除外した表が持つ暗号文（sealed_blobs の owner_table）も、写しから消す。
      readonly excluded_blob_owner_tables: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reasons: readonly (
        'unknown_table' | 'required_table_missing' | 'duplicate_table'
      )[];
      readonly unknown_tables: readonly string[];
      readonly missing_required_tables: readonly string[];
    };

// DB の表の一覧（Core が sqlite_schema から読む）を、含める・含めないに分ける。
export function backupTablePlan(tables: readonly string[]): BackupTablePlan {
  const reasons = new Set<
    'unknown_table' | 'required_table_missing' | 'duplicate_table'
  >();
  if (new Set(tables).size !== tables.length) reasons.add('duplicate_table');
  const unknown = tables.filter(
    (table) =>
      !BACKUP_INCLUDED_TABLES.includes(table) &&
      !has(BACKUP_EXCLUDED_TABLES, table),
  );
  if (unknown.length > 0) reasons.add('unknown_table');
  const missing = BACKUP_REQUIRED_TABLES.filter(
    (table) => !tables.includes(table),
  );
  if (missing.length > 0) reasons.add('required_table_missing');
  if (reasons.size > 0)
    return {
      ok: false,
      reasons: [...reasons],
      unknown_tables: [...new Set(unknown)].sort(),
      missing_required_tables: missing,
    };
  const excluded = tables.filter((table) => has(BACKUP_EXCLUDED_TABLES, table));
  return {
    ok: true,
    excluded_tables: [...excluded].sort(),
    included_tables: tables
      .filter((table) => !has(BACKUP_EXCLUDED_TABLES, table))
      .sort(),
    excluded_blob_owner_tables: [...excluded].sort(),
  };
}

// --- 封筒の意味の検査 ---

export const BACKUP_KEY_PURPOSES = [
  'backup_file',
  'data_key',
  'ledger_hmac_key',
] as const;
export type BackupKeyPurpose = (typeof BACKUP_KEY_PURPOSES)[number];

export const BACKUP_EXCLUDED_DATA = [
  'raw_audio',
  'private_conversation',
  'oauth_tokens',
  'api_keys',
] as const;

export interface BackupKeyWrapLike {
  readonly purpose: string;
  readonly key_id: string;
  readonly recovery_key_id: string;
  readonly kdf: { readonly algorithm: string; readonly salt: string };
  readonly cipher: string;
  readonly nonce: string;
  readonly wrapped_material: string;
  readonly tag: string;
}

export interface BackupManifestLike {
  readonly schema: string;
  readonly backup_id: string;
  readonly created_at: string;
  readonly store_generation: string;
  readonly db_schema_version: number;
  readonly forgetting_generation: string;
  readonly ledger_id: string;
  readonly ledger_head_hash: string;
  readonly included_storage_modes: readonly string[];
  readonly excluded_data: readonly string[];
  readonly excluded_tables: readonly string[];
  readonly payload: { readonly bytes: number; readonly sha256: string };
  readonly key_wraps: readonly BackupKeyWrapLike[];
}

const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SALT = /^[A-Za-z0-9+/]{22}==$/u;
const NONCE = /^[A-Za-z0-9+/]{16}$/u;
const MATERIAL = /^[A-Za-z0-9+/]{43}=$/u;
const TAG = /^[A-Za-z0-9+/]{22}==$/u;

export type KeyWrapProblem =
  | 'key_wrap_count'
  | 'key_wrap_missing'
  | 'key_wrap_duplicated'
  | 'key_wrap_unknown_purpose'
  | 'recovery_key_mismatch'
  | 'key_wrap_malformed'
  | 'key_id_reused';

// 3 つの鍵の包み（本体・DB の暗号文・台帳の HMAC）が 1 つずつ、同じ復旧キーで包まれているか（ADR 0040）。
// 一部が欠けた封筒・同じ用途が 2 つある封筒（取り違え）・別の復旧キーで包んだ封筒を拒否する。
export function keyWrapProblems(
  wraps: readonly BackupKeyWrapLike[],
): KeyWrapProblem[] {
  const problems = new Set<KeyWrapProblem>();
  if (wraps.length !== BACKUP_KEY_PURPOSES.length)
    problems.add('key_wrap_count');
  for (const purpose of BACKUP_KEY_PURPOSES) {
    const count = wraps.filter((wrap) => wrap.purpose === purpose).length;
    if (count === 0) problems.add('key_wrap_missing');
    if (count > 1) problems.add('key_wrap_duplicated');
  }
  if (
    wraps.some(
      (wrap) =>
        !(BACKUP_KEY_PURPOSES as readonly string[]).includes(wrap.purpose),
    )
  )
    problems.add('key_wrap_unknown_purpose');
  if (new Set(wraps.map((wrap) => wrap.recovery_key_id)).size > 1)
    problems.add('recovery_key_mismatch');
  // 3 つの鍵の ID は互いに違う（用途をまたいで同じ ID だと、KeyStore で別の用途の鍵を上書き・削除し得る。Sonnet の P2-3）。
  if (new Set(wraps.map((wrap) => wrap.key_id)).size !== wraps.length)
    problems.add('key_id_reused');
  for (const wrap of wraps)
    if (
      !KEY_ID.test(wrap.key_id) ||
      !UUID_V4.test(wrap.recovery_key_id) ||
      wrap.kdf.algorithm !== 'hkdf-sha256' ||
      !SALT.test(wrap.kdf.salt) ||
      wrap.cipher !== 'aes-256-gcm' ||
      !NONCE.test(wrap.nonce) ||
      !MATERIAL.test(wrap.wrapped_material) ||
      !TAG.test(wrap.tag)
    )
      problems.add('key_wrap_malformed');
  return [...problems];
}

// 用途の包みを 1 つ取り出す。ちょうど 1 つでなければ null（取り違えを推測で選ばない）。
export function keyWrapFor(
  wraps: readonly BackupKeyWrapLike[],
  purpose: BackupKeyPurpose,
): BackupKeyWrapLike | null {
  const found = wraps.filter((wrap) => wrap.purpose === purpose);
  return found.length === 1 ? (found[0] ?? null) : null;
}

export type BackupManifestProblem =
  | KeyWrapProblem
  | 'schema_mismatch'
  | 'backup_id_invalid'
  | 'created_at_invalid'
  | 'store_generation_invalid'
  | 'db_schema_version_invalid'
  | 'forgetting_generation_invalid'
  | 'ledger_id_invalid'
  | 'ledger_head_hash_invalid'
  | 'genesis_ledger_hash_mismatch'
  | 'private_included'
  | 'storage_mode_unknown'
  | 'excluded_data_missing'
  | 'required_table_excluded'
  | 'payload_invalid'
  | 'excluded_table_unknown'
  | 'excluded_tables_duplicate'
  | 'excluded_tables_unsorted';

// 封筒の意味の検査（Schema の検査の後に Core が呼ぶ。読めない値は不正として扱う）。1 つでもあれば復元の段階 1 は
// manifest_invalid で止める。
export function backupManifestProblems(
  manifest: BackupManifestLike,
): BackupManifestProblem[] {
  const problems = new Set<BackupManifestProblem>();
  if (manifest.schema !== 'buddy.backup-manifest.v1')
    problems.add('schema_mismatch');
  if (!UUID_V4.test(manifest.backup_id)) problems.add('backup_id_invalid');
  if (parseBackupTime(manifest.created_at) === null)
    problems.add('created_at_invalid');
  if (!UUID_V4.test(manifest.store_generation))
    problems.add('store_generation_invalid');
  if (
    !Number.isSafeInteger(manifest.db_schema_version) ||
    manifest.db_schema_version < 1
  )
    problems.add('db_schema_version_invalid');
  if (!isBackupGeneration(manifest.forgetting_generation))
    problems.add('forgetting_generation_invalid');
  if (!UUID_V4.test(manifest.ledger_id)) problems.add('ledger_id_invalid');
  if (!HASH.test(manifest.ledger_head_hash))
    problems.add('ledger_head_hash_invalid');
  else if (
    (manifest.forgetting_generation === '0') !==
    (manifest.ledger_head_hash === BACKUP_ZERO_HASH)
  )
    problems.add('genesis_ledger_hash_mismatch');
  if (manifest.included_storage_modes.includes('private'))
    problems.add('private_included');
  if (
    manifest.included_storage_modes.length === 0 ||
    manifest.included_storage_modes.some(
      (mode) => mode !== 'normal' && mode !== 'extended' && mode !== 'private',
    )
  )
    problems.add('storage_mode_unknown');
  if (
    BACKUP_EXCLUDED_DATA.some((item) => !manifest.excluded_data.includes(item))
  )
    problems.add('excluded_data_missing');
  if (
    manifest.excluded_tables.some((table) =>
      BACKUP_REQUIRED_TABLES.includes(table),
    )
  )
    problems.add('required_table_excluded');
  // 除外できるのは短命の運用データの表だけ（業務の表・予算・台帳を黙って抜いた封筒を拒否する。Sonnet の P2-6）。
  if (
    manifest.excluded_tables.some(
      (table) =>
        !BACKUP_REQUIRED_TABLES.includes(table) &&
        !has(BACKUP_EXCLUDED_TABLES, table),
    )
  )
    problems.add('excluded_table_unknown');
  if (
    new Set(manifest.excluded_tables).size !== manifest.excluded_tables.length
  )
    problems.add('excluded_tables_duplicate');
  if (
    manifest.excluded_tables.some(
      (table, index) =>
        index > 0 && (manifest.excluded_tables[index - 1] ?? '') >= table,
    ) &&
    new Set(manifest.excluded_tables).size === manifest.excluded_tables.length
  )
    problems.add('excluded_tables_unsorted');
  if (
    !Number.isSafeInteger(manifest.payload.bytes) ||
    manifest.payload.bytes < 1 ||
    !HASH.test(manifest.payload.sha256)
  )
    problems.add('payload_invalid');
  for (const problem of keyWrapProblems(manifest.key_wraps))
    problems.add(problem);
  return [...problems];
}

// --- 封筒を作る前の検査（鍵がバックアップの中身を覆っているか） ---

export interface BackupKeyCoverageInput {
  readonly key_wraps: readonly BackupKeyWrapLike[];
  // DB の暗号文（sealed_blobs）が使っている鍵の ID の一覧（Core が DISTINCT key_id で読む）。
  readonly db_blob_key_ids: readonly string[];
  // 台帳の HMAC の鍵として DB に記録した鍵の ID（schema_meta。台帳と記憶の HMAC を計算した鍵。null は未記録）。
  readonly recorded_ledger_key_id: string | null;
  readonly forgetting_generation: string;
}

export type BackupKeyCoverageProblem =
  | KeyWrapProblem
  | 'data_key_not_covering_db'
  | 'ledger_key_unrecorded'
  | 'ledger_key_not_covered';

// 封筒の包みで、写しの暗号文と台帳の HMAC を復元できるか。包みは 1 用途に 1 つだけなので、暗号文が 2 つ以上の
// データ鍵を使っている DB（入れ替えの途中など）は、そのままでは実機を失った後に読めない。そのときは取らずに知らせる
// （CLI で包み直してから取る）。台帳の鍵が記録と違う包みも取らない（復元しても再取り込みを止められない）。
export function backupKeyCoverageProblems(
  input: BackupKeyCoverageInput,
): BackupKeyCoverageProblem[] {
  const problems = new Set<BackupKeyCoverageProblem>(
    keyWrapProblems(input.key_wraps),
  );
  const data = keyWrapFor(input.key_wraps, 'data_key');
  if (
    data === null ||
    input.db_blob_key_ids.some((keyId) => keyId !== data.key_id)
  )
    problems.add('data_key_not_covering_db');
  const ledger = keyWrapFor(input.key_wraps, 'ledger_hmac_key');
  if (input.recorded_ledger_key_id === null) {
    // 台帳が空で、まだ鍵を記録していない中枢（設定の直後）だけは通す。
    if (input.forgetting_generation !== '0')
      problems.add('ledger_key_unrecorded');
  } else if (ledger === null || ledger.key_id !== input.recorded_ledger_key_id)
    problems.add('ledger_key_not_covered');
  return [...problems];
}

// --- 古いバックアップの置き換えと削除（U74） ---

export interface StoredBackupEntry {
  readonly backup_id: string;
  readonly created_at: string;
  readonly ledger_id: string;
  readonly forgetting_generation: string;
  // 封筒の Schema と backupManifestProblems を通ったか。
  readonly manifest_valid: boolean;
  // ファイルの更新時刻（Core がファイルシステムから読む。封筒の作成時刻が読めない・信じられないときの期限の起点）。
  readonly file_modified_at?: string | null;
}

export interface BackupRetentionInput {
  readonly now: string;
  readonly last_checked_at: string | null;
  readonly keep_generations: number;
  // 中枢の今の台帳（null は確認できない。忘却の世代による置き換えは判定しない）。
  readonly ledger: {
    readonly ledger_id: string;
    readonly forgetting_generation: string;
  } | null;
  readonly backups: readonly StoredBackupEntry[];
}

// 台帳より新しい世代の封筒（台帳の巻き戻りの証拠になり得る）を残す上限。通常の期限（世代の数 × 1 日）とは別に、
// 設定の上限（30 世代）と同じ 30 日まで残し、その間は本人に知らせる（U74）。
export const BACKUP_GENERATION_AHEAD_MAX_DAYS = 30;

export type BackupRetentionDelete =
  // 期限（世代の数 × 1 日。台帳より新しい世代は 30 日）を過ぎた。止まっていても延ばさない。
  | 'expired'
  // 新しい方から keep_generations 個の外。
  | 'beyond_generations'
  // 忘却の世代が今の台帳より古く、今の世代のバックアップができている（置き換え済み）。
  | 'forgetting_superseded';

export type BackupRetentionHold =
  | 'manifest_unreadable'
  | 'foreign_lineage'
  | 'created_in_future'
  | 'generation_ahead_of_ledger'
  // 封筒の作成時刻もファイルの更新時刻も読めず、期限を判定できない（消さずに本人に知らせる）。
  | 'age_unknown'
  // 忘却の世代が古いが、置き換えるバックアップがまだない（新しいバックアップを取ってから消す。ADR 0040）。
  | 'awaiting_replacement'
  // 期限を過ぎたが、成功した最新のバックアップなので 1 つだけ残す（司令塔の判断。U74。失敗が続いても手元を 0 にしない）。
  | 'last_backup_kept';

export interface BackupRetentionDecision {
  readonly backup_id: string;
  readonly action: 'keep' | 'delete';
  readonly reasons: readonly (BackupRetentionDelete | BackupRetentionHold)[];
}

// 本人への知らせ（ID と理由だけ）。RetentionNotice（キャンバス向け。対象は発言・元情報・記憶・要約）には
// バックアップの種類がないので、運び方は U40（UI-05）・B06-08 で決める。
export interface BackupRetentionNotice {
  readonly backup_id: string;
  readonly reason:
    'generation_ahead_of_ledger' | 'age_unknown' | 'last_backup_kept';
}

export type BackupRetentionPlan =
  | {
      readonly ok: true;
      readonly clock_state: 'ok' | 'regressed';
      readonly effective_now: string;
      readonly decisions: readonly BackupRetentionDecision[];
      // 今の忘却の世代のバックアップがない（置き換えを待つ封筒がある、または 1 つもない）、または期限を過ぎた最新の 1 つだけが残る。
      readonly needs_new_backup: boolean;
      // 残る、復元に使えるバックアップの数。
      readonly restorable_count: number;
      readonly forgetting_checked: boolean;
      readonly notices: readonly BackupRetentionNotice[];
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid_now'
        | 'invalid_last_checked_at'
        | 'keep_generations_invalid'
        | 'ledger_invalid'
        | 'duplicate_backup_id';
    };

// アプリが管理する古いバックアップにも、期限と忘却を当てる（03「アプリ管理下の古いバックアップにも忘却・期限を適用し、
// 必要に応じて置換または削除」）。期限は世代の数 × 1 日（1 日 1 回の設計なので、初期 7 世代は 7 日）。時計が戻ったときは
// 最終確認時刻で判定する（延ばさない。ADR 0043 の U54 と同じく消し続ける）。ただし期限内の封筒が 1 つもなくなるときは、
// 成功した最新の 1 つを残す（司令塔の判断。U74）。残した封筒にも、復元の段階 2・3 で期限と忘却を当てる。
// 復元に使えない封筒（読めない・別の系譜・今より先の作成・台帳より新しい世代）も期限で消す（Sonnet の P2-4）。起点は
// 封筒の作成時刻とファイルの更新時刻の早い方（読める方）。台帳より新しい世代だけは 30 日まで残して知らせる。
export function backupRetentionPlan(
  input: BackupRetentionInput,
): BackupRetentionPlan {
  const clock = checkClock(input.now, input.last_checked_at);
  if (!clock.ok) return { ok: false, reason: clock.reason };
  if (
    !Number.isSafeInteger(input.keep_generations) ||
    input.keep_generations < 1 ||
    input.keep_generations > 30
  )
    return { ok: false, reason: 'keep_generations_invalid' };
  const ledger = input.ledger;
  if (
    ledger !== null &&
    (!UUID_V4.test(ledger.ledger_id) ||
      !isBackupGeneration(ledger.forgetting_generation))
  )
    return { ok: false, reason: 'ledger_invalid' };
  // 同じ ID の封筒が 2 つあると、どちらを消すかを決められない（取り違えを推測で選ばない）。
  if (
    new Set(input.backups.map((entry) => entry.backup_id)).size !==
    input.backups.length
  )
    return { ok: false, reason: 'duplicate_backup_id' };
  const now = parseBackupTime(clock.effective_now) ?? 0;
  const ledgerGeneration =
    ledger === null ? null : BigInt(ledger.forgetting_generation);

  const decided = new Map<string, BackupRetentionDecision>();
  const notices = new Map<string, BackupRetentionNotice>();
  const candidates: {
    entry: StoredBackupEntry;
    created: number;
    generation: bigint;
  }[] = [];
  for (const entry of input.backups) {
    const created = parseBackupTime(entry.created_at);
    const id = entry.backup_id;
    const hold = (kind: BackupRetentionHold): void => {
      const modified =
        entry.file_modified_at === undefined || entry.file_modified_at === null
          ? null
          : parseBackupTime(entry.file_modified_at);
      const anchors = [created, modified].filter(
        (value): value is number => value !== null,
      );
      if (anchors.length === 0) {
        decided.set(id, {
          backup_id: id,
          action: 'keep',
          reasons: [kind, 'age_unknown'],
        });
        notices.set(id, { backup_id: id, reason: 'age_unknown' });
        return;
      }
      const days =
        kind === 'generation_ahead_of_ledger'
          ? BACKUP_GENERATION_AHEAD_MAX_DAYS
          : input.keep_generations;
      if (Math.min(...anchors) + days * DAY_MS <= now) {
        decided.set(id, {
          backup_id: id,
          action: 'delete',
          reasons: ['expired', kind],
        });
        return;
      }
      decided.set(id, { backup_id: id, action: 'keep', reasons: [kind] });
      if (kind === 'generation_ahead_of_ledger')
        notices.set(id, { backup_id: id, reason: kind });
    };
    if (
      !entry.manifest_valid ||
      created === null ||
      !isBackupGeneration(entry.forgetting_generation) ||
      !UUID_V4.test(entry.ledger_id)
    )
      hold('manifest_unreadable');
    else if (ledger !== null && entry.ledger_id !== ledger.ledger_id)
      hold('foreign_lineage');
    else if (created > now) hold('created_in_future');
    else if (
      ledgerGeneration !== null &&
      BigInt(entry.forgetting_generation) > ledgerGeneration
    )
      hold('generation_ahead_of_ledger');
    else
      candidates.push({
        entry,
        created,
        generation: BigInt(entry.forgetting_generation),
      });
  }

  // 新しい順（同時刻は backup_id の大きい方を新しいとする。決まった順序にするためだけ）。
  candidates.sort((a, b) =>
    a.created !== b.created
      ? b.created - a.created
      : a.entry.backup_id < b.entry.backup_id
        ? 1
        : -1,
  );
  const alive = candidates.filter((candidate) => {
    if (candidate.created + input.keep_generations * DAY_MS <= now) {
      decided.set(candidate.entry.backup_id, {
        backup_id: candidate.entry.backup_id,
        action: 'delete',
        reasons: ['expired'],
      });
      return false;
    }
    return true;
  });
  // 期限内の封筒が 1 つもなければ、成功した最新の 1 つ（並べた先頭）を残す。
  const lastKept = alive.length === 0 ? (candidates[0] ?? null) : null;
  if (lastKept !== null) alive.push(lastKept);
  const kept = alive.slice(0, input.keep_generations);
  for (const candidate of alive.slice(input.keep_generations))
    decided.set(candidate.entry.backup_id, {
      backup_id: candidate.entry.backup_id,
      action: 'delete',
      reasons: ['beyond_generations'],
    });
  const hasCurrent =
    ledgerGeneration !== null &&
    kept.some((candidate) => candidate.generation === ledgerGeneration);
  let restorable = 0;
  let awaiting = false;
  for (const candidate of kept) {
    const id = candidate.entry.backup_id;
    if (candidate === lastKept) {
      const stale =
        ledgerGeneration !== null && candidate.generation < ledgerGeneration;
      if (stale) awaiting = true;
      decided.set(id, {
        backup_id: id,
        action: 'keep',
        reasons: stale
          ? ['last_backup_kept', 'awaiting_replacement']
          : ['last_backup_kept'],
      });
      // 期限を過ぎた封筒が残っていることを知らせる（Sonnet の P3-8）。
      notices.set(id, { backup_id: id, reason: 'last_backup_kept' });
      restorable += 1;
      continue;
    }
    if (ledgerGeneration !== null && candidate.generation < ledgerGeneration) {
      if (hasCurrent) {
        decided.set(id, {
          backup_id: id,
          action: 'delete',
          reasons: ['forgetting_superseded'],
        });
        continue;
      }
      awaiting = true;
      decided.set(id, {
        backup_id: id,
        action: 'keep',
        reasons: ['awaiting_replacement'],
      });
      restorable += 1;
      continue;
    }
    decided.set(id, { backup_id: id, action: 'keep', reasons: [] });
    restorable += 1;
  }
  return {
    ok: true,
    clock_state: clock.state,
    effective_now: clock.effective_now,
    decisions: input.backups.map(
      (entry) =>
        decided.get(entry.backup_id) ?? {
          backup_id: entry.backup_id,
          action: 'keep',
          reasons: ['manifest_unreadable'],
        },
    ),
    needs_new_backup:
      lastKept !== null ||
      (ledgerGeneration !== null && (awaiting || !hasCurrent)),
    restorable_count: restorable,
    forgetting_checked: ledgerGeneration !== null,
    // 入力の順に並べる。
    notices: input.backups.flatMap((entry) => {
      const notice = notices.get(entry.backup_id);
      return notice === undefined ? [] : [notice];
    }),
  };
}
