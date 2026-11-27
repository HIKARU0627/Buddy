// 本人が選んだレシートの写真のファイルを読む処理（ADR 0177 の追補、見直しの指摘 7(b)）の試験。ファイルは一時ディレクトリの
// 合成のバイト列で、本物の写真は使わない。読む間に大きくなるファイルは、模擬の開く口で作る。期待値は手で書いた。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { tempDir } from './hub-test-support.js';
import { readReceiptImageFile } from './receipt-image-file.js';
import type {
  ReceiptImageFileHandle,
  ReceiptImageFileOpener,
} from './receipt-image-file.js';

test('上限ちょうどまでは読み、上限を超えるファイルは読まない', async (t) => {
  const dir = await tempDir(t, 'bdrcpt-');
  const exact = join(dir, 'exact.jpg');
  await writeFile(exact, Buffer.alloc(16, 0x41));
  const read = await readReceiptImageFile(exact, 16);
  assert.ok(read instanceof Uint8Array);
  assert.equal(read.length, 16);
  assert.ok(read.every((byte) => byte === 0x41));
  const over = join(dir, 'over.jpg');
  await writeFile(over, Buffer.alloc(17, 0x41));
  assert.equal(await readReceiptImageFile(over, 16), 'too_large');
  // 開けない（ない・フォルダ）ものは読めないと返す。
  assert.equal(
    await readReceiptImageFile(join(dir, 'missing.jpg'), 16),
    'unreadable',
  );
  const folder = join(dir, 'folder.jpg');
  await mkdir(folder);
  assert.equal(await readReceiptImageFile(folder, 16), 'unreadable');
});

// 模擬のファイルの識別（開く前の stat と開いた後の fstat で同じ）。
const SAME = { dev: 1n, ino: 2n };

// 模擬の開く口。fstat の大きさは size、読むと content を返す（読む間に変わったファイル）。
function changing(
  size: number,
  content: Uint8Array,
  log: { requested: number; closed: number; buffers: Uint8Array[] },
): ReceiptImageFileOpener {
  return () => {
    const handle: ReceiptImageFileHandle = {
      opened: SAME,
      stat: () => Promise.resolve({ ...SAME, size, isFile: () => true }),
      read: (buffer, offset, length, position) => {
        log.requested += length;
        log.buffers.push(buffer);
        const part = content.subarray(position, position + length);
        buffer.set(part, offset);
        return Promise.resolve({ bytesRead: part.length });
      },
      close: () => {
        log.closed += 1;
        return Promise.resolve();
      },
    };
    return Promise.resolve(handle);
  };
}

test('fstat の後に大きくなったファイルは上限 +1 バイトまでしか読まず、読んだ分を 0 で埋める', async () => {
  // fstat では 16 バイト（上限ちょうど）、読むと 1 MiB ある。
  const grown = { requested: 0, closed: 0, buffers: [] as Uint8Array[] };
  const result = await readReceiptImageFile(
    'synthetic.jpg',
    16,
    changing(16, new Uint8Array(1024 * 1024).fill(0x42), grown),
  );
  assert.equal(result, 'too_large');
  assert.equal(grown.requested, 17);
  assert.ok(grown.buffers.every((buffer) => buffer.every((b) => b === 0)));
  assert.equal(grown.closed, 1);
  // fstat では 8 バイト、読むと 12 バイト（上限の内で変わった）: 読めないと返す。
  const changed = { requested: 0, closed: 0, buffers: [] as Uint8Array[] };
  assert.equal(
    await readReceiptImageFile(
      'synthetic.jpg',
      16,
      changing(8, new Uint8Array(12).fill(0x43), changed),
    ),
    'unreadable',
  );
  assert.equal(changed.requested, 9);
  assert.ok(changed.buffers.every((buffer) => buffer.every((b) => b === 0)));
  // fstat では 8 バイト、読むと 4 バイト（小さくなった）: 読めないと返す。
  const shrunk = { requested: 0, closed: 0, buffers: [] as Uint8Array[] };
  assert.equal(
    await readReceiptImageFile(
      'synthetic.jpg',
      16,
      changing(8, new Uint8Array(4).fill(0x44), shrunk),
    ),
    'unreadable',
  );
  assert.ok(shrunk.buffers.every((buffer) => buffer.every((b) => b === 0)));
  assert.equal(shrunk.closed, 1);
});

