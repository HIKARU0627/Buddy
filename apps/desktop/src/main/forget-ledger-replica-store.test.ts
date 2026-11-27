// 端末の忘却台帳の複製のファイル（B06-07b-3、Issue #179、ADR 0182）。一時ディレクトリだけを使う。
// - 保存して読み直せる（再起動の後も複製が残る）・契約の ForgetLedgerReplica の形・元サービスの生の ID を書かない。
// - 読めない・形が違う・部分の複製・書き換え・head の食い違い・本文の欄・大きすぎるファイルは使わず（閉じた側）、消さない。
// - 書き込みは一時ファイル → fsync → rename。rename の前に止まっても元のファイルは壊れず、一時ファイルは残らない。
// - 退避は消さずに乱数の名前へ rename する（ファイル名に台帳の中身を入れない）。
// 台帳の連鎖は packages/storage の ledgerEntryHash（canonicalize の JCS。検査対象と別の実装）で作る。期待値は手で書いた。
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ForgetLedgerChainEntry } from '@buddy/contracts';
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
} from './forget-ledger-replica-store.js';

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
  extra: {
    readonly deviceId?: string | null;
    readonly beforeRename?: () => void;
  } = {},
) {
  return createReplicaFileStore({
    path,
    valid,
    deviceId: () => (extra.deviceId === undefined ? DEVICE : extra.deviceId),
    now: () => NOW,
    ...(extra.beforeRename === undefined
      ? {}
      : { beforeRename: extra.beforeRename }),
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
    // 大きすぎるファイルは読まない。
    const handle = await open(path, 'w');
    await handle.truncate(FORGET_LEDGER_REPLICA_MAX_BYTES + 1);
    await handle.close();
    assert.deepEqual(await loadReplicaFile(path, valid), {
      kind: 'unreadable',
    });
    // ファイルでない（ディレクトリ）。
    await rm(path);
    await mkdir(path);
    assert.deepEqual(await loadReplicaFile(path, valid), {
      kind: 'unreadable',
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
