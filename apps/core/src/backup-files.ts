// バックアップの Core 内のファイル 2 つ（ADR 0055）。どちらも本文・秘密を持たない。
// - backup-keys.json: 復旧キーの記録（RecoveryKeyRecord。復旧キーそのものは持たない）と、復旧キーで包んだ 3 つの鍵
//   （BackupKeyWrap。毎回の封筒に同じ包みを写す）。CLI の設定（buddy-core backup setup）が書き、Core が読む。
// - backup-state.json: 期限の判定に使う最終確認時刻（時計の戻りで期限を延ばさない。ADR 0043 の U54 と同じ）、封筒を初めて
//   見た時刻（first_seen_at。今より先の時刻の封筒の期限の錨。ADR 0047 の P2-D）、最後に成功したバックアップ。
// どちらも厳格な JSON で読み、形が違えば使わない（壊れた状態ファイルで期限を延ばさない・包みを推測しない側へ倒す）。

import { keyWrapProblems, parseBackupTime } from '@buddy/domain';
import type { BackupKeyWrapValue } from '@buddy/storage';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiContract } from './api-contract.js';
import { writeFileAtomic } from './data-dir.js';
import {
  StrictJsonError,
  UUID_PATTERN,
  parseStrictJson,
} from './strict-json.js';

export const BACKUP_KEY_FILE = 'backup-keys.json';
export const BACKUP_STATE_FILE = 'backup-state.json';
const MAX_FILE_BYTES = 256 * 1024;

export interface RecoveryKeyRecordValue {
  readonly schema: 'buddy.recovery-key-record.v1';
  readonly recovery_key_id: string;
  readonly created_at: string;
  readonly check_value: string;
  readonly state: 'not_shown' | 'shown';
  readonly shown_at: string | null;
}

export interface BackupKeyFileValue {
  readonly schema: 'buddy.backup-keys.v1';
  readonly recovery_key: RecoveryKeyRecordValue;
  readonly key_wraps: readonly BackupKeyWrapValue[];
}

export type KeyFileRead =
  | { readonly ok: true; readonly value: BackupKeyFileValue }
  | { readonly ok: false; readonly reason: 'missing' | 'invalid' };

async function readText(path: string): Promise<string | 'missing' | 'invalid'> {
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_FILE_BYTES) return 'invalid';
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'missing'
      : 'invalid';
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(JSON.stringify(parseStrictJson(text, 8)));
  } catch (error) {
    if (error instanceof StrictJsonError) return null;
    return null;
  }
}

export function parseBackupKeyFile(
  text: string,
  contract: ApiContract,
): KeyFileRead {
  const value = parseJson(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, reason: 'invalid' };
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'key_wraps,recovery_key,schema' ||
    record['schema'] !== 'buddy.backup-keys.v1'
  )
    return { ok: false, reason: 'invalid' };
  const recovery = record['recovery_key'];
  const wraps = record['key_wraps'];
  if (!contract.valid('RecoveryKeyRecord', recovery))
    return { ok: false, reason: 'invalid' };
  if (
    !Array.isArray(wraps) ||
    wraps.length !== 3 ||
    !wraps.every((wrap) => contract.valid('BackupKeyWrap', wrap))
  )
    return { ok: false, reason: 'invalid' };
  const typedWraps = wraps as BackupKeyWrapValue[];
  const typedRecovery = recovery as RecoveryKeyRecordValue;
  // 3 つの鍵が用途ごとにちょうど 1 つ・同じ復旧キー・ID が互いに違うこと。記録の復旧キーの ID とも同じこと。
  if (
    keyWrapProblems(typedWraps).length > 0 ||
    typedWraps.some(
      (wrap) => wrap.recovery_key_id !== typedRecovery.recovery_key_id,
    )
  )
    return { ok: false, reason: 'invalid' };
  return {
    ok: true,
    value: {
      schema: 'buddy.backup-keys.v1',
      recovery_key: typedRecovery,
      key_wraps: typedWraps,
    },
  };
}

export async function readBackupKeyFile(
  dataDir: string,
  contract: ApiContract,
): Promise<KeyFileRead> {
  const text = await readText(join(dataDir, BACKUP_KEY_FILE));
  if (text === 'missing' || text === 'invalid')
    return { ok: false, reason: text };
  return parseBackupKeyFile(text, contract);
}

