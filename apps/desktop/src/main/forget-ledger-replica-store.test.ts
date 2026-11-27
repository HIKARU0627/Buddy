// 端末の忘却台帳の複製のファイル（B06-07b-3、Issue #179、ADR 0182）。一時ディレクトリだけを使う。
// - 保存して読み直せる（再起動の後も複製が残る）・契約の ForgetLedgerReplica の形・元サービスの生の ID を書かない。
// - 読めない・形が違う・部分の複製・書き換え・head の食い違い・本文の欄・大きすぎるファイルは使わず（閉じた側）、消さない。
// - 書き込みは一時ファイル → fsync → rename。rename の前に止まっても元のファイルは壊れず、一時ファイルは残らない。
// - 退避は消さずに乱数の名前へ rename する（ファイル名に台帳の中身を入れない）。
// 台帳の連鎖は packages/storage の ledgerEntryHash（canonicalize の JCS。検査対象と別の実装）で作る。期待値は手で書いた。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ForgetLedgerChainEntry } from '@buddy/contracts';
import { ForgetLedgerSync } from '@buddy/client';
import type { LedgerReplicaChain } from '@buddy/client';
import { ledgerEntryHash } from '@buddy/storage';
import { createDesktopContract, loadContractSchema } from './contract.js';
import {
  FORGET_LEDGER_REPLICA_FILE,
  FORGET_LEDGER_REPLICA_MAX_BYTES,
  createReplicaFileStore,
  isSetAsideName,
  loadReplicaFile,
  setAsideReplicaFiles,
  sha256Hex,
} from './forget-ledger-replica-store.js';
import type { ReplicaFileStoreOptions } from './forget-ledger-replica-store.js';

const contract = createDesktopContract(loadContractSchema());
const valid = (name: string, value: unknown) => contract.valid(name, value);
const ZERO = '0'.repeat(64);
const LEDGER = 'a1a1a1a1-0000-4000-8000-00000000000a';
const DEVICE = 'd0000000-0000-4000-8000-00000000000d';
const NOW = new Date('2031-01-05T00:00:00.000Z');

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-ledger-replica-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

function chainOf(length: number, ledgerId = LEDGER): LedgerReplicaChain {
  const entries: ForgetLedgerChainEntry[] = [];
  let previous = ZERO;
  for (let generation = 1; generation <= length; generation += 1) {
    const entry = {
      schema: 'buddy.forget-ledger.v1' as const,
      entry_id: `e0000000-0000-4000-8000-${String(generation).padStart(12, '0')}`,
      forgetting_generation: String(generation),
      recorded_at: `2031-01-01T00:00:0${generation}.000Z`,
      forgotten: [
        {
          source_kind: 'memory' as const,
          source_id: `c0000000-0000-4000-8000-${String(generation).padStart(12, '0')}`,
        },
        {
          source_kind: 'source_item' as const,
          source_id_hmac: 'a7'.repeat(32),
        },
      ] as ForgetLedgerChainEntry['entry']['forgotten'],
      blocked_source_hmacs: ['b8'.repeat(32)],
      blocked_content_keys: [],
    };
    const hash = ledgerEntryHash(entry, previous);
    entries.push({ entry, previous_hash: previous, entry_hash: hash });
    previous = hash;
  }
  return { ledger_id: ledgerId, entries };
}

function storeAt(
  path: string,
  extra: Omit<
    Partial<ReplicaFileStoreOptions>,
    'path' | 'valid' | 'deviceId'
  > & {
    readonly deviceId?: string | null;
  } = {},
) {
  const { deviceId, ...rest } = extra;
  return createReplicaFileStore({
    path,
    valid,
    now: () => NOW,
    ...rest,
    deviceId: () => (deviceId === undefined ? DEVICE : deviceId),
  });
}

// 保存した複製の文（書き換えの試験の材料）。
async function savedText(dir: string, length: number): Promise<string> {
  const path = join(dir, FORGET_LEDGER_REPLICA_FILE);
  await storeAt(path).save(chainOf(length));
  return readFile(path, 'utf8');
}

