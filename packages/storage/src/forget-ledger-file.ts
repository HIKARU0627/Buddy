// 忘却台帳の別ファイル（設計 03 バックアップ・復元、ADR 0040・0054。契約の ForgetLedgerFile）。
//
// DB（forget_ledger・forget_ledger_items）が正本で、ファイルは DB から作り直せる写し（本文なし・ID と HMAC だけ）。
// 忘却の transaction の COMMIT の後と、Core の起動時に、次の手順でそろえる（片方だけが進んだときの再開）。
// - ファイルが DB より遅れている（COMMIT の後・書く前に止まった）: DB の全件でファイルを書き直す。
// - ファイルと DB が同じ head: 何もしない。
// - ファイルが DB より進んでいる・同じ世代の hash が違う・系譜が違う・ファイルが壊れている: 書き換えずに拒否する
//   （DB が古い状態へ戻された疑い。忘れた内容を戻さないよう、復元の手順で台帳を当てるまで Core を起動しない）。
// 書き込みは同じディレクトリの一時ファイルに書いて fsync し、rename で置き換えてからディレクトリを fsync する（途中で
// 止まっても、ファイルは前の版か新しい版のどちらか）。取り残された一時ファイルも、消す前に DB と照合する（DB が古い
// 状態へ戻されると、rename の前に止まった一時ファイルだけが新しい世代を持つことがある）。DB がその中身を含むと
// 確かめられた一時ファイル（DB と同じか古い世代・書きかけでも DB から作った文の先頭と同じ）だけを消し、新しい世代・
// 別の系譜・分岐した連鎖・確かめられない中身の一時ファイルは残して拒否する（ADR 0054。PR #168 の 2 回目のレビュー）。

import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ForgetLedgerEntryDraft } from '@buddy/domain';
import {
  LEDGER_ZERO_HASH,
  ledgerEntryHash,
  normalizeLedgerEntry,
} from './forget-store.js';
import type { ForgetLedgerExport, LedgerChainEntry } from './forget-store.js';

export const FORGET_LEDGER_FILE_SCHEMA = 'buddy.forget-ledger-file.v1';

export interface ForgetLedgerFileContent {
  readonly schema: typeof FORGET_LEDGER_FILE_SCHEMA;
  readonly ledger_id: string;
  readonly entries: readonly LedgerChainEntry[];
  readonly head: {
    readonly forgetting_generation: string;
    readonly entry_hash: string;
  };
  readonly written_at: string;
}

export type LedgerFileRefusal =
  // ファイルを読めない・形が違う・連鎖が壊れている（generation_gap・previous_hash・entry_hash・head の食い違い）。
  | 'ledger_file_invalid'
  // ファイルと DB の台帳の系譜が違う。
  | 'ledger_lineage_mismatch'
  // ファイルの head が DB より新しい（DB が古い状態へ戻された疑い）。
  | 'ledger_file_ahead'
  // 同じ世代の hash が違う。
  | 'ledger_file_diverged';

export type LedgerFileSyncResult =
  | {
      readonly ok: true;
      // in_sync: そろっていた。written: DB に合わせて書いた。none: 台帳もファイルもない。
      readonly action: 'in_sync' | 'written' | 'none';
      readonly forgetting_generation: string;
    }
  | { readonly ok: false; readonly reason: LedgerFileRefusal };

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const ENTRY_KEYS = [
  'blocked_content_keys',
  'blocked_source_hmacs',
  'entry_id',
  'forgetting_generation',
  'forgotten',
  'recorded_at',
  'schema',
].join(',');

const keysOf = (value: Record<string, unknown>): string =>
  Object.keys(value).sort().join(',');

// 1 件の形（契約の ForgetLedgerEntry。追加の欄を持たない＝本文を混ぜない）。
function entryShapeOk(value: Record<string, unknown>): boolean {
  if (keysOf(value) !== ENTRY_KEYS) return false;
  if (value['schema'] !== 'buddy.forget-ledger.v1') return false;
  if (typeof value['entry_id'] !== 'string' || !UUID_V4.test(value['entry_id']))
    return false;
  if (typeof value['recorded_at'] !== 'string') return false;
  const forgotten = value['forgotten'];
  if (!Array.isArray(forgotten) || forgotten.length === 0) return false;
  for (const item of forgotten) {
    if (!isObject(item)) return false;
    if (item['source_kind'] === 'source_item') {
      if (keysOf(item) !== 'source_id_hmac,source_kind') return false;
      if (
        typeof item['source_id_hmac'] !== 'string' ||
        !HEX64.test(item['source_id_hmac'])
      )
        return false;
    } else if (
      item['source_kind'] === 'turn' ||
      item['source_kind'] === 'memory'
    ) {
      if (keysOf(item) !== 'source_id,source_kind') return false;
      if (
        typeof item['source_id'] !== 'string' ||
        !UUID_V4.test(item['source_id'])
      )
        return false;
    } else return false;
  }
  for (const key of ['blocked_source_hmacs', 'blocked_content_keys']) {
    const list = value[key];
    if (
      !Array.isArray(list) ||
      !list.every((hash) => typeof hash === 'string' && HEX64.test(hash))
    )
      return false;
  }
  return true;
}

