// io_epoch とこの端末の停止の範囲を、クライアントの再起動で巻き戻さないための小さな保存（ADR 0015）。
// Electron の userData 配下の device-io-state.json に io_epoch と stop_scope だけを置く（秘密・本文・端末 ID を含めない）。
// 書き込みは一時ファイル → fsync → rename（→ ディレクトリの fsync）で原子的に行う。
// Electron に依存しない（node:test で一時ディレクトリを使って試験する）。
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const DEVICE_IO_STATE_FILE = 'device-io-state.json';

// B01 のデスクトップが自分で作れる停止は local だけ。来客モード・全体停止は中枢（B03 以降）が正本なので保存しない。
export interface DeviceIoRecord {
  readonly io_epoch: string;
  readonly stop_scope: 'none' | 'local';
}

export type DeviceIoLoad =
  // 初回起動（ファイルがない）。停止していない・世代 0 から始める。
  | { readonly kind: 'missing'; readonly record: DeviceIoRecord }
  | { readonly kind: 'loaded'; readonly record: DeviceIoRecord }
  // 読めない・形式が違う。停止中・保存値より大きい世代として扱い、黙って許可状態に戻さない。
  | { readonly kind: 'corrupt'; readonly record: DeviceIoRecord };

const MAX_FILE_BYTES = 4096;
const MAX_EPOCH_DIGITS = 30;
const EPOCH = /^(0|[1-9][0-9]*)$/u;

const isEpoch = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= MAX_EPOCH_DIGITS &&
  EPOCH.test(value);

export const INITIAL_DEVICE_IO_RECORD: DeviceIoRecord = {
  io_epoch: '0',
  stop_scope: 'none',
};

// 保存の内容を検査して値にする。項目は io_epoch と stop_scope のちょうど 2 つだけを受け付ける。
export function parseDeviceIoRecord(text: string): DeviceIoRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'io_epoch' || keys[1] !== 'stop_scope')
    return null;
  const record = value as Record<string, unknown>;
  const epoch = record['io_epoch'];
  const scope = record['stop_scope'];
  if (!isEpoch(epoch)) return null;
  if (scope !== 'none' && scope !== 'local') return null;
  return { io_epoch: epoch, stop_scope: scope };
}

export function serializeDeviceIoRecord(record: DeviceIoRecord): string {
  return `${JSON.stringify({ io_epoch: record.io_epoch, stop_scope: record.stop_scope })}\n`;
}

// 壊れた保存から復帰するときの世代。保存されていた値は分からないため、
// 1 ずつ進める世代が到達しない値（UTC のミリ秒）と、読み取れた世代 + 1 の大きい方にする。
export function recoveryIoEpoch(text: string | null, now: Date): string {
  let candidate = BigInt(Math.max(0, Math.trunc(now.getTime())));
  if (text !== null) {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === 'object' && value !== null) {
        const epoch = (value as Record<string, unknown>)['io_epoch'];
        if (isEpoch(epoch) && BigInt(epoch) + 1n > candidate)
          candidate = BigInt(epoch) + 1n;
      }
    } catch {
      // 読み取れなければ時刻だけを使う。
    }
  }
  return candidate.toString();
}

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'ENOENT';

export function loadDeviceIoRecord(path: string, now: Date): DeviceIoLoad {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (isMissing(error))
      return { kind: 'missing', record: INITIAL_DEVICE_IO_RECORD };
    // 読めない（権限・ディレクトリなど）ときも停止中として扱う。
    return {
      kind: 'corrupt',
      record: { io_epoch: recoveryIoEpoch(null, now), stop_scope: 'local' },
    };
  }
  let text: string | null = null;
  if (bytes.length <= MAX_FILE_BYTES) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = null;
    }
  }
  const record = text === null ? null : parseDeviceIoRecord(text);
  if (record) return { kind: 'loaded', record };
  return {
    kind: 'corrupt',
    record: { io_epoch: recoveryIoEpoch(text, now), stop_scope: 'local' },
  };
}

// 一時ファイルに書いて fsync し、rename で置き換える。途中で失敗しても元のファイルは壊さない。
export function saveDeviceIoRecord(path: string, record: DeviceIoRecord): void {
  if (!isEpoch(record.io_epoch))
    throw new Error('device_io_record_invalid_epoch');
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, serializeDeviceIoRecord(record), 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  // Windows はディレクトリを開いて fsync できないため、rename までとする。
  if (process.platform !== 'win32') {
    const fd = openSync(directory, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