test('読む途中で失敗したら、読んだ分を 0 で埋めて読めないと返す', async () => {
  const buffers: Uint8Array[] = [];
  let closed = 0;
  const failing: ReceiptImageFileOpener = () =>
    Promise.resolve({
      opened: SAME,
      stat: () => Promise.resolve({ ...SAME, size: 8, isFile: () => true }),
      read: (buffer, offset) => {
        buffers.push(buffer);
        if (offset > 0) return Promise.reject(new Error('io'));
        buffer.fill(0x45, 0, 4);
        return Promise.resolve({ bytesRead: 4 });
      },
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    });
  assert.equal(
    await readReceiptImageFile('synthetic.jpg', 16, failing),
    'unreadable',
  );
  assert.ok(buffers.every((buffer) => buffer.every((b) => b === 0)));
  assert.equal(closed, 1);
});

// Windows では、ファイルの名前で名前付きパイプ（FIFO）を作れない（名前付きパイプはパイプ専用の名前空間にだけ作れ、mkfifo も
// ない）ため、この試験は POSIX（macOS・Linux）だけで行う。
test(
  '名前付きパイプ（FIFO）は開かずに読めないと返す（書き手を待って止まらない）',
  {
    skip:
      process.platform === 'win32'
        ? 'Windows ではファイルの名前で名前付きパイプを作れないため'
        : false,
    timeout: 20_000,
  },
  async (t) => {
    const dir = await tempDir(t, 'bdrfifo-');
    const fifo = join(dir, 'receipt.jpg');
    execFileSync('mkfifo', [fifo]);
    let timer: NodeJS.Timeout | undefined;
    const stuck = new Promise<'stuck'>((resolve) => {
      timer = setTimeout(() => resolve('stuck'), 5_000);
    });
    const result = await Promise.race([readReceiptImageFile(fifo, 16), stuck]);
    clearTimeout(timer);
    if (result === 'stuck') {
      // 開いてから確かめる形では、書き手が現れるまで open が返らない。試験の後始末のために書き手を開いて閉じる。
      const writer = await open(fifo, 'w');
      await writer.close();
    }
    assert.equal(result, 'unreadable');
  },
);

test('開く前に確かめたファイルと開いたファイルが違えば（差し替わった）読まない', async () => {
  const buffers: Uint8Array[] = [];
  let closed = 0;
  const opener =
    (identity: { dev: bigint; ino: bigint }): ReceiptImageFileOpener =>
    () =>
      Promise.resolve({
        opened: SAME,
        stat: () =>
          Promise.resolve({ ...identity, size: 8, isFile: () => true }),
        // 8 バイトのファイル（位置 8 から先は読めない）。
        read: (buffer, offset, _length, position) => {
          buffers.push(buffer);
          if (position >= 8) return Promise.resolve({ bytesRead: 0 });
          buffer.fill(0x46, offset, offset + 8);
          return Promise.resolve({ bytesRead: 8 });
        },
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      });
  // 開く前の stat の後に、別のファイル（i ノードの番号が違う）へ差し替わった。
  assert.equal(
    await readReceiptImageFile(
      'synthetic.jpg',
      16,
      opener({ dev: 1n, ino: 3n }),
    ),
    'unreadable',
  );
  // 装置の番号が違う（別のボリュームの同じ i ノードの番号）。
  assert.equal(
    await readReceiptImageFile(
      'synthetic.jpg',
      16,
      opener({ dev: 9n, ino: 2n }),
    ),
    'unreadable',
  );
  assert.equal(buffers.length, 0);
  assert.equal(closed, 2);
  // 同じなら読む。
  const same = await readReceiptImageFile('synthetic.jpg', 16, opener(SAME));
  assert.ok(same instanceof Uint8Array);
  assert.deepEqual([...same], new Array(8).fill(0x46));
  assert.equal(closed, 3);
});