// ファイルの中身の検査（契約の意味検査と同じ: 世代の欠番・重複、previous_hash・entry_hash・head の食い違い）。
// 1 件の中身は、hash を計算し直して確かめる（書き換えの検出）。読めれば中身を返し、だめなら null。
export function parseLedgerFile(text: string): ForgetLedgerFileContent | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  if (keysOf(value) !== 'entries,head,ledger_id,schema,written_at') return null;
  if (value['schema'] !== FORGET_LEDGER_FILE_SCHEMA) return null;
  const ledgerId = value['ledger_id'];
  if (typeof ledgerId !== 'string' || !UUID_V4.test(ledgerId)) return null;
  const entries = value['entries'];
  const head = value['head'];
  if (!Array.isArray(entries) || !isObject(head)) return null;
  if (keysOf(head) !== 'entry_hash,forgetting_generation') return null;
  let previous = LEDGER_ZERO_HASH;
  const out: LedgerChainEntry[] = [];
  for (const [index, item] of entries.entries()) {
    if (!isObject(item) || !isObject(item['entry'])) return null;
    if (keysOf(item) !== 'entry,entry_hash,previous_hash') return null;
    if (!entryShapeOk(item['entry'])) return null;
    const entry = item['entry'] as unknown as ForgetLedgerEntryDraft;
    if (entry.forgetting_generation !== String(index + 1)) return null;
    if (item['previous_hash'] !== previous) return null;
    let hash: string;
    try {
      hash = ledgerEntryHash(entry, previous);
    } catch {
      return null;
    }
    if (item['entry_hash'] !== hash) return null;
    out.push({
      entry: normalizeLedgerEntry(entry),
      previous_hash: previous,
      entry_hash: hash,
    });
    previous = hash;
  }
  const generation = String(out.length);
  if (
    head['forgetting_generation'] !== generation ||
    head['entry_hash'] !== previous ||
    typeof value['written_at'] !== 'string'
  )
    return null;
  return {
    schema: FORGET_LEDGER_FILE_SCHEMA,
    ledger_id: ledgerId,
    entries: out,
    head: { forgetting_generation: generation, entry_hash: previous },
    written_at: value['written_at'],
  };
}

export function buildLedgerFile(
  exported: ForgetLedgerExport,
  writtenAt: Date,
): ForgetLedgerFileContent {
  if (exported.ledger_id === null) throw new Error('ledger_id がありません。');
  // 欄の順は文に出る順（written_at を先に置き、書きかけの一時ファイルでも DB から同じ文を作り直して照合できるように
  // する）。読むときの検査は欄の順に依らない。
  return {
    schema: FORGET_LEDGER_FILE_SCHEMA,
    written_at: writtenAt.toISOString(),
    ledger_id: exported.ledger_id,
    entries: exported.entries,
    head: exported.head,
  };
}

export function ledgerFileText(content: ForgetLedgerFileContent): string {
  return `${JSON.stringify(content, null, 2)}\n`;
}

const TEMP_PREFIX = '.forget-ledger-';
const TEMP_SUFFIX = '.tmp';

