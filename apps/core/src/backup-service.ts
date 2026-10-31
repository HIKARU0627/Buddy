// バックアップの作成と古い封筒の掃除（設計 03 バックアップ・復元、ADR 0040・0047・0055、B06-08）。
//
// 作成: 設定（置き場所）→ 置き場所の検査 → 鍵の包みの記録（CLI の設定が書く）→ バックアップ本体の鍵 → SQLite のスナップショット
// （含めない表と暗号文を除く）→ 鍵が中身を覆うか → 封筒を作って本体を暗号化 → 置き場所へ原子的に書く。
// 掃除: 置き場所の封筒を読み、domain の backupRetentionPlan（世代の数 × 1 日の期限・世代の数・忘却の置き換え・成功した最新の
// 1 つは残す）で消す。作成の成否によらず毎回行う（失敗が続いても期限を延ばさない）。時計が戻ったときは最終確認時刻で判定する。
// 生音声・記録しない会話・OAuth トークン・API キーは、DB の表にもこの封筒にも入らない。
// 結果・ログには ID・件数・理由コードだけを入れ、鍵・パス・本文を入れない。

import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BACKUP_EXCLUDED_DATA,
  backupKeyCoverageProblems,
  backupManifestProblems,
  backupRetentionPlan,
  keyWrapFor,
} from '@buddy/domain';
import type { BackupRetentionPlan, StoredBackupEntry } from '@buddy/domain';
import type { BackupKeyStore } from '@buddy/platform';
import {
  decryptBackupPayload,
  encodeBackupFile,
  encryptBackupPayload,
  listBackupFiles,
  manifestPayloadKey,
  readBackupFileHeader,
  readBackupPayload,
  sha256Hex,
  takeBackupSnapshot,
  verifyBackupPayload,
  writeBackupFileAtomic,
} from '@buddy/storage';
import type {
  BackupFacts,
  MemoryOp,
  MemoryOpKind,
  MemoryOpOutcome,
} from '@buddy/storage';
import { readFile } from 'node:fs/promises';
import type { ApiContract } from './api-contract.js';
import {
  BACKUP_CONFIG_FILE,
  checkBackupLocation,
  loadBackupConfig,
} from './backup-config.js';
import type { BackupLocationCheckValue } from './backup-config.js';
import {
  readBackupKeyFile,
  readBackupState,
  writeBackupState,
} from './backup-files.js';
import type { BackupStateValue } from './backup-files.js';
import { DB_FILE } from './paths.js';

export const BACKUP_WORK_DIR = 'backup-work';
// 1 日 1 回（03）。
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface BackupStore {
  memory<K extends MemoryOpKind>(
    op: Extract<MemoryOp, { kind: K }>,
  ): Promise<MemoryOpOutcome<K>>;
}

export interface BackupServiceOptions {
  readonly dataDir: string;
  readonly contract: ApiContract;
  readonly store: BackupStore;
  readonly backupKeys: BackupKeyStore;
  readonly now: () => Date;
  readonly log: (message: string) => void;
  readonly platform?: NodeJS.Platform;
  // 試験用: 封筒を書く直前に呼ぶ（書く前の停止の再現）。
  readonly beforeWrite?: () => void;
}

export interface SweepDecisionSummary {
  readonly backup_id: string;
  readonly action: 'keep' | 'delete';
  readonly reasons: readonly string[];
}

export type SweepResult =
  | {
      readonly ok: true;
      readonly clock_state: 'ok' | 'regressed';
      readonly decisions: readonly SweepDecisionSummary[];
      readonly deleted: readonly string[];
      readonly delete_failed: readonly string[];
      readonly needs_new_backup: boolean;
      readonly restorable_count: number;
      readonly forgetting_checked: boolean;
      readonly notices: readonly { backup_id: string; reason: string }[];
      readonly removed_temp_files: number;
    }
  | { readonly ok: false; readonly reasons: readonly string[] };

