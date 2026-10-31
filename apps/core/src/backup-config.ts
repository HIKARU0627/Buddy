// バックアップの置き場所の設定ファイルの読み込みと置き場所の検査（本人の判断 J2、2026-10-24、ADR 0040・0055）。
//
// - 設定は Core のデータディレクトリの backup-config.json（リポジトリの外。予算の設定と同じ方式）。本人が書き、Core は
//   使うたびに読む。普通のファイル（シンボリックリンクではない）で、大きさの上限以内で、本人以外が書けない（POSIX）ときだけ読む。
// - 厳格な JSON（重複キー・不正な Unicode を拒否）→ 契約の JSON Schema（BackupConfig）の順に確かめる。どれかに通らなければ
//   バックアップを取らない（理由コードだけを返し、ファイルの中身を返さない）。
// - 置き場所の検査（BackupLocationCheck）: ディレクトリである・書ける・Core のデータディレクトリでない（データディレクトリの
//   中に置くと、DB と同じ場所に写しが残り、掃除の対象と混ざる）。同期フォルダー（iCloud・OneDrive・Dropbox・Google Drive など）
//   は使えるが警告する（クラウド側に古い版が残ると、忘却と期限で消した写しが残り得る）。判定はパスの規則だけで、OS の API は
//   呼ばない（原本に決めなし。U124）。判定できない同期の仕組みは警告が出ない。

import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ApiContract } from './api-contract.js';
import { StrictJsonError, parseStrictJson } from './strict-json.js';

export const BACKUP_CONFIG_FILE = 'backup-config.json';
export const MAX_BACKUP_CONFIG_BYTES = 16 * 1024;
export const DEFAULT_KEEP_GENERATIONS = 7;

export interface BackupConfigValue {
  readonly schema: 'buddy.backup-config.v1';
  readonly directory: string;
  readonly keep_generations: number;
}

export type LoadedBackupConfig =
  | { readonly ok: true; readonly config: BackupConfigValue }
  | { readonly ok: false; readonly reasons: readonly string[] };

const fail = (...reasons: string[]): LoadedBackupConfig => ({
  ok: false,
  reasons,
});

export function checkBackupConfigText(
  text: string,
  contract: ApiContract,
): LoadedBackupConfig {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(text, 8);
  } catch (error) {
    return fail(
      error instanceof StrictJsonError && error.code === 'duplicate_key'
        ? 'config_duplicate_key'
        : 'config_invalid_json',
    );
  }
  const value = JSON.parse(JSON.stringify(parsed)) as unknown;
  if (!contract.valid('BackupConfig', value))
    return fail('config_schema_invalid');
  return { ok: true, config: value as BackupConfigValue };
}

export async function loadBackupConfig(options: {
  readonly path: string;
  readonly contract: ApiContract;
  readonly platform?: NodeJS.Platform;
}): Promise<LoadedBackupConfig> {
  const platform = options.platform ?? process.platform;
  let stat;
  try {
    stat = await lstat(options.path);
  } catch (error) {
    return fail(
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'config_missing'
        : 'config_unreadable',
    );
  }
  if (!stat.isFile()) return fail('config_not_regular_file');
  if (stat.size > MAX_BACKUP_CONFIG_BYTES) return fail('config_too_large');
  // 本人以外が書ける設定は、置き場所を他人が変えられる（バックアップを別の場所へ出させる）ので使わない（POSIX のみ）。
  if (platform !== 'win32' && (stat.mode & 0o022) !== 0)
    return fail('config_writable_by_others');
  let text: string;
  try {
    const bytes = await readFile(options.path);
    if (bytes.byteLength > MAX_BACKUP_CONFIG_BYTES)
      return fail('config_too_large');
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('config_unreadable');
  }
  return checkBackupConfigText(text, options.contract);
}

export type SyncProviderHint =
  'icloud' | 'onedrive' | 'dropbox' | 'google_drive' | 'other';

// パスの区切りごとの名前から、同期フォルダーの種類の手がかりを求める（パスの規則だけ。大文字小文字を区別しない）。
// 判定できなければ null。複数に当たるときは先に挙げた順（iCloud → OneDrive → Dropbox → Google Drive → その他）。
export function syncProviderHint(path: string): SyncProviderHint | null {
  const segments = path
    .split(/[\\/]+/u)
    .filter((segment) => segment !== '')
    .map((segment) => segment.toLowerCase());
  const has = (test: (segment: string) => boolean): boolean =>
    segments.some(test);
  if (
    has(
      (s) =>
        s === 'mobile documents' ||
        s === 'icloud drive' ||
        s === 'iclouddrive' ||
        s === 'com~apple~clouddocs',
    )
  )
    return 'icloud';
  if (has((s) => s === 'onedrive' || s.startsWith('onedrive - ')))
    return 'onedrive';
  if (has((s) => s === 'dropbox' || s.startsWith('dropbox (')))
    return 'dropbox';
  if (
    has(
      (s) =>
        s === 'google drive' ||
        s === 'googledrive' ||
        s === 'my drive' ||
        s.startsWith('googledrive-'),
    )
  )
    return 'google_drive';
  // macOS の File Provider の置き場所（~/Library/CloudStorage/<サービス名>）。上のどれでもない同期の仕組み。
  for (let index = 0; index < segments.length - 1; index += 1)
    if (segments[index] === 'library' && segments[index + 1] === 'cloudstorage')
      return 'other';
  return null;
}

export interface BackupLocationCheckValue {
  readonly schema: 'buddy.backup-location-check.v1';
  readonly directory: string;
  readonly usable: boolean;
  readonly problems: readonly (
    'not_a_directory' | 'not_writable' | 'is_data_directory'
  )[];
  readonly warnings: readonly 'sync_folder_detected'[];
  readonly sync_provider_hint: SyncProviderHint | null;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// 置き場所を検査する。ディレクトリを作らない（本人が用意する）。書けるかは一時ファイルを作って確かめる。
export async function checkBackupLocation(
  directory: string,
  dataDir: string,
): Promise<BackupLocationCheckValue> {
  const problems: ('not_a_directory' | 'not_writable' | 'is_data_directory')[] =
    [];
  let real = resolve(directory);
  try {
    real = await realpath(directory);
    const info = await lstat(real);
    if (!info.isDirectory()) problems.push('not_a_directory');
  } catch {
    problems.push('not_a_directory');
  }
  if (!problems.includes('not_a_directory')) {
    let realData = resolve(dataDir);
    try {
      realData = await realpath(dataDir);
    } catch {
      // データディレクトリが読めなくても、パスの比較は続ける。
    }
    // データディレクトリそのもの・その中は使えない。データディレクトリを含む上位のディレクトリは使える。
    if (isInside(realData, real)) problems.push('is_data_directory');
    const probe = join(real, `.buddy-write-check-${randomUUID()}`);
    try {
      await mkdir(probe);
      await rm(probe, { recursive: true, force: true });
    } catch {
      problems.push('not_writable');
    }
  }
  const hint = syncProviderHint(directory) ?? syncProviderHint(real);
  return {
    schema: 'buddy.backup-location-check.v1',
    directory,
    usable: problems.length === 0,
    problems,
    warnings: hint === null ? [] : ['sync_folder_detected'],
    sync_provider_hint: hint,
  };
}

// 試験・CLI の補助: 設定ファイルを書く（本人だけが書ける権限で）。
export async function writeBackupConfig(
  path: string,
  config: BackupConfigValue,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}
