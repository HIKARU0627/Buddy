// バックアップの暗号・スナップショット・封筒ファイル（ADR 0047・0055）。模擬だけ（実機の Mac mini・実際の鍵の復元は B15）。
// 期待値は手で書いた。HKDF の既知値は tests/fixtures/backup-restore-cases.json の crypto_known_values（Python の hmac・
// hashlib で RFC 5869 を別に実装して求めた値）から写し、node:crypto の独立した組み立てと照合する。
// 鍵・復旧キーは合成の値で、実データ・実鍵は使わない。

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  BACKUP_FILE_MAGIC,
  decryptBackupPayload,
  encodeBackupFile,
  encryptBackupPayload,
  listBackupFiles,
  readBackupFileHeader,
  readBackupPayload,
  recoveryCheckMatches,
  recoveryCheckValue,
  sha256Hex,
  takeBackupSnapshot,
  unwrapBackupKey,
  verifyBackupPayload,
  wrapBackupKey,
  writeBackupFileAtomic,
} from './index.js';
import type { BackupKeyWrapValue } from './index.js';
import {
  databasePath,
  openSeededDatabase,
  withTempDir,
} from './operation-test-support.js';

// ikm 0x00〜0x1f の復旧キー（tests/fixtures/backup-restore-cases.json の crypto_known_values）。
const RECOVERY_KEY = Buffer.from(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  'hex',
);
const RECOVERY_KEY_ID = '5a5a5a5a-5a5a-455a-8a5a-5a5a5a5a5a5a';
const BACKUP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MATERIAL = Buffer.from(
  '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f',
  'hex',
);

test('復旧キーの確認値は既知値（E2A14B25）で、打ち間違いを見分ける', () => {
  assert.equal(recoveryCheckValue(RECOVERY_KEY), 'E2A14B25');
  assert.equal(recoveryCheckMatches(RECOVERY_KEY, 'E2A14B25'), true);
  assert.equal(recoveryCheckMatches(RECOVERY_KEY, 'E2A14B26'), false);
  assert.equal(recoveryCheckMatches(RECOVERY_KEY, 'e2a14b25'), false);
  const other = Buffer.from(RECOVERY_KEY);
  flipBit(other, 31);
  assert.equal(recoveryCheckMatches(other, 'E2A14B25'), false);
});

test('鍵の包みは独立に組み立てた AES-GCM を開け、用途・鍵の ID・復旧キーを入れ替えると開けない', () => {
  // 既知値: purpose backup_file、key_id backup-file-v1、salt 0x00〜0x0f のときの包む鍵。
  const wrapKey = Buffer.from(
    '34a624797096932accd3126787d6a55c90f0db2d00ba5095b840ec27494b04e3',
    'hex',
  );
  const nonce = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaab', 'hex');
  const aad = Buffer.from(
    `buddy/backup/key-wrap/v1\0backup_file\0backup-file-v1\0${RECOVERY_KEY_ID}`,
    'ascii',
  );
  const cipher = createCipheriv('aes-256-gcm', wrapKey, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(MATERIAL), cipher.final()]);
  const wrap: BackupKeyWrapValue = {
    purpose: 'backup_file',
    key_id: 'backup-file-v1',
    recovery_key_id: RECOVERY_KEY_ID,
    kdf: {
      algorithm: 'hkdf-sha256',
      salt: Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex').toString(
        'base64',
      ),
    },
    cipher: 'aes-256-gcm',
    nonce: nonce.toString('base64'),
    wrapped_material: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
  assert.deepEqual(unwrapBackupKey(RECOVERY_KEY, wrap), MATERIAL);
  assert.equal(unwrapBackupKey(Buffer.alloc(32, 7), wrap), null);
  assert.equal(
    unwrapBackupKey(RECOVERY_KEY, { ...wrap, purpose: 'data_key' }),
    null,
  );
  assert.equal(
    unwrapBackupKey(RECOVERY_KEY, { ...wrap, key_id: 'backup-file-v2' }),
    null,
  );
  assert.equal(
    unwrapBackupKey(RECOVERY_KEY, {
      ...wrap,
      recovery_key_id: '5a5a5a5a-5a5a-455a-8a5a-5a5a5a5a5a5b',
    }),
    null,
  );
  const flipped = Buffer.from(ciphertext);
  flipBit(flipped, 0);
  assert.equal(
    unwrapBackupKey(RECOVERY_KEY, {
      ...wrap,
      wrapped_material: flipped.toString('base64'),
    }),
    null,
  );
});