export type BackupRunResult =
  | {
      readonly ok: true;
      readonly backup_id: string;
      readonly created_at: string;
      readonly store_generation: string;
      readonly forgetting_generation: string;
      readonly bytes: number;
      readonly excluded_tables: number;
      readonly sync_folder_warning: boolean;
      readonly sweep: SweepResult;
    }
  | {
      readonly ok: false;
      readonly reasons: readonly string[];
      readonly sweep: SweepResult | null;
    };

export interface BackupStatus {
  readonly configured: boolean;
  readonly config_reasons: readonly string[];
  readonly location: BackupLocationCheckValue | null;
  readonly keys_ready: boolean;
  readonly recovery_key_state: 'not_set_up' | 'not_shown' | 'shown';
  readonly last_success: BackupStateValue['last_success'];
  readonly last_checked_at: string | null;
  readonly needs_new_backup: boolean;
  readonly state_valid: boolean;
}

const sortKeys = <T extends { backup_id: string }>(a: T, b: T): number =>
  a.backup_id < b.backup_id ? -1 : a.backup_id > b.backup_id ? 1 : 0;

export interface BackupService {
  status(): Promise<BackupStatus>;
  run(): Promise<BackupRunResult>;
  sweep(): Promise<SweepResult>;
  // 次のバックアップの予定（1 日 1 回、または忘却の置き換えを待つとき）を過ぎているか。設定がなければ false。
  due(): Promise<boolean>;
}