test('a saved replica survives a restart as the same complete chain without raw source ids', async () => {
  await withDir(async (dir) => {
    const path = join(dir, FORGET_LEDGER_REPLICA_FILE);
    assert.deepEqual(await loadReplicaFile(path, valid), { kind: 'missing' });
    await storeAt(path).save(chainOf(2));
    await storeAt(path).save(chainOf(3));
    // 再起動: 新しい読み込みで、最後に保存した世代 3 までの全体が戻る。
    const loaded = await loadReplicaFile(path, valid);
    assert.equal(loaded.kind, 'loaded');
    assert(loaded.kind === 'loaded');
    assert.equal(loaded.chain.ledger_id, LEDGER);
    assert.equal(loaded.chain.entries.length, 3);
    assert.equal(loaded.device_id, DEVICE);
    assert.deepEqual(loaded.chain.entries, chainOf(3).entries);
    const text = await readFile(path, 'utf8');
    const value = JSON.parse(text) as Record<string, unknown>;
    assert(valid('ForgetLedgerReplica', value));
    assert.equal(value['schema'], 'buddy.forget-ledger-replica.v1');
    assert.equal(value['device_id'], DEVICE);
    assert.equal(value['replicated_at'], '2031-01-05T00:00:00.000Z');
    const ledger = value['ledger'] as Record<string, unknown>;
    assert.deepEqual(ledger['head'], {
      forgetting_generation: '3',
      entry_hash: chainOf(3).entries[2]?.entry_hash,
    });
    // 元情報は HMAC だけ。一時ファイルは残らない。
    assert(!/source_id"\s*:\s*"mail/u.test(text));
    assert.deepEqual((await readdir(dir)).sort(), [FORGET_LEDGER_REPLICA_FILE]);
    if (process.platform !== 'win32')
      assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test('unreadable, malformed, partial or rewritten replicas are not used and are left in place', async () => {
  await withDir(async (dir) => {
    const path = join(dir, FORGET_LEDGER_REPLICA_FILE);
    const good = await savedText(dir, 3);
    const parsed = () =>
      JSON.parse(good) as {
        ledger: {
          entries: ForgetLedgerChainEntry[];
          head: { forgetting_generation: string; entry_hash: string };
        };
      } & Record<string, unknown>;
    const variants: [string, string | Buffer][] = [
      ['garbage', 'not json'],
      ['empty', ''],
      ['invalid utf-8', Buffer.from([0x7b, 0xff, 0xfe, 0x7d])],
      ['other schema', JSON.stringify({ io_epoch: '1', stop_scope: 'none' })],
      [
        'partial copy without generation 1',
        (() => {
          const value = parsed();
          value.ledger.entries = value.ledger.entries.slice(1);
          return JSON.stringify(value);
        })(),
      ],
      [
        'entry rewritten with the old hash',
        (() => {
          const value = parsed();
          (
            value.ledger.entries[1] as ForgetLedgerChainEntry
          ).entry.recorded_at = '2031-06-01T00:00:00.000Z';
          return JSON.stringify(value);
        })(),
      ],
      [
        'head hides the last generation',
        (() => {
          const value = parsed();
          value.ledger.head = {
            forgetting_generation: '2',
            entry_hash: (value.ledger.entries[1] as ForgetLedgerChainEntry)
              .entry_hash,
          };
          return JSON.stringify(value);
        })(),
      ],
      [
        'body field in an entry',
        (() => {
          const value = parsed();
          (
            (value.ledger.entries[0] as ForgetLedgerChainEntry)
              .entry as unknown as Record<string, unknown>
          )['text'] = '合成の本文';
          return JSON.stringify(value);
        })(),
      ],
      [
        'raw source id in place of the hmac',
        good.replace('a7'.repeat(32), 'mail-synthetic-001'),
      ],
    ];
    for (const [label, content] of variants) {
      await writeFile(path, content);
      assert.deepEqual(
        await loadReplicaFile(path, valid),
        { kind: 'unreadable' },
        label,
      );
      // 読んでも消さない・書き換えない。
      assert.deepEqual(
        await readFile(path),
        Buffer.isBuffer(content) ? content : Buffer.from(content),
        label,
      );
    }
    // 大きすぎるファイルは読まない（壊れたファイルと区別し、退避も置き換えもさせない）。
    const handle = await open(path, 'w');
    await handle.truncate(FORGET_LEDGER_REPLICA_MAX_BYTES + 1);
    await handle.close();
    assert.deepEqual(await loadReplicaFile(path, valid), {
      kind: 'too_large',
    });
    assert.equal((await stat(path)).size, FORGET_LEDGER_REPLICA_MAX_BYTES + 1);
    // ファイルでない（ディレクトリ）: 中身が壊れたのではないので、退避も置き換えもさせない。
    await rm(path);
    await mkdir(path);
    assert.deepEqual(await loadReplicaFile(path, valid), {
      kind: 'transient',
    });
  });
});

test('a write stopped before the rename keeps the previous replica and leaves no temporary file', async () => {
  await withDir(async (dir) => {
    const path = join(dir, FORGET_LEDGER_REPLICA_FILE);
    await storeAt(path).save(chainOf(1));
    const before = await readFile(path, 'utf8');
    await assert.rejects(
      storeAt(path, {
        beforeRename: () => {
          throw new Error('synthetic_stop');
        },
      }).save(chainOf(2)),
      /synthetic_stop/u,
    );
    assert.equal(await readFile(path, 'utf8'), before);
    assert.deepEqual(await readdir(dir), [FORGET_LEDGER_REPLICA_FILE]);
    // 取り残された一時ファイル（強制終了）は、読み込みのときに消し、正規のファイルを使う。
    const stale = join(dir, '.forget-ledger-replica-0000.tmp');
    await writeFile(stale, '{"schema":');
    const loaded = await loadReplicaFile(path, valid);
    assert(loaded.kind === 'loaded');
    assert.equal(loaded.chain.entries.length, 1);
    assert.deepEqual(await readdir(dir), [FORGET_LEDGER_REPLICA_FILE]);
  });
});

test('replace sets the current file aside under a random name without changing it', async () => {
  await withDir(async (dir) => {
    const path = join(dir, FORGET_LEDGER_REPLICA_FILE);
    await writeFile(path, 'broken replica');
    await storeAt(path).replace(
      chainOf(2, 'b2b2b2b2-0000-4000-8000-00000000000b'),
    );
    const aside = await setAsideReplicaFiles(path);
    assert.equal(aside.length, 1);
    assert(isSetAsideName(aside[0] ?? ''));
    assert.equal(await readFile(aside[0] ?? '', 'utf8'), 'broken replica');
    const loaded = await loadReplicaFile(path, valid);
    assert(loaded.kind === 'loaded');
    assert.equal(
      loaded.chain.ledger_id,
      'b2b2b2b2-0000-4000-8000-00000000000b',
    );
    // 2 回目の退避は 1 回目を上書きしない。
    const previous = await readFile(path, 'utf8');
    await storeAt(path).replace(chainOf(1));
    const both = await setAsideReplicaFiles(path);
    assert.equal(both.length, 2);
    const contents = await Promise.all(
      both.map((file) => readFile(file, 'utf8')),
    );
    assert.deepEqual(contents.sort(), ['broken replica', previous].sort());
    // ファイルがなければ退避せずに書く。
    await rm(path);
    await storeAt(path).replace(chainOf(1));
    assert.equal((await setAsideReplicaFiles(path)).length, 2);
  });
});

test('nothing is written without the device id or with an empty chain', async () => {
  await withDir(async (dir) => {
    const path = join(dir, FORGET_LEDGER_REPLICA_FILE);
    await assert.rejects(
      storeAt(path, { deviceId: null }).save(chainOf(1)),
      /forget_ledger_replica_unbuildable/u,
    );
    await assert.rejects(
      storeAt(path).save({ ledger_id: null, entries: [] }),
      /forget_ledger_replica_unbuildable/u,
    );
    assert.deepEqual(await readdir(dir), []);
  });
});

// ---- 見直しの追加（ADR 0182 の追記）----

const OTHER_LEDGER = 'b2b2b2b2-0000-4000-8000-00000000000b';
const OTHER_DEVICE = 'd0000000-0000-4000-8000-0000000000ee';
const noWait = () => Promise.resolve();

const fsError = (code: string): Error =>
  Object.assign(new Error(`synthetic ${code}`), { code });

// 中枢の応答（手で組む）。from は端末が持つ世代。
function entriesDelta(core: LedgerReplicaChain, from: number) {
  return {
    schema: 'buddy.forget-ledger-delta.v1',
    outcome: 'entries',
    ledger_id: core.ledger_id,
    head: {
      forgetting_generation: String(core.entries.length),
      entry_hash: core.entries.at(-1)?.entry_hash ?? ZERO,
    },
    entries: core.entries.slice(from),
    has_more: false,
  };
}

test('a transient read error leaves a sound replica in place and does not roll the head back', async () => {
  await withDir(async (dir) => {
    const path = join(dir, FORGET_LEDGER_REPLICA_FILE);
    await storeAt(path).save(chainOf(3));
    const before = await readFile(path);
    for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EMFILE'])
      assert.deepEqual(
        await loadReplicaFile(path, valid, {
          openRead: () => Promise.reject(fsError(code)),
        }),
        { kind: 'transient' },
        code,
      );
    // 1 回目の読み込みだけ EBUSY（ウイルス対策ソフトが開いている）。中枢は世代 1 に戻されている。
    let failures = 1;
    const sent: string[] = [];
    const core = chainOf(1);
    const sync = new ForgetLedgerSync({
      store: storeAt(path, {
        ops: {
          openRead: (file) => {
            failures -= 1;
            return failures >= 0
              ? Promise.reject(fsError('EBUSY'))
              : open(file, 'r');
          },
        },
      }),
      request: (body) => {
        sent.push(body.forgetting_generation);
        return Promise.resolve({
          kind: 'response',
          status: 200,
          body:
            body.forgetting_generation === '0'
              ? entriesDelta(core, 0)
              : {
                  ...entriesDelta(core, 0),
                  outcome: 'replica_ahead',
                  entries: [],
                },
        });
      },
      valid,
      sha256: sha256Hex,
      deviceId: () => DEVICE,
    });
    // その同期では送らず、保存も退避もしない。
    await sync.connected();
    assert.deepEqual(sent, []);
    assert.equal(sync.state.issue, 'replica_unavailable');
    assert.equal(sync.state.replace_pending, false);
    // 次の同期で読み直し、世代 3 を送る（世代 0 から取り直して中枢の短い台帳で置き換えない）。
    await sync.connected();
    assert.deepEqual(sent, ['3']);
    assert.equal(sync.state.issue, 'replica_ahead');
    assert.deepEqual(await readFile(path), before);
    assert.deepEqual(await setAsideReplicaFiles(path), []);
  });
});

test('replace keeps the replica file present before and after the rename', async () => {
  await withDir(async (dir) => {
    const path = join(dir, FORGET_LEDGER_REPLICA_FILE);
    await storeAt(path).save(chainOf(2));
    const old = await readFile(path, 'utf8');
    // 各操作の直前に、保存先のファイルがあるか。
    const present: string[] = [];
    const exists = async (step: string) => {
      present.push(`${step}:${(await readFile(path, 'utf8')) === old}`);
    };
    // rename の前で止まる: 保存先は前の中身のまま。この置き換えで作った退避と一時ファイルは残さない。
    await assert.rejects(
      storeAt(path, {
        ops: {
          link: async (from, to) => {
            await exists('link');
            await link(from, to);
          },
        },
        beforeRename: async () => {
          await exists('before_rename');
          const aside = await setAsideReplicaFiles(path);
          assert.equal(aside.length, 1);
          assert.equal(await readFile(aside[0] ?? '', 'utf8'), old);
          throw new Error('synthetic_stop');
        },
      }).replace(chainOf(1, OTHER_LEDGER)),
      /synthetic_stop/u,
    );
    assert.deepEqual(present, ['link:true', 'before_rename:true']);
    assert.equal(await readFile(path, 'utf8'), old);
    assert.deepEqual(await readdir(dir), [FORGET_LEDGER_REPLICA_FILE]);
    // rename の後で止まる: 保存先は新しい中身、退避は前の中身。
    await assert.rejects(
      storeAt(path, {
        ops: {
          rename: async (from, to) => {
            await exists('rename');
            await rename(from, to);
          },
        },
        afterRename: () => {
          throw new Error('synthetic_after');
        },
      }).replace(chainOf(1, OTHER_LEDGER)),
      /synthetic_after/u,
    );
    assert.deepEqual(present, [
      'link:true',
      'before_rename:true',
      'rename:true',
    ]);
    const loaded = await loadReplicaFile(path, valid);
    assert(loaded.kind === 'loaded');
    assert.equal(loaded.chain.ledger_id, OTHER_LEDGER);
    const aside = await setAsideReplicaFiles(path);
    assert.equal(aside.length, 1);
    assert.equal(await readFile(aside[0] ?? '', 'utf8'), old);
    assert.equal((await readdir(dir)).length, 2);
  });
});

test('replace copies the file aside when a hard link fails and gives up when neither works', async () => {
  await withDir(async (dir) => {
    const path = join(dir, FORGET_LEDGER_REPLICA_FILE);
    await storeAt(path).save(chainOf(2));
    const old = await readFile(path, 'utf8');
    const waits: number[] = [];
    let busy = 2;
    // ハードリンクができない（別のファイルシステム）・写しは 2 回 EBUSY の後に成功する。
    assert.equal(
      await storeAt(path, {
        ops: {
          link: () => Promise.reject(fsError('EXDEV')),
          copyFile: (from, to, mode) => {
            busy -= 1;
            return busy >= 0
              ? Promise.reject(fsError('EBUSY'))
              : copyFile(from, to, mode);
          },
        },
        wait: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      }).replace(chainOf(1, OTHER_LEDGER)),
      'saved',
    );
    assert.deepEqual(waits, [50, 100]);
    const aside = await setAsideReplicaFiles(path);
    assert.equal(aside.length, 1);
    assert.equal(await readFile(aside[0] ?? '', 'utf8'), old);
    const current = await readFile(path, 'utf8');
    assert.notEqual(current, old);
    // ハードリンクも写しもできない: 置き換えを諦め、今のファイル・前の退避はそのまま、一時ファイルも残さない。
    await assert.rejects(
      storeAt(path, {
        ops: {
          link: () => Promise.reject(fsError('EPERM')),
          copyFile: () => Promise.reject(fsError('EIO')),
        },
        wait: noWait,
      }).replace(chainOf(2)),
      { code: 'EIO' },
    );
    assert.equal(await readFile(path, 'utf8'), current);
    assert.deepEqual(await setAsideReplicaFiles(path), aside);
    assert.equal((await readdir(dir)).length, 2);
  });
});

test('a rename failing with EPERM or EBUSY is retried five times and then reported as save_failed', async () => {
  await withDir(async (dir) => {
    const path = join(dir, FORGET_LEDGER_REPLICA_FILE);
    await storeAt(path).save(chainOf(1));
    const waits: number[] = [];
    const wait = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    let failures = 2;
    await storeAt(path, {
      ops: {
        rename: (from, to) => {
          failures -= 1;
          return failures >= 0
            ? Promise.reject(fsError('EPERM'))
            : rename(from, to);
        },
      },
      wait,
    }).save(chainOf(2));
    assert.deepEqual(waits, [50, 100]);
    const loaded = await loadReplicaFile(path, valid);
    assert(loaded.kind === 'loaded');
    assert.equal(loaded.chain.entries.length, 2);
    const before = await readFile(path);
    // 使い切る: 最初の 1 回と 5 回の繰り返しの後に失敗を返し、前のファイルのまま、一時ファイルは残らない。
    waits.length = 0;
    let attempts = 0;
    const alwaysBusy = () => {
      attempts += 1;
      return Promise.reject(fsError('EBUSY'));
    };
    await assert.rejects(
      storeAt(path, { ops: { rename: alwaysBusy }, wait }).save(chainOf(3)),
      { code: 'EBUSY' },
    );
    assert.equal(attempts, 6);
    assert.deepEqual(waits, [50, 100, 150, 200, 200]);
    assert.deepEqual(await readFile(path), before);
    assert.deepEqual(await readdir(dir), [FORGET_LEDGER_REPLICA_FILE]);
    // 繰り返さない失敗（ディスクがいっぱい）。
    waits.length = 0;
    attempts = 0;
    await assert.rejects(
      storeAt(path, {
        ops: {
          rename: () => {
            attempts += 1;
            return Promise.reject(fsError('ENOSPC'));
          },
        },
        wait,
      }).save(chainOf(3)),
      { code: 'ENOSPC' },
    );
    assert.equal(attempts, 1);
    assert.deepEqual(waits, []);
    // 同期: 繰り返しを使い切ると save_failed を残し、前の複製のまま。
    const sync = new ForgetLedgerSync({
      store: storeAt(path, { ops: { rename: alwaysBusy }, wait: noWait }),
      request: (body) =>
        Promise.resolve({
          kind: 'response',
          status: 200,
          body: entriesDelta(chainOf(4), Number(body.forgetting_generation)),
        }),
      valid,
      sha256: sha256Hex,
    });
    await sync.connected();
    assert.equal(sync.state.issue, 'save_failed');
    assert.equal(sync.state.head.forgetting_generation, '2');
    assert.deepEqual(await readFile(path), before);
    assert.deepEqual(await readdir(dir), [FORGET_LEDGER_REPLICA_FILE]);
  });
});

test('a replica over the size limit is neither written nor read nor set aside', async () => {
  await withDir(async (dir) => {
    const path = join(dir, FORGET_LEDGER_REPLICA_FILE);
    await storeAt(path).save(chainOf(1));
    // 上限を世代 1 の複製の大きさにする（世代 3 の複製は超える）。
    const limit = (await stat(path)).size;
    const small = storeAt(path, { maxBytes: limit });
    const before = await readFile(path);
    assert.equal(await small.save(chainOf(3)), 'too_large');
    assert.equal(await small.replace(chainOf(3, OTHER_LEDGER)), 'too_large');
    assert.deepEqual(await readFile(path), before);
    assert.deepEqual(await readdir(dir), [FORGET_LEDGER_REPLICA_FILE]);
    // 上限より大きいファイル（前の版が書いた・上限を下げた）は読まず、消さない。
    await storeAt(path).save(chainOf(3));
    const large = await readFile(path);
    assert.deepEqual(await small.load(), { kind: 'too_large' });
    assert.deepEqual(await readFile(path), large);
    assert.deepEqual(await setAsideReplicaFiles(path), []);
  });
});

test('a replica saved under another device id is set aside before the next save', async () => {
  await withDir(async (dir) => {
    const path = join(dir, FORGET_LEDGER_REPLICA_FILE);
    await storeAt(path).save(chainOf(2));
    const old = await readFile(path, 'utf8');
    const loaded = await loadReplicaFile(path, valid);
    assert(loaded.kind === 'loaded');
    assert.equal(loaded.device_id, DEVICE);
    // 登録し直した端末（別の端末 ID）。連鎖はそのまま使い（世代 2 を送る）、次の保存の前に前のファイルを退避する。
    const sent: string[] = [];
    const logs: string[] = [];
    const sync = new ForgetLedgerSync({
      store: storeAt(path, { deviceId: OTHER_DEVICE }),
      request: (body) => {
        sent.push(body.forgetting_generation);
        return Promise.resolve({
          kind: 'response',
          status: 200,
          body: entriesDelta(chainOf(3), Number(body.forgetting_generation)),
        });
      },
      valid,
      sha256: sha256Hex,
      log: (code) => logs.push(code),
      deviceId: () => OTHER_DEVICE,
    });
    await sync.connected();
    assert.deepEqual(sent, ['2']);
    assert.deepEqual(logs, [
      'forget_ledger:replica_other_device',
      'forget_ledger:replica_set_aside',
    ]);
    const aside = await setAsideReplicaFiles(path);
    assert.equal(aside.length, 1);
    assert.equal(await readFile(aside[0] ?? '', 'utf8'), old);
    const value = JSON.parse(await readFile(path, 'utf8')) as {
      device_id: string;
      ledger: { head: { forgetting_generation: string } };
    };
    assert.equal(value.device_id, OTHER_DEVICE);
    assert.equal(value.ledger.head.forgetting_generation, '3');
  });
});

test('set-aside files stop at eight without removing older ones', async () => {
  await withDir(async (dir) => {
    const path = join(dir, FORGET_LEDGER_REPLICA_FILE);
    await storeAt(path).save(chainOf(1));
    const before = await readFile(path);
    const older: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      older.push(`older set-aside ${index}`);
      await writeFile(
        join(dir, `forget-ledger-replica.set-aside-${randomUUID()}.json`),
        `older set-aside ${index}`,
      );
    }
    // 上限: 新しく退避せず、置き換えもしない。
    assert.equal(
      await storeAt(path).replace(chainOf(2, OTHER_LEDGER)),
      'set_aside_limit',
    );
    assert.deepEqual(await readFile(path), before);
    const aside = await setAsideReplicaFiles(path);
    assert.equal(aside.length, 8);
    assert.deepEqual(
      (await Promise.all(aside.map((file) => readFile(file, 'utf8')))).sort(),
      older.sort(),
    );
    assert.equal((await readdir(dir)).length, 9);
    // 保存先のファイルがなければ、退避する物がないので書く。
    await rm(path);
    assert.equal(
      await storeAt(path).replace(chainOf(2, OTHER_LEDGER)),
      'saved',
    );
    assert.equal((await setAsideReplicaFiles(path)).length, 8);
  });
});