export async function writeBackupKeyFile(
  dataDir: string,
  value: BackupKeyFileValue,
): Promise<void> {
  await writeFileAtomic(
    dataDir,
    BACKUP_KEY_FILE,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

// --- 状態ファイル ---

export interface BackupStateValue {
  readonly schema: 'buddy.backup-state.v1';
  // 期限の判定の最終確認時刻（UTC）。まだ判定していなければ null。
  readonly last_checked_at: string | null;
  // 封筒を初めて一覧で見た時刻（backup_id → UTC）。ファイルがなくなった封筒の記録は消す。
  readonly first_seen: Readonly<Record<string, string>>;
  // 最後に成功したバックアップ（取った時点の忘却の世代）。まだなければ null。
  readonly last_success: {
    readonly backup_id: string;
    readonly created_at: string;
    readonly forgetting_generation: string;
  } | null;
  // 今の忘却の世代のバックアップがない、または期限を過ぎた最新の 1 つだけが残る（次の予定を待たずに取る）。
  readonly needs_new_backup: boolean;
  // 前の掃除で、消すと決めた封筒の削除に失敗したものが残っている（一時的な EBUSY・EACCES など）。次の日次を待たずに、
  // 新しい封筒は作らず掃除だけを再試行する（忘れた内容を持つ古い封筒を残さない。PR #175 の P2）。
  readonly sweep_incomplete: boolean;
}

export const EMPTY_BACKUP_STATE: BackupStateValue = {
  schema: 'buddy.backup-state.v1',
  last_checked_at: null,
  first_seen: {},
  last_success: null,
  needs_new_backup: false,
  sweep_incomplete: false,
};

const GENERATION = /^(0|[1-9][0-9]{0,15})$/u;

// domain の判定（UTC の RFC 3339、暦にある時刻）と同じ読み方。掃除の最終確認時刻は domain が .000Z を Z にして返す。
function isUtc(value: unknown): value is string {
  return parseBackupTime(value) !== null;
}

export function parseBackupState(text: string): BackupStateValue | null {
  const value = parseJson(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !==
      'first_seen,last_checked_at,last_success,needs_new_backup,schema,sweep_incomplete' ||
    record['schema'] !== 'buddy.backup-state.v1' ||
    typeof record['needs_new_backup'] !== 'boolean' ||
    typeof record['sweep_incomplete'] !== 'boolean'
  )
    return null;
  const checked = record['last_checked_at'];
  if (checked !== null && !isUtc(checked)) return null;
  const seen = record['first_seen'];
  if (seen === null || typeof seen !== 'object' || Array.isArray(seen))
    return null;
  const firstSeen: Record<string, string> = {};
  for (const [id, at] of Object.entries(seen)) {
    if (!UUID_PATTERN.test(id) || !isUtc(at)) return null;
    firstSeen[id] = at;
  }
  const success = record['last_success'];
  let lastSuccess: BackupStateValue['last_success'] = null;
  if (success !== null) {
    if (typeof success !== 'object' || Array.isArray(success)) return null;
    const entry = success as Record<string, unknown>;
    if (
      Object.keys(entry).sort().join(',') !==
        'backup_id,created_at,forgetting_generation' ||
      typeof entry['backup_id'] !== 'string' ||
      !UUID_PATTERN.test(entry['backup_id']) ||
      !isUtc(entry['created_at']) ||
      typeof entry['forgetting_generation'] !== 'string' ||
      !GENERATION.test(entry['forgetting_generation'])
    )
      return null;
    lastSuccess = {
      backup_id: entry['backup_id'],
      created_at: entry['created_at'],
      forgetting_generation: entry['forgetting_generation'],
    };
  }
  return {
    schema: 'buddy.backup-state.v1',
    last_checked_at: checked,
    first_seen: firstSeen,
    last_success: lastSuccess,
    needs_new_backup: record['needs_new_backup'],
    sweep_incomplete: record['sweep_incomplete'],
  };
}

export type StateRead =
  | {
      readonly ok: true;
      readonly value: BackupStateValue;
      readonly fresh: boolean;
    }
  | { readonly ok: false };

// 状態ファイルを読む。なければ空の状態（初回）。壊れていれば ok: false（時計の最終確認を失ったので、期限の削除をしない）。
export async function readBackupState(dataDir: string): Promise<StateRead> {
  const text = await readText(join(dataDir, BACKUP_STATE_FILE));
  if (text === 'missing')
    return { ok: true, value: EMPTY_BACKUP_STATE, fresh: true };
  if (text === 'invalid') return { ok: false };
  const value = parseBackupState(text);
  return value === null ? { ok: false } : { ok: true, value, fresh: false };
}

export async function writeBackupState(
  dataDir: string,
  value: BackupStateValue,
): Promise<void> {
  await writeFileAtomic(
    dataDir,
    BACKUP_STATE_FILE,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}