export function createBackupService(
  options: BackupServiceOptions,
): BackupService {
  const { dataDir, contract, store, backupKeys, log } = options;
  const platform = options.platform ?? process.platform;
  const configPath = join(dataDir, BACKUP_CONFIG_FILE);
  const workDir = join(dataDir, BACKUP_WORK_DIR);
  // 1 度に 1 つだけ実行する（バックアップと掃除は互いに重ならない）。
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(body: () => Promise<T>): Promise<T> => {
    const next = chain.then(body, body);
    chain = next.catch(() => undefined);
    return next;
  };

  async function readFacts(): Promise<BackupFacts | null> {
    const facts = await store.memory({ kind: 'backup.facts' });
    return facts.ok ? facts.value : null;
  }

  type EnvelopeState = 'valid' | 'corrupt' | 'unverifiable';

  // 封筒と本体の組を確かめる。corrupt = 壊れていると分かった（本体の長さ・SHA-256 の不一致、鍵があるのに認証に失敗）、
  // unverifiable = 確かめる鍵が KeyStore にない（壊れているとも正しいとも言えない）。本体を読む間だけメモリに載せる。
  async function classifyEnvelope(
    path: string,
    header: Extract<
      Awaited<ReturnType<typeof readBackupFileHeader>>,
      { ok: true }
    >,
    manifest: Record<string, unknown> | null,
  ): Promise<EnvelopeState> {
    const payload = manifest?.['payload'] as
      { bytes: number; sha256: string } | undefined;
    if (manifest === null || payload === undefined) return 'corrupt';
    if (
      !(await verifyBackupPayload(
        path,
        header.payload_offset,
        payload.bytes,
        payload.sha256,
      ))
    )
      return 'corrupt';
    const keyInfo = manifestPayloadKey(manifest);
    if (keyInfo === null) return 'corrupt';
    const key = await backupKeys.read('backup_file', keyInfo.keyId);
    if (!key.ok) return 'unverifiable';
    const bytes = await readBackupPayload(
      path,
      header.payload_offset,
      payload.bytes,
    );
    if (bytes === null) return 'corrupt';
    const plain = decryptBackupPayload(
      { key: key.key.key, keyId: keyInfo.keyId, fields: keyInfo.fields },
      bytes,
    );
    if (plain === null) return 'corrupt';
    plain.fill(0);
    return 'valid';
  }

  async function loadConfig() {
    return loadBackupConfig({ path: configPath, contract, platform });
  }

  async function status(): Promise<BackupStatus> {
    const config = await loadConfig();
    const location = config.ok
      ? await checkBackupLocation(config.config.directory, dataDir)
      : null;
    const keyFile = await readBackupKeyFile(dataDir, contract);
    const state = await readBackupState(dataDir);
    let keysReady = false;
    if (keyFile.ok) {
      const wrap = keyWrapFor(keyFile.value.key_wraps, 'backup_file');
      const ledger = keyWrapFor(keyFile.value.key_wraps, 'ledger_hmac_key');
      if (wrap !== null && ledger !== null) {
        const [file, hmac] = await Promise.all([
          backupKeys.read('backup_file', wrap.key_id),
          backupKeys.read('ledger_hmac_key', ledger.key_id),
        ]);
        keysReady = file.ok && hmac.ok;
      }
    }
    const value = state.ok ? state.value : null;
    return {
      configured: config.ok,
      config_reasons: config.ok ? [] : config.reasons,
      location,
      keys_ready: keysReady,
      recovery_key_state: keyFile.ok
        ? keyFile.value.recovery_key.state
        : 'not_set_up',
      last_success: value?.last_success ?? null,
      last_checked_at: value?.last_checked_at ?? null,
      needs_new_backup: value?.needs_new_backup ?? false,
      state_valid: state.ok,
    };
  }

  // --- 掃除 ---

  async function sweepNow(): Promise<SweepResult> {
    const config = await loadConfig();
    if (!config.ok) return { ok: false, reasons: config.reasons };
    const location = await checkBackupLocation(
      config.config.directory,
      dataDir,
    );
    if (!location.usable)
      return {
        ok: false,
        reasons: location.problems.map((problem) => `location_${problem}`),
      };
    const stateRead = await readBackupState(dataDir);
    // 時計の最終確認を失った（状態ファイルが壊れている）ときは、期限を判定できないので何も消さない。
    if (!stateRead.ok) return { ok: false, reasons: ['state_invalid'] };
    const state = stateRead.value;
    const nowIso = options.now().toISOString();
    const listing = await listBackupFiles(config.config.directory);
    // 取り残された一時ファイル（書きかけの封筒）は封筒ではない。run と sweep は同時に動かないので、いま書いている最中のものはない。
    let removedTemps = 0;
    for (const temp of listing.temps) {
      await rm(temp, { force: true }).then(
        () => {
          removedTemps += 1;
        },
        () => undefined,
      );
    }
    const firstSeen: Record<string, string> = {};
    const entries: StoredBackupEntry[] = [];
    const unverifiable = new Set<string>();
    for (const file of listing.files) {
      const seen = state.first_seen[file.backup_id] ?? nowIso;
      firstSeen[file.backup_id] = seen;
      const info = await stat(file.path).catch(() => null);
      const header = await readBackupFileHeader(file.path);
      const manifest =
        header.ok &&
        typeof header.manifest === 'object' &&
        header.manifest !== null
          ? (header.manifest as Record<string, unknown>)
          : null;
      const headerValid =
        manifest !== null &&
        contract.valid('BackupManifest', manifest) &&
        backupManifestProblems(
          manifest as unknown as Parameters<typeof backupManifestProblems>[0],
        ).length === 0 &&
        manifest['backup_id'] === file.backup_id;
      // 古い世代を消す根拠になる封筒は、本体まで確かめる: ファイルの大きさと本体の SHA-256 が封筒と一致し、さらに KeyStore の
      // backup_file の鍵で封筒と本体の組を AES-GCM で認証できること（平文の封筒の欄だけが壊れた封筒は、Schema・長さ・SHA-256 を
      // 通っても認証に失敗する。PR #175 の P1）。壊れていると分かった封筒は manifest_unreadable と同じく復元できる世代に数えず、
      // 期限だけを当てる。鍵が KeyStore になく認証できない封筒（検証不能）は、数えず、他の世代を消す根拠にもせず、期限でも消さない。
      const state_ =
        header.ok && headerValid
          ? await classifyEnvelope(file.path, header, manifest)
          : ('corrupt' as const);
      if (state_ === 'unverifiable') unverifiable.add(file.backup_id);
      const valid = state_ === 'valid';
      const text = (key: string): string =>
        manifest !== null && typeof manifest[key] === 'string'
          ? (manifest[key] as string)
          : '';
      entries.push({
        backup_id: file.backup_id,
        created_at: text('created_at'),
        ledger_id: text('ledger_id'),
        forgetting_generation: text('forgetting_generation'),
        manifest_valid: valid,
        file_modified_at: info === null ? null : info.mtime.toISOString(),
        first_seen_at: seen,
      });
    }
    const facts = await readFacts();
    const ledger =
      facts !== null && facts.ledger_id !== null
        ? {
            ledger_id: facts.ledger_id,
            forgetting_generation: facts.forgetting_generation,
          }
        : null;
    const plan: BackupRetentionPlan = backupRetentionPlan({
      now: nowIso,
      last_checked_at: state.last_checked_at,
      keep_generations: config.config.keep_generations,
      ledger,
      backups: entries,
    });
    if (!plan.ok) return { ok: false, reasons: [plan.reason] };
    // 検証不能な封筒は消さない（期限を過ぎていても。鍵が KeyStore にないだけで、復旧キーがあれば開けるかもしれない）。
    const decisions = plan.decisions.map((decision) =>
      unverifiable.has(decision.backup_id)
        ? {
            backup_id: decision.backup_id,
            action: 'keep' as const,
            reasons: [
              ...decision.reasons.filter((reason) => reason !== 'expired'),
              'unverifiable',
            ] as readonly string[],
          }
        : {
            backup_id: decision.backup_id,
            action: decision.action,
            reasons: decision.reasons as readonly string[],
          },
    );
    const deleted: string[] = [];
    const deleteFailed: string[] = [];
    for (const [index, decision] of decisions.entries()) {
      if (decision.action !== 'delete') continue;
      const file = listing.files[index];
      if (file === undefined) continue;
      try {
        await rm(file.path);
        deleted.push(decision.backup_id);
        delete firstSeen[decision.backup_id];
      } catch {
        deleteFailed.push(decision.backup_id);
      }
    }
    // 次の判定の最終確認時刻は、時計が戻っていても進める側（effective_now）にする。
    await writeBackupState(dataDir, {
      ...state,
      last_checked_at: plan.effective_now,
      first_seen: firstSeen,
      needs_new_backup: plan.needs_new_backup,
    });
    return {
      ok: true,
      clock_state: plan.clock_state,
      decisions,
      deleted: deleted.sort(),
      delete_failed: deleteFailed.sort(),
      needs_new_backup: plan.needs_new_backup,
      restorable_count: plan.restorable_count,
      forgetting_checked: plan.forgetting_checked,
      notices: [
        ...plan.notices.map((notice) => ({ ...notice })),
        ...[...unverifiable].map((id) => ({
          backup_id: id,
          reason: 'unverifiable',
        })),
      ].sort(sortKeys),
      removed_temp_files: removedTemps,
    };
  }

  // --- 作成 ---

  async function createBackup(): Promise<
    | {
        readonly ok: true;
        readonly result: Omit<Extract<BackupRunResult, { ok: true }>, 'sweep'>;
      }
    | { readonly ok: false; readonly reasons: readonly string[] }
  > {
    const config = await loadConfig();
    if (!config.ok) return { ok: false, reasons: config.reasons };
    const location = await checkBackupLocation(
      config.config.directory,
      dataDir,
    );
    if (!location.usable)
      return {
        ok: false,
        reasons: location.problems.map((problem) => `location_${problem}`),
      };
    const keyFile = await readBackupKeyFile(dataDir, contract);
    if (!keyFile.ok)
      return {
        ok: false,
        reasons: [
          keyFile.reason === 'missing'
            ? 'backup_not_set_up'
            : 'backup_keys_invalid',
        ],
      };
    // 復旧キーを本人へ見せ終えるまでは取らない（見ていないキーで包んだバックアップは、実機を失うと開けない）。
    if (keyFile.value.recovery_key.state !== 'shown')
      return { ok: false, reasons: ['recovery_key_not_shown'] };
    const wrap = keyWrapFor(keyFile.value.key_wraps, 'backup_file');
    if (wrap === null) return { ok: false, reasons: ['backup_keys_invalid'] };
    const key = await backupKeys.read('backup_file', wrap.key_id);
    if (!key.ok) return { ok: false, reasons: [`backup_key_${key.reason}`] };
    const stateRead = await readBackupState(dataDir);
    if (!stateRead.ok) return { ok: false, reasons: ['state_invalid'] };
    const snapshot = await takeBackupSnapshot({
      sourcePath: join(dataDir, DB_FILE),
      workDir,
    });
    if (!snapshot.ok) return { ok: false, reasons: snapshot.reasons };
    try {
      const facts = snapshot.facts;
      if (facts.store_generation === null || facts.ledger_id === null)
        return {
          ok: false,
          reasons: [
            facts.ledger_id === null
              ? 'ledger_lineage_missing'
              : 'store_generation_missing',
          ],
        };
      const coverage = backupKeyCoverageProblems({
        key_wraps: keyFile.value.key_wraps,
        db_blob_key_ids: facts.db_blob_key_ids,
        recorded_ledger_key_id: facts.recorded_ledger_key_id,
        forgetting_generation: facts.forgetting_generation,
      });
      if (coverage.length > 0) return { ok: false, reasons: coverage };
      const plaintext = await readFile(snapshot.path);
      const backupId = randomUUID();
      const createdAt = options.now().toISOString();
      // 封筒の平文の欄（payload を除く）を先に決め、その全体の SHA-256 を本体の AAD に入れて暗号化する。本体の長さと
      // SHA-256 は、暗号化した後に payload として足す。
      const envelope = {
        schema: 'buddy.backup-manifest.v1' as const,
        backup_id: backupId,
        created_at: createdAt,
        store_generation: facts.store_generation,
        db_schema_version: facts.db_schema_version,
        forgetting_generation: facts.forgetting_generation,
        ledger_id: facts.ledger_id,
        ledger_head_hash: facts.ledger_head_hash,
        included_storage_modes: ['normal', 'extended'] as const,
        excluded_data: [...BACKUP_EXCLUDED_DATA],
        excluded_tables: [...snapshot.excluded_tables],
        key_wraps: keyFile.value.key_wraps,
      };
      const keyInfo = manifestPayloadKey(envelope);
      if (keyInfo === null)
        return { ok: false, reasons: ['backup_keys_invalid'] };
      const payload = encryptBackupPayload(
        { key: key.key.key, keyId: keyInfo.keyId, fields: keyInfo.fields },
        plaintext,
      );
      const manifest = {
        ...envelope,
        payload: { bytes: payload.length, sha256: sha256Hex(payload) },
      };
      // 書く前に、封筒を契約と domain の意味検査に通す（通らない封筒を置き場所へ出さない）。
      const problems = backupManifestProblems(manifest);
      if (problems.length > 0 || !contract.valid('BackupManifest', manifest))
        return {
          ok: false,
          reasons: problems.length > 0 ? problems : ['manifest_schema_invalid'],
        };
      options.beforeWrite?.();
      await writeBackupFileAtomic(
        config.config.directory,
        backupId,
        encodeBackupFile(manifest, payload),
      );
      const state = stateRead.value;
      await writeBackupState(dataDir, {
        ...state,
        first_seen: { ...state.first_seen, [backupId]: createdAt },
        last_success: {
          backup_id: backupId,
          created_at: createdAt,
          forgetting_generation: facts.forgetting_generation,
        },
        needs_new_backup: false,
      });
      return {
        ok: true,
        result: {
          ok: true,
          backup_id: backupId,
          created_at: createdAt,
          store_generation: facts.store_generation,
          forgetting_generation: facts.forgetting_generation,
          bytes: payload.length,
          excluded_tables: snapshot.excluded_tables.length,
          sync_folder_warning: location.warnings.length > 0,
        },
      };
    } catch (error) {
      log(`バックアップを書けませんでした（${(error as Error).name}）。`);
      return { ok: false, reasons: ['backup_write_failed'] };
    } finally {
      // 平文の写しは作業用のディレクトリに残さない。
      await rm(snapshot.path, { force: true }).catch(() => undefined);
    }
  }

  return {
    status,
    sweep: () => exclusive(sweepNow),
    run: () =>
      exclusive(async (): Promise<BackupRunResult> => {
        let created;
        try {
          created = await createBackup();
        } catch (error) {
          log(`バックアップに失敗しました（${(error as Error).name}）。`);
          created = {
            ok: false as const,
            reasons: ['backup_failed'] as readonly string[],
          };
        }
        // 作成の成否によらず掃除する（失敗が続いても期限を延ばさない）。
        let sweep: SweepResult;
        try {
          sweep = await sweepNow();
        } catch (error) {
          log(`バックアップの掃除に失敗しました（${(error as Error).name}）。`);
          sweep = { ok: false, reasons: ['sweep_failed'] };
        }
        if (!created.ok) return { ok: false, reasons: created.reasons, sweep };
        return { ...created.result, sweep: sweep };
      }),
    async due() {
      const config = await loadConfig();
      if (!config.ok) return false;
      const state = await readBackupState(dataDir);
      if (!state.ok) return false;
      const last = state.value.last_success;
      if (last === null || state.value.needs_new_backup) return true;
      // 最後の成功の後に忘れた（今の忘却の世代が、最後の成功の世代より進んだ）なら、24 時間を待たずに取り直す。
      // 忘れた内容を持つ古い封筒を次の日次の実行まで残さない（needs_new_backup は掃除でしか立たないので、定期の確認が
      // 今の世代を直接見る）。世代を読めない・形が違うときは、取り直す側（閉じた側）に倒す。
      const facts = await readFacts();
      if (
        facts === null ||
        !/^(0|[1-9][0-9]{0,15})$/u.test(facts.forgetting_generation) ||
        BigInt(facts.forgetting_generation) > BigInt(last.forgetting_generation)
      )
        return true;
      return (
        options.now().getTime() - Date.parse(last.created_at) >=
        BACKUP_INTERVAL_MS
      );
    },
  };
}

