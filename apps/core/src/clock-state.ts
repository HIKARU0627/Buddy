// 時計の最終確認時刻と epoch を置く小さなファイル（設計 03 保存期限、ADR 0043・0058、B06-07a-1）。
//
// 本人が 2026-10-31 に決めた（ADR 0058 の U136）:
// - 置き場所は DB ではなく、データディレクトリの小さなファイル（台帳のファイルと同じ書き方＝一時ファイルに書いて
//   fsync し、rename で置き換えてからディレクトリを fsync する）。DB は復元・巻き戻しで一緒に古くなり、判定を逃れる。
// - ファイルが無い（または読めない）ときは判定できないものとして、自動利用（検索・クラウド送信・自動利用）を止める。
//   初めての起動（DB を新しく作った起動）だけは、ファイルを新しく作る。
// - 進めすぎた時計の採り直しは、中枢の機器の前で行うローカル制御の操作（本人が見た値を明示して承認）で、記録を残す。
// 本文を持たない。最後の 20 件の採り直しの記録（時刻・要求の ID・前後の最終確認時刻）を同じファイルに残す。
// `storage_boundary` は記録しない区切りの世代（ADR 0045・Q7。B06-07a-2）が同居するための予約の欄で、いまは検査せず
// 書き換えずに保つ。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './data-dir.js';
import { CLOCK_STATE_FILE } from './paths.js';
import { UUID_PATTERN, isJsonObject, parseStrictJson } from './strict-json.js';
import type { JsonValue } from './strict-json.js';

export const CLOCK_STATE_SCHEMA = 'buddy.clock-state.v1';
export const CLOCK_RECHECK_HISTORY_MAX = 20;

export interface ClockRecheckRecord {
  // 採り直しを承認した時刻（そのときの時計）。
  readonly at: string;
  readonly request_id: string;
  // 採り直しの前の最終確認時刻（ファイルが無い・読めないときは null）。
  readonly from_last_checked_at: string | null;
  readonly to_last_checked_at: string;
}

export interface ClockStateContent {
  readonly schema: typeof CLOCK_STATE_SCHEMA;
  // 書くたびに 1 増える。採り直しの要求は、本人が見たこの値を渡す。
  readonly revision: number;
  readonly last_checked_at: string;
  readonly epoch: string;
  readonly epoch_started_at: string;
  readonly written_at: string;
  readonly rechecks: readonly ClockRecheckRecord[];
  // 予約の欄（B06-07a-2）。検査せず、書き換えずに保つ。
  readonly storage_boundary: JsonValue | null;
}

export type ClockStateLoad =
  | { readonly status: 'verified'; readonly content: ClockStateContent }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly reason: string };

const MILLIS_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/u;

// UTC の RFC 3339 で、暦にある時刻か（Date が別の時刻へずらさない）。
export function isClockTime(value: unknown): value is string {
  if (typeof value !== 'string' || !MILLIS_TIME.test(value)) return false;
  const parsed = Date.parse(value);
  return (
    !Number.isNaN(parsed) &&
    new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

const TOP_KEYS = [
  'schema',
  'revision',
  'last_checked_at',
  'epoch',
  'epoch_started_at',
  'written_at',
  'rechecks',
  'storage_boundary',
];
const RECHECK_KEYS = [
  'at',
  'request_id',
  'from_last_checked_at',
  'to_last_checked_at',
];

function sameKeys(value: object, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    own.length === expected.length &&
    own.every((key, index) => key === expected[index])
  );
}

export function parseClockState(text: string): ClockStateContent | null {
  let value: JsonValue;
  try {
    value = parseStrictJson(text, 8);
  } catch {
    return null;
  }
  if (!isJsonObject(value) || !sameKeys(value, TOP_KEYS)) return null;
  const revision = value['revision'];
  const rechecks = value['rechecks'];
  if (
    value['schema'] !== CLOCK_STATE_SCHEMA ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !isClockTime(value['last_checked_at']) ||
    typeof value['epoch'] !== 'string' ||
    !UUID_PATTERN.test(value['epoch']) ||
    !isClockTime(value['epoch_started_at']) ||
    !isClockTime(value['written_at']) ||
    !Array.isArray(rechecks) ||
    rechecks.length > CLOCK_RECHECK_HISTORY_MAX
  )
    return null;
  const history: ClockRecheckRecord[] = [];
  for (const item of rechecks) {
    if (!isJsonObject(item) || !sameKeys(item, RECHECK_KEYS)) return null;
    const from = item['from_last_checked_at'];
    if (
      !isClockTime(item['at']) ||
      typeof item['request_id'] !== 'string' ||
      !UUID_PATTERN.test(item['request_id']) ||
      !(from === null || isClockTime(from)) ||
      !isClockTime(item['to_last_checked_at'])
    )
      return null;
    history.push({
      at: item['at'],
      request_id: item['request_id'],
      from_last_checked_at: from,
      to_last_checked_at: item['to_last_checked_at'],
    });
  }
  return {
    schema: CLOCK_STATE_SCHEMA,
    revision,
    last_checked_at: value['last_checked_at'],
    epoch: value['epoch'],
    epoch_started_at: value['epoch_started_at'],
    written_at: value['written_at'],
    rechecks: history,
    // 予約の欄は検査せず、そのまま保つ（原型を持たないオブジェクトを通常のオブジェクトにする）。
    storage_boundary: JSON.parse(
      JSON.stringify(value['storage_boundary'] ?? null),
    ) as JsonValue,
  };
}

export function serializeClockState(content: ClockStateContent): string {
  return `${JSON.stringify({
    schema: content.schema,
    revision: content.revision,
    last_checked_at: content.last_checked_at,
    epoch: content.epoch,
    epoch_started_at: content.epoch_started_at,
    written_at: content.written_at,
    rechecks: content.rechecks,
    storage_boundary: content.storage_boundary,
  })}\n`;
}

// 掃除の job が使う口。Core の試験では差し替える。
export interface ClockStatePort {
  load(): Promise<ClockStateLoad>;
  save(content: ClockStateContent): Promise<void>;
}

// データディレクトリのファイル。保存は一時ファイル → fsync → rename → ディレクトリの fsync（writeFileAtomic）。
export function createClockStateFile(dataDir: string): ClockStatePort {
  const path = join(dataDir, CLOCK_STATE_FILE);
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return { status: 'missing' };
        return { status: 'invalid', reason: 'unreadable' };
      }
      const content = parseClockState(text);
      return content === null
        ? { status: 'invalid', reason: 'malformed' }
        : { status: 'verified', content };
    },
    async save(content) {
      await writeFileAtomic(
        dataDir,
        CLOCK_STATE_FILE,
        serializeClockState(content),
      );
    },
  };
}