test('wrapBackupKey は毎回別の salt・nonce で包み、同じ鍵に戻り、契約の形の文字列になる', () => {
  const input = {
    recoveryKey: RECOVERY_KEY,
    recoveryKeyId: RECOVERY_KEY_ID,
    purpose: 'ledger_hmac_key' as const,
    keyId: 'ledger-hmac-v1',
    material: MATERIAL,
  };
  const a = wrapBackupKey(input);
  const b = wrapBackupKey(input);
  assert.notEqual(a.kdf.salt, b.kdf.salt);
  assert.notEqual(a.nonce, b.nonce);
  assert.deepEqual(unwrapBackupKey(RECOVERY_KEY, a), MATERIAL);
  assert.deepEqual(unwrapBackupKey(RECOVERY_KEY, b), MATERIAL);
  // 契約の BackupKeyWrap の文字列の形（salt 16 バイト・nonce 12・鍵 32・tag 16 の base64）。
  assert.match(a.kdf.salt, /^[A-Za-z0-9+/]{22}==$/u);
  assert.match(a.nonce, /^[A-Za-z0-9+/]{16}$/u);
  assert.match(a.wrapped_material, /^[A-Za-z0-9+/]{43}=$/u);
  assert.match(a.tag, /^[A-Za-z0-9+/]{22}==$/u);
  assert.throws(() => wrapBackupKey({ ...input, material: Buffer.alloc(31) }));
  assert.throws(() =>
    wrapBackupKey({ ...input, recoveryKey: Buffer.alloc(31) }),
  );
});

const AAD_FIELDS = {
  backup_id: BACKUP_ID,
  created_at: '2031-03-01T00:00:00.000Z',
  store_generation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  db_schema_version: 12,
  forgetting_generation: '3',
  ledger_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  ledger_head_hash: 'ab'.repeat(32),
  excluded_tables: ['command_receipts', 'source_items'],
};

test('本体は封筒の欄・鍵・backup_id のどれかが違うと開けず、同じ平文でも毎回別の暗号文になる', () => {
  const plaintext = Buffer.from('synthetic sqlite bytes', 'utf8');
  const input = { key: MATERIAL, keyId: 'backup-file-v1', fields: AAD_FIELDS };
  const blob = encryptBackupPayload(input, plaintext);
  assert.equal(blob.length, 12 + plaintext.length + 16);
  assert.deepEqual(decryptBackupPayload(input, blob), plaintext);
  assert.notDeepEqual(blob, encryptBackupPayload(input, plaintext));
  const variants = [
    { ...input, key: randomBytes(32) },
    { ...input, keyId: 'backup-file-v2' },
    {
      ...input,
      fields: {
        ...AAD_FIELDS,
        backup_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc',
      },
    },
    {
      ...input,
      fields: { ...AAD_FIELDS, created_at: '2031-03-01T00:00:01.000Z' },
    },
    {
      ...input,
      fields: {
        ...AAD_FIELDS,
        store_generation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
      },
    },
    { ...input, fields: { ...AAD_FIELDS, db_schema_version: 13 } },
    { ...input, fields: { ...AAD_FIELDS, forgetting_generation: '2' } },
    {
      ...input,
      fields: {
        ...AAD_FIELDS,
        ledger_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccd',
      },
    },
    { ...input, fields: { ...AAD_FIELDS, ledger_head_hash: 'cd'.repeat(32) } },
    {
      ...input,
      fields: { ...AAD_FIELDS, excluded_tables: ['command_receipts'] },
    },
  ];
  for (const variant of variants)
    assert.equal(decryptBackupPayload(variant, blob), null);
  const tampered = Buffer.from(blob);
  flipBit(tampered, 20);
  assert.equal(decryptBackupPayload(input, tampered), null);
  assert.equal(decryptBackupPayload(input, blob.subarray(0, 27)), null);
});

