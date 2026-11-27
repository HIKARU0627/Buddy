// 本人が選んだレシートの写真のファイルを読む（ADR 0177 の追補、見直しの指摘 7(b)）。Electron に依存しない（node:test で
// 試験する）。
//
// - 開く前にパスを stat で確かめ、ふつうのファイルでなければ開かない（名前付きパイプ（FIFO）・装置を開くと、open が
//   書き手が現れるまで返らないため。再見直しの指摘 3）。POSIX では O_NONBLOCK で開き、確かめた後にパイプへ差し替わって
//   も open で止まらない（Windows では使えないので付けない）。
// - 開いたファイルを fstat で確かめ、開く前の stat と dev・ino が同じで、ふつうのファイルのときだけ読む（パスを stat して
//   から開く間にファイルが差し替わることを避ける）。
// - 上限を超えるファイルは読まずに 'too_large'。読むのは上限 +1 バイトまでで、上限を超えて読めたら（fstat の後に
//   大きくなった）読んだ分を 0 で埋めて 'too_large'。
// - 開けない・読む途中で失敗した・fstat の大きさと読めた大きさが違う（読む間に変わった）ときは、読んだ分を 0 で埋めて
//   'unreadable'。一時ファイルは作らず、パスと中身をログへ出さない。

import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';

export type ReceiptImageFileRead = Uint8Array | 'too_large' | 'unreadable';

/** ファイルの識別（装置と i ノードの番号）。 */
export interface ReceiptImageFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** 開いたファイルの操作（node:fs/promises の FileHandle の一部）。 */
export interface ReceiptImageFileHandle {
  // 開く前に stat で確かめたファイルの識別（開いた後の fstat と比べる）。
  readonly opened: ReceiptImageFileIdentity;
  readonly stat: () => Promise<
    ReceiptImageFileIdentity & {
      readonly size: number;
      readonly isFile: () => boolean;
    }
  >;
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

// 読むだけで開く。POSIX では O_NONBLOCK を付ける（ふつうのファイルの読み方は変わらない）。
const OPEN_FLAGS =
  process.platform === 'win32'
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NONBLOCK;

const openForRead: ReceiptImageFileOpener = async (path) => {
  const before = await stat(path, { bigint: true });
  if (!before.isFile()) throw new Error('not_a_file');
  const handle = await open(path, OPEN_FLAGS);
  return {
    opened: { dev: before.dev, ino: before.ino },
    stat: async () => {
      const info = await handle.stat({ bigint: true });
      return {
        dev: info.dev,
        ino: info.ino,
        size: Number(info.size),
        isFile: () => info.isFile(),
      };
    },
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
    // 開く前に確かめたファイルと同じ（差し替わっていない）ふつうのファイルだけを読む。
    if (
      !info.isFile() ||
      info.dev !== handle.opened.dev ||
      info.ino !== handle.opened.ino
    )
      return 'unreadable';
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