async function fsyncDirectory(dir: string): Promise<void> {
  // Windows はディレクトリを開いて fsync できない。rename の永続は OS に任せる。
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// 一時ファイルに書いて fsync し、rename で置き換える。試験は beforeRename で rename の前の停止を再現する。
export async function writeLedgerFileAtomic(
  path: string,
  content: ForgetLedgerFileContent,
  options: { readonly beforeRename?: () => void } = {},
): Promise<void> {
  const dir = dirname(path);
  const temp = join(dir, `${TEMP_PREFIX}${randomUUID()}${TEMP_SUFFIX}`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(ledgerFileText(content), 'utf8');
    await handle.sync();
  } catch (error) {
    // 書けなかった一時ファイルは消す（消せなければ次の同期が照合する）。
    await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  options.beforeRename?.();
  await rename(temp, path);
  await fsyncDirectory(dir);
}

// 取り残された一時ファイル（rename の前に止まったもの・書きかけのもの）。
async function staleTemps(path: string): Promise<string[]> {
  const dir = dirname(path);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter(
      (name) =>
        name.startsWith(TEMP_PREFIX) &&
        name.endsWith(TEMP_SUFFIX) &&
        name !== basename(path),
    )
    .sort()
    .map((name) => join(dir, name));
}

// 読めたファイル（正規の台帳・一時ファイル）を DB と照合する。null なら DB がその中身を含む（同じか古い世代）。
function fileRefusal(
  file: ForgetLedgerFileContent,
  exported: ForgetLedgerExport,
): LedgerFileRefusal | null {
  if (exported.ledger_id === null)
    // DB に台帳がないのにファイルに項目がある: DB が台帳より前へ戻された疑い。
    return file.entries.length > 0 ? 'ledger_file_ahead' : null;
  if (file.ledger_id !== exported.ledger_id) return 'ledger_lineage_mismatch';
  if (file.entries.length > Number(exported.head.forgetting_generation))
    return 'ledger_file_ahead';
  for (const [index, item] of file.entries.entries())
    if (item.entry_hash !== exported.entries[index]?.entry_hash)
      return 'ledger_file_diverged';
  return null;
}

const WRITTEN_AT =
  /^\{\n {2}"schema": "[^"\n]*",\n {2}"written_at": "([^"\n]+)"/u;

// 書きかけで読めない一時ファイルを、DB から作った文と比べる。DB の先頭の k 世代（k = 1..head）で作った文のどれかの
// 先頭と一致すれば、DB がその中身を含む（書いていた時点の DB は今の DB と同じか、その先頭）。written_at まで届いて
// いない書きかけは、台帳の項目を持たない。
function partialTempContained(
  text: string,
  exported: ForgetLedgerExport,
): boolean {
  const opening = `{\n  "schema": "${FORGET_LEDGER_FILE_SCHEMA}",\n  "written_at": "`;
  // written_at の値の途中までで途切れた書きかけも、台帳の項目を持たない。
  if (
    opening.startsWith(text) ||
    (text.startsWith(opening) && !text.slice(opening.length).includes('"'))
  )
    return true;
  const match = WRITTEN_AT.exec(text);
  if (match === null || exported.ledger_id === null) return false;
  const writtenAt = new Date(match[1] ?? '');
  if (Number.isNaN(writtenAt.getTime()) || writtenAt.toISOString() !== match[1])
    return false;
  for (let k = exported.entries.length; k >= 1; k -= 1) {
    const entries = exported.entries.slice(0, k);
    const last = entries[k - 1];
    if (last === undefined) continue;
    const rendered = ledgerFileText(
      buildLedgerFile(
        {
          ledger_id: exported.ledger_id,
          entries,
          head: {
            forgetting_generation: last.entry.forgetting_generation,
            entry_hash: last.entry_hash,
          },
        },
        writtenAt,
      ),
    );
    if (rendered.startsWith(text)) return true;
  }
  return false;
}

async function tempRefusal(
  temp: string,
  exported: ForgetLedgerExport,
): Promise<LedgerFileRefusal | null> {
  let text: string;
  try {
    text = await readFile(temp, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return 'ledger_file_invalid';
  }
  const parsed = parseLedgerFile(text);
  if (parsed !== null) return fileRefusal(parsed, exported);
  return partialTempContained(text, exported) ? null : 'ledger_file_invalid';
}

// 台帳のファイル・書きかけの一時ファイルが 1 つでもあるか（確かめられなければ、ある側に倒す）。0012 より前の台帳の行が
// ある DB に系譜を新しく付けてよいかの判定に使う（U119。ファイルがあれば、その系譜を確かめずに新しい ID を出さない）。
export async function ledgerFileTraceExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
  }
  let names: string[];
  try {
    names = await readdir(dirname(path));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  return names.some(
    (name) => name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX),
  );
}

async function readExisting(
  path: string,
): Promise<ForgetLedgerFileContent | null | 'invalid'> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return 'invalid';
  }
  return parseLedgerFile(text) ?? 'invalid';
}

// DB の台帳（exportForgetLedger の結果）とファイルをそろえる。手順はファイルの先頭のコメント。
export async function syncForgetLedgerFile(
  path: string,
  exported: ForgetLedgerExport,
  now: Date,
  options: { readonly beforeRename?: () => void } = {},
): Promise<LedgerFileSyncResult> {
  // 消す前に、すべての一時ファイルと正規の台帳を DB と照合する（拒否するときは何も消さない・書かない）。
  const temps = await staleTemps(path);
  for (const temp of temps) {
    const refusal = await tempRefusal(temp, exported);
    if (refusal !== null) return { ok: false, reason: refusal };
  }
  const existing = await readExisting(path);
  if (existing === 'invalid')
    return { ok: false, reason: 'ledger_file_invalid' };
  if (existing !== null) {
    const refusal = fileRefusal(existing, exported);
    if (refusal !== null) return { ok: false, reason: refusal };
  }
  // DB が中身を含むと確かめた一時ファイルだけを消す。
  for (const temp of temps) await rm(temp, { force: true });
  const dbHead = Number(exported.head.forgetting_generation);
  if (existing === null && exported.ledger_id === null)
    return { ok: true, action: 'none', forgetting_generation: '0' };
  if (existing !== null) {
    if (exported.ledger_id === null)
      return { ok: true, action: 'in_sync', forgetting_generation: '0' };
    if (existing.entries.length === dbHead)
      return {
        ok: true,
        action: 'in_sync',
        forgetting_generation: exported.head.forgetting_generation,
      };
  }
  if (!HEX64.test(exported.head.entry_hash))
    return { ok: false, reason: 'ledger_file_invalid' };
  await writeLedgerFileAtomic(path, buildLedgerFile(exported, now), options);
  return {
    ok: true,
    action: 'written',
    forgetting_generation: exported.head.forgetting_generation,
  };
}