// 定期の実行（1 日 1 回、または忘却の置き換えを待つとき）。設定とキーがなければ何もしない。失敗しても 1 時間は取り直さない。
export interface BackupScheduler {
  stop(): void;
}

export interface BackupSchedulerOptions {
  readonly service: BackupService;
  readonly log: (message: string) => void;
  readonly now: () => Date;
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
  readonly checkIntervalMs?: number;
  readonly retryAfterFailureMs?: number;
}

export function startBackupScheduler(
  options: BackupSchedulerOptions,
): BackupScheduler {
  const checkMs = options.checkIntervalMs ?? 15 * 60 * 1000;
  const retryMs = options.retryAfterFailureMs ?? 60 * 60 * 1000;
  let stopped = false;
  let timer: unknown = null;
  let failedAt: number | null = null;
  const tick = async (): Promise<void> => {
    try {
      if (failedAt !== null && options.now().getTime() - failedAt < retryMs)
        return;
      if (!(await options.service.due())) return;
      const result = await options.service.run();
      if (result.ok) {
        failedAt = null;
        options.log(`バックアップを取りました（${result.backup_id}）。`);
      } else {
        failedAt = options.now().getTime();
        options.log(
          `バックアップを取れませんでした（${result.reasons.join(', ')}）。`,
        );
      }
    } catch (error) {
      failedAt = options.now().getTime();
      options.log(
        `バックアップの定期実行に失敗しました（${(error as Error).name}）。`,
      );
    }
  };
  const schedule = (): void => {
    if (stopped) return;
    timer = options.setTimer(() => {
      void tick().finally(schedule);
    }, checkMs);
  };
  schedule();
  return {
    stop() {
      stopped = true;
      if (timer !== null) options.clearTimer(timer);
    },
  };
}