test('封筒ファイル: 先頭の封筒だけ読め、本体の位置と長さを照合でき、同じ ID を上書きしない', async () => {
  await withTempDir(async (dir) => {
    const manifest = {
      schema: 'buddy.backup-manifest.v1',
      backup_id: BACKUP_ID,
    };
    const payload = Buffer.from(
      '0123456789abcdef0123456789abcdef0123456789ab',
      'utf8',
    );
    const bytes = encodeBackupFile(manifest, payload);
    assert.equal(bytes.toString('ascii', 0, 8), BACKUP_FILE_MAGIC);
    const target = await writeBackupFileAtomic(dir, BACKUP_ID, bytes);
    assert.equal(target, join(dir, `buddy-${BACKUP_ID}.buddybackup`));
    const header = await readBackupFileHeader(target);
    assert.ok(header.ok);
    assert.deepEqual(header.manifest, manifest);
    assert.equal(header.file_bytes, bytes.length);
    assert.deepEqual(
      await readBackupPayload(target, header.payload_offset, payload.length),
      payload,
    );
    // 長さが違えば本体として読まない。
    assert.equal(
      await readBackupPayload(
        target,
        header.payload_offset,
        payload.length - 1,
      ),
      null,
    );
    await assert.rejects(writeBackupFileAtomic(dir, BACKUP_ID, bytes), {
      message: 'backup_file_exists',
    });
    assert.deepEqual(await readFile(target), bytes);
    // 一覧は封筒の形のファイル名だけ。ほかのファイル・取り残された一時ファイルは区別する。
    await writeFile(join(dir, 'notes.txt'), 'x');
    await writeFile(join(dir, '.buddy-backup-leftover.tmp'), 'x');
    const listed = await listBackupFiles(dir);
    assert.deepEqual(
      listed.files.map((file) => file.backup_id),
      [BACKUP_ID],
    );
    assert.deepEqual(listed.temps, [join(dir, '.buddy-backup-leftover.tmp')]);
  });
});

test('封筒ファイルの先頭が壊れていれば理由を返し、読み込みで例外にならない', async () => {
  await withTempDir(async (dir) => {
    const write = async (name: string, bytes: Buffer): Promise<string> => {
      const path = join(dir, name);
      await writeFile(path, bytes);
      return path;
    };
    const good = encodeBackupFile({ a: 1 }, Buffer.alloc(8));
    const header = async (bytes: Buffer, name: string) =>
      readBackupFileHeader(await write(name, bytes));
    assert.deepEqual(await header(Buffer.alloc(0), 'a'), {
      ok: false,
      reason: 'truncated',
    });
    const badMagic = Buffer.from(good);
    badMagic[0] = 0x58;
    assert.deepEqual(await header(badMagic, 'b'), {
      ok: false,
      reason: 'magic_mismatch',
    });
    const hugeLength = Buffer.from(good);
    hugeLength.writeUInt32BE(0x7fffffff, 8);
    assert.deepEqual(await header(hugeLength, 'c'), {
      ok: false,
      reason: 'manifest_length_invalid',
    });
    assert.deepEqual(await header(good.subarray(0, 14), 'd'), {
      ok: false,
      reason: 'truncated',
    });
    const text = Buffer.from('not json!', 'utf8');
    const raw = Buffer.concat([
      good.subarray(0, 8),
      Buffer.alloc(4),
      text,
      Buffer.alloc(4),
    ]);
    raw.writeUInt32BE(text.length, 8);
    assert.deepEqual(await header(raw, 'e'), {
      ok: false,
      reason: 'manifest_not_json',
    });
    assert.deepEqual(await readBackupFileHeader(join(dir, 'missing')), {
      ok: false,
      reason: 'file_unreadable',
    });
  });
});

