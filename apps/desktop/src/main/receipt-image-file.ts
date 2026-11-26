// 本人が選んだレシートの写真のファイルを読む（ADR 0177 の追補、見直しの指摘 7(b)）。Electron に依存しない（node:test で
// 試験する）。
//
// - 選んだパスを一度だけ開き、開いたファイルを fstat で確かめる（パスを stat してから読む間にファイルが差し替わる・
//   大きくなることを避ける）。ふつうのファイルでなければ読まない。
// - 上限を超えるファイルは読まずに 'too_large'。読むのは上限 +1 バイトまでで、上限を超えて読めたら（fstat の後に
//   大きくなった）読んだ分を 0 で埋めて 'too_large'。
// - 開けない・読む途中で失敗した・fstat の大きさと読めた大きさが違う（読む間に変わった）ときは、読んだ分を 0 で埋めて
//   'unreadable'。一時ファイルは作らず、パスと中身をログへ出さない。

import { open } from 'node:fs/promises';

export type ReceiptImageFileRead = Uint8Array | 'too_large' | 'unreadable';

/** 開いたファイルの操作（node:fs/promises の FileHandle の一部）。 */
export interface ReceiptImageFileHandle {
  readonly stat: () => Promise<{
    readonly size: number;
    readonly isFile: () => boolean;
  }>;
  readonly read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ readonly bytesRead: number }>;
  readonly close: () => Promise<void>;
}

export type ReceiptImageFileOpener = (
  path: string,
) => Promise<ReceiptImageFileHandle>;

const openForRead: ReceiptImageFileOpener = async (path) => {
  const handle = await open(path, 'r');
  return {
    stat: () => handle.stat(),
    read: (buffer, offset, length, position) =>
      handle.read(buffer, offset, length, position),
    close: () => handle.close(),
  };
};

/** 選んだファイルを上限（maxBytes）+1 バイトまで読む。 */
export async function readReceiptImageFile(
  path: string,
  maxBytes: number,
  opener: ReceiptImageFileOpener = openForRead,
): Promise<ReceiptImageFileRead> {
  let handle: ReceiptImageFileHandle;
  try {
    handle = await opener(path);
  } catch {
    return 'unreadable';
  }
  let buffer: Uint8Array | null = null;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return 'unreadable';
    if (info.size > maxBytes) return 'too_large';
    // fstat の大きさ +1 バイトまで（上限 +1 バイトを超えない）。読めた量が fstat の大きさより多ければ、読む間に大きく
    // なったので、上限を超えたかどうかで分ける。
    const capacity = Math.min(info.size, maxBytes) + 1;
    buffer = new Uint8Array(capacity);
    let total = 0;
    while (total < capacity) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        capacity - total,
        total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) {
      buffer.fill(0);
      return 'too_large';
    }
    if (total !== info.size) {
      buffer.fill(0);
      return 'unreadable';
    }
    const read = buffer.subarray(0, total);
    buffer = null;
    return read;
  } catch {
    buffer?.fill(0);
    return 'unreadable';
  } finally {
    await handle.close().catch(() => undefined);
  }
}
