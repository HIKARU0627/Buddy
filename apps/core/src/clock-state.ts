// 時計の最終確認時刻と epoch を置く小さなファイル（設計 03 保存期限、ADR 0043・0058、B06-07a-1）。
//
// 本人が 2026-10-31 に決めた（ADR 0058 の U136）:
// - 置き場所は DB ではなく、データディレクトリの小さなファイル（台帳のファイルと同じ書き方＝一時ファイルに書いて
//   fsync し、rename で置き換えてからディレクトリを fsync する）。DB は復元・巻き戻しで一緒に古くなり、判定を逃れる。
// - ファイルが無い（または読めない）ときは判定できないものとして、自動利用（検索・クラウド送信・自動利用）を止める。
//   初めての起動（DB を新しく作った起動）だけは、ファイルを新しく作る。
// - 進めすぎた時計の採り直しは、中枢の機器の前で行うローカル制御の操作（本人が見た値を明示して承認）で、記録を残す。
// 本文を持たない。最後の 20 件の採り直しの記録（時刻・要求の ID・前後の最終確認時刻）を同じファイルに残す。
// `storage_boundary` は記録しない区切りの世代（ADR 0045・0059、Q7。B06-07a-2）。ファイル全体の検査（parseClockState）
// では中身を見ず（世代の欄が壊れても時計の判定を止めない）、保存境界の保持者が parseStorageBoundary で読む。

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

// ---- 記録しない区切りの世代（`storage_boundary` の欄。ADR 0059、本人が 2026-10-31 に決定した Q7） ----------------------

// 番号だけを置く（本文・区切りの ID・発言を持たない）。Core が再起動しても世代が戻らないことと、再起動の前に記録しない
// 区切りが開いていたこと（終わった知らせを出すため）を知るための 2 欄。
export interface StorageBoundaryRecord {
  // 最後に発行した区切りの世代（10 進の文字列）。
  readonly segment_generation: string;
  // その世代が記録しない区切りとして開いているか。
  readonly private_open: boolean;
}

export type StorageBoundaryLoad =
  // ファイルは読めたが、欄がない（まだ記録しない区切りを使っていない）。
  | { readonly status: 'absent' }
  | { readonly status: 'ok'; readonly record: StorageBoundaryRecord }
  // 欄はあるが形が違う（壊れている）。黙って読み替えない。
  | { readonly status: 'invalid' }
  // ファイルが無い・読めない。世代を知る手段も書く場所もない。
  | { readonly status: 'unavailable' };

const BOUNDARY_KEYS = ['segment_generation', 'private_open'];
// 64 ビットの範囲に収まる桁数（入る・出るのたびに 1 進むだけなので届かない。壊れた巨大な値を受けないための上限）。
const BOUNDARY_GENERATION = /^(0|[1-9][0-9]{0,18})$/u;

export function parseStorageBoundary(
  value: JsonValue | null,
): StorageBoundaryLoad {
  if (value === null) return { status: 'absent' };
  if (!isJsonObject(value) || !sameKeys(value, BOUNDARY_KEYS))
    return { status: 'invalid' };
  const generation = value['segment_generation'];
  const open = value['private_open'];
  if (
    typeof generation !== 'string' ||
    !BOUNDARY_GENERATION.test(generation) ||
    typeof open !== 'boolean'
  )
    return { status: 'invalid' };
  return {
    status: 'ok',
    record: { segment_generation: generation, private_open: open },
  };
}

export const serializeStorageBoundary = (
  record: StorageBoundaryRecord,
): JsonValue => ({
  segment_generation: record.segment_generation,
  private_open: record.private_open,
});

// 掃除の job が使う口。Core の試験では差し替える。
export interface ClockStatePort {
  load(): Promise<ClockStateLoad>;
  save(content: ClockStateContent): Promise<void>;
}

// 同じファイルを掃除の job（最終確認時刻）と保存境界の保持者（記録しない区切りの世代）が書く。読んで書き換える処理を
// 1 つずつ行い、どちらの書き込みも相手の欄を落とさない（ADR 0059）。
export interface ClockStateFilePort extends ClockStatePort {
  loadBoundary(): Promise<StorageBoundaryLoad>;
  // 世代を書く。ファイルが無い・読めない・形が違うときは書かず 'unavailable'（初めての起動のファイルを作るのは掃除の
  // job。ここで作ると、既存の DB でファイルが消えている状態を黙って作り直してしまう）。書き込みの失敗は拒否で返す。
  saveBoundary(record: StorageBoundaryRecord): Promise<'saved' | 'unavailable'>;
}

// データディレクトリのファイル。保存は一時ファイル → fsync → rename → ディレクトリの fsync（writeFileAtomic）。
export function createClockStateFile(dataDir: string): ClockStateFilePort {
  const path = join(dataDir, CLOCK_STATE_FILE);
  let serial: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const next = serial.then(run, run);
    serial = next.catch(() => undefined);
    return next;
  };
  const read = async (): Promise<ClockStateLoad> => {
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
  };
  const write = (content: ClockStateContent) =>
    writeFileAtomic(dataDir, CLOCK_STATE_FILE, serializeClockState(content));
  return {
    load: () => exclusive(read),
    // 掃除の job の保存。渡された内容の `storage_boundary` は古いことがあるので、ファイルにある今の値で置き換える。
    save: (content) =>
      exclusive(async () => {
        const current = await read();
        await write(
          current.status === 'verified'
            ? { ...content, storage_boundary: current.content.storage_boundary }
            : content,
        );
      }),
    loadBoundary: () =>
      exclusive(async () => {
        const current = await read();
        return current.status === 'verified'
          ? parseStorageBoundary(current.content.storage_boundary)
          : { status: 'unavailable' };
      }),
    // 版・最終確認時刻・採り直しの記録は変えない（時計の採り直しの照合値を動かさない）。
    saveBoundary: (record) =>
      exclusive(async () => {
        const current = await read();
        if (current.status !== 'verified') return 'unavailable';
        await write({
          ...current.content,
          storage_boundary: serializeStorageBoundary(record),
        });
        return 'saved';
      }),
  };
}