test('本体の検証: 長さと SHA-256 が封筒と一致するときだけ true（切り詰め・余分な末尾・書き換え・形の違う引数は false）', async () => {
  await withTempDir(async (dir) => {
    const payload = randomBytes(3 * 1024 * 1024 + 17);
    const sha = sha256Hex(payload);
    const bytes = encodeBackupFile({ a: 1 }, payload);
    const path = join(dir, 'file.buddybackup');
    await writeFile(path, bytes);
    const header = await readBackupFileHeader(path);
    assert.ok(header.ok);
    const offset = header.payload_offset;
    assert.equal(
      await verifyBackupPayload(path, offset, payload.length, sha),
      true,
    );
    // 封筒の値が違う。
    assert.equal(
      await verifyBackupPayload(path, offset, payload.length - 1, sha),
      false,
    );
    assert.equal(
      await verifyBackupPayload(path, offset, payload.length, 'ab'.repeat(32)),
      false,
    );
    assert.equal(
      await verifyBackupPayload(path, offset + 1, payload.length, sha),
      false,
    );
    assert.equal(
      await verifyBackupPayload(path, offset, payload.length, 'ABC'),
      false,
    );
    assert.equal(
      await verifyBackupPayload(path, -1, payload.length, sha),
      false,
    );
    assert.equal(await verifyBackupPayload(path, offset, 1.5, sha), false);
    assert.equal(
      await verifyBackupPayload(
        join(dir, 'absent'),
        offset,
        payload.length,
        sha,
      ),
      false,
    );
    // ファイルの側が壊れている。
    await writeFile(path, bytes.subarray(0, bytes.length - 1));
    assert.equal(
      await verifyBackupPayload(path, offset, payload.length, sha),
      false,
    );
    await writeFile(path, Buffer.concat([bytes, Buffer.from('x')]));
    assert.equal(
      await verifyBackupPayload(path, offset, payload.length, sha),
      false,
    );
    const flipped = Buffer.from(bytes);
    flipBit(flipped, bytes.length - 100);
    await writeFile(path, flipped);
    assert.equal(
      await verifyBackupPayload(path, offset, payload.length, sha),
      false,
    );
    // 本体が空でも、空の SHA-256 と一致すれば true。
    const empty = join(dir, 'empty.buddybackup');
    await writeFile(empty, encodeBackupFile({ a: 1 }, Buffer.alloc(0)));
    const emptyHeader = await readBackupFileHeader(empty);
    assert.ok(emptyHeader.ok);
    assert.equal(
      await verifyBackupPayload(
        empty,
        emptyHeader.payload_offset,
        0,
        sha256Hex(Buffer.alloc(0)),
      ),
      true,
    );
  });
});

// --- スナップショット ---

const EXCLUDED_MARKER = 'EXCLUDED-OWNER-BLOB-MARKER-0123456789';

test('スナップショットは含めない表とその暗号文を写しから消し、含める表は残し、稼働中の DB は変えない', async () => {
  await withTempDir(async (dir) => {
    const path = databasePath(dir);
    const db = openSeededDatabase(path);
    try {
      // 含めない表（command_scopes は SEED の接続範囲 c-1 から）に行がある。含める表（devices・connections）にも行がある。
      db.exec(
        "INSERT INTO command_scopes (command_scope_id, device_id, core_instance_id, issued_at, expires_at, revoked_at) VALUES ('scope-1', 'dev-1', 'core-1', 1000, 2000, NULL)",
      );
      const before = tableCounts(db, [
        'devices',
        'connections',
        'command_scopes',
        'sealed_blobs',
      ]);
      assert.equal(before['command_scopes'], 1);
      // 除外した表が持つ暗号文（owner_table = source_items）と、含める表の暗号文（owner_table = turns）。
      insertBlob(db, 'blob-excluded', 'source_items', EXCLUDED_MARKER);
      insertBlob(db, 'blob-included', 'turns', 'INCLUDED-OWNER-BLOB-MARKER');
      const result = await takeBackupSnapshot({
        sourcePath: path,
        workDir: join(dir, 'work'),
        // 写しを取った後に稼働中の DB へ書いても、写しには入らない。
        afterCopy: () =>
          db.exec(
            "INSERT INTO connections VALUES ('c-late', 'google', NULL, 'keystore:c-late', 'active', 'read_write', '[]', '{}', 1, 1)",
          ),
      });
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(result.excluded_tables, [
        'async_context_guards',
        'command_receipts',
        'command_scopes',
        'event_outbox',
        'home_network_reports',
        'pairing_claims',
        'pairing_sessions',
        'source_items',
        'sync_batches',
        'sync_staging',
      ]);
      assert.equal(result.excluded_blobs_removed, 1);
      assert.equal(result.facts.forgetting_generation, '0');
      assert.equal(result.facts.ledger_head_hash, '0'.repeat(64));
      assert.equal(result.facts.ledger_id, null);
      assert.equal(result.facts.recorded_ledger_key_id, null);
      assert.deepEqual(result.facts.db_blob_key_ids, ['k-test']);
      assert.equal(result.facts.db_schema_version, 12);
      // 写しは 1 つのファイルで、journal を残さない。
      assert.deepEqual(
        readdirSync(join(dir, 'work')).filter((name) =>
          name.includes('sqlite'),
        ),
        [result.path.split(/[\\/]/u).at(-1)],
      );
      assert.equal(existsSync(`${result.path}-wal`), false);
      // 写しの中身。
      const copy = openCopy(result.path);
      try {
        const counts = tableCounts(copy, [
          'devices',
          'connections',
          'command_scopes',
          'sealed_blobs',
        ]);
        assert.deepEqual(counts, {
          devices: 2,
          connections: 1,
          command_scopes: 0,
          sealed_blobs: 1,
        });
        // 除外した表は表として残る（復元した DB がそのまま動く）。
        assert.equal(
          copy
            .prepare(
              "SELECT count(*) FROM sqlite_schema WHERE name = 'source_items'",
            )
            .pluck()
            .get(),
          1,
        );
      } finally {
        copy.close();
      }
      // 除外した暗号文の内容は、空き領域にも残らない（ファイルの全バイトを探す）。
      const bytes = readFileSync(result.path);
      assert.equal(bytes.includes(Buffer.from(EXCLUDED_MARKER)), false);
      assert.equal(
        bytes.includes(Buffer.from('INCLUDED-OWNER-BLOB-MARKER')),
        true,
      );
      // 稼働中の DB は変わっていない（除外した行・暗号文が残り、遅れて足した行もある）。
      assert.deepEqual(
        tableCounts(db, [
          'devices',
          'connections',
          'command_scopes',
          'sealed_blobs',
        ]),
        { devices: 2, connections: 2, command_scopes: 1, sealed_blobs: 2 },
      );
    } finally {
      db.close();
    }
  });
});

test('スナップショットは未知の表がある DB と、台帳の連鎖が壊れた DB を取らない', async () => {
  await withTempDir(async (dir) => {
    const path = databasePath(dir);
    const db = openSeededDatabase(path);
    try {
      db.exec('CREATE TABLE zz_unknown_cache (id TEXT PRIMARY KEY) STRICT');
      const unknown = await takeBackupSnapshot({
        sourcePath: path,
        workDir: join(dir, 'work'),
      });
      assert.deepEqual(unknown, { ok: false, reasons: ['unknown_table'] });
      db.exec('DROP TABLE zz_unknown_cache');
      // 台帳の行の hash が、項目から計算し直した値と違う（書き換え）。
      db.exec(
        "INSERT INTO forget_ledger (forgetting_generation, entry_id, recorded_at, entry_hash, item_count) VALUES (1, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 1000, '" +
          'ab'.repeat(32) +
          "', 1)",
      );
      db.exec(
        "INSERT INTO forget_ledger_items (forgetting_generation, item_kind, item_id) VALUES (1, 'turn', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')",
      );
      const broken = await takeBackupSnapshot({
        sourcePath: path,
        workDir: join(dir, 'work'),
      });
      assert.equal(broken.ok, false);
      assert.deepEqual(broken.ok ? [] : broken.reasons, [
        'forget_ledger_hash_mismatch',
      ]);
      // 失敗した写しは作業用のディレクトリに残らない。
      assert.deepEqual(
        readdirSync(join(dir, 'work')).filter((name) =>
          name.startsWith('snapshot-'),
        ),
        [],
      );
    } finally {
      db.close();
    }
  });
});

test('ディレクトリを先に作る必要はなく、作業用のディレクトリは新しく作られる', async () => {
  await withTempDir(async (dir) => {
    const path = databasePath(dir);
    openSeededDatabase(path).close();
    const work = join(dir, 'a', 'b');
    await mkdir(join(dir, 'a'), { recursive: true });
    const result = await takeBackupSnapshot({
      sourcePath: path,
      workDir: work,
    });
    assert.ok(result.ok);
    assert.ok(result.bytes > 0);
    assert.equal(sha256Hex(readFileSync(result.path)).length, 64);
    writeFileSync(join(dir, 'unused'), '');
  });
});

function flipBit(buffer: Buffer, index: number): void {
  buffer.writeUInt8((buffer.readUInt8(index) ^ 1) & 0xff, index);
}

function openCopy(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

function tableCounts(
  db: Database.Database,
  tables: readonly string[],
): Record<string, number> {
  return Object.fromEntries(
    tables.map((table) => [
      table,
      db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number,
    ]),
  );
}

function insertBlob(
  db: Database.Database,
  id: string,
  ownerTable: string,
  marker: string,
): void {
  db.prepare(
    "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, 'turn_text', ?, ?, 0, 1, 'k-test', ?, ?, ?, 1000, NULL)",
  ).run(
    id,
    ownerTable,
    `owner-${id}`,
    randomBytes(12),
    Buffer.from(marker, 'utf8'),
    randomBytes(16),
  );
}
