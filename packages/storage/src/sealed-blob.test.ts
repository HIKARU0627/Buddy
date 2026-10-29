// sealed_blobs の封筒の暗号化・復号。鍵は試験用の合成値で、実機の KeyStore には触れない。
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inspect } from 'node:util';
import type {
  DataKeyMaterial,
  DataKeyProvider,
  SealedBlobOwner,
  SealedEnvelope,
} from './sealed-blob.js';
import {
  openBlob,
  openWithDataKeyProvider,
  SEALED_BLOB_FORMAT_VERSION,
  SEALED_BLOB_PURPOSES,
  sealBlob,
  sealedBlobAad,
  sealWithDataKeyProvider,
} from './sealed-blob.js';

// 試験用の合成鍵（実データの鍵ではない）。
const dataKey: DataKeyMaterial = {
  keyId: 'data-key-v1',
  key: Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)),
};
const owner: SealedBlobOwner = {
  ownerTable: 'turns',
  ownerId: '0b6e7c1e-3f6a-4d8e-9a51-2f0c9d7b4e21',
  ownerVersion: 3,
  purpose: 'turn_text',
};
const plaintext = Buffer.from('合成の本文: 明日 9 時に資料を確認する', 'utf8');

function seal(
  input: Uint8Array = plaintext,
  target: SealedBlobOwner = owner,
  key: DataKeyMaterial = dataKey,
): SealedEnvelope {
  const result = sealBlob(key, input, target);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return result.envelope;
}

/** 長さ（4 バイトのビッグエンディアン）を手で書いた欄。 */
const lengthField = (length: number[], text: string) =>
  Buffer.concat([Buffer.from(length), Buffer.from(text, 'utf8')]);

test('追加認証データ: 形式版 1 のバイト列は長さ付きの 7 欄の連結', () => {
  const expected = Buffer.concat([
    lengthField([0, 0, 0, 0x12], 'buddy/sealed_blobs'),
    lengthField([0, 0, 0, 0x01], '1'),
    lengthField([0, 0, 0, 0x0b], 'data-key-v1'),
    lengthField([0, 0, 0, 0x05], 'turns'),
    lengthField([0, 0, 0, 0x03], 't-1'),
    lengthField([0, 0, 0, 0x01], '3'),
    lengthField([0, 0, 0, 0x09], 'turn_text'),
  ]);
  const aad = sealedBlobAad(
    {
      ownerTable: 'turns',
      ownerId: 't-1',
      ownerVersion: 3,
      purpose: 'turn_text',
    },
    1,
    'data-key-v1',
  );
  assert.equal(aad.toString('hex'), expected.toString('hex'));
  // 多バイト文字の ID は UTF-8 のバイト数を長さにする（「あ」は 3 バイト）。
  const multi = sealedBlobAad(
    {
      ownerTable: 'turns',
      ownerId: 'あ',
      ownerVersion: 0,
      purpose: 'turn_text',
    },
    1,
    'data-key-v1',
  );
  assert.ok(multi.includes(Buffer.from([0, 0, 0, 3, 0xe3, 0x81, 0x82])));
});

test('追加認証データ: 欄の境界をずらした値は別のバイト列になる', () => {
  const a = sealedBlobAad(
    { ownerTable: 'ab', ownerId: 'c', ownerVersion: 1, purpose: 'proposal' },
    1,
    'k1',
  );
  const b = sealedBlobAad(
    { ownerTable: 'a', ownerId: 'bc', ownerVersion: 1, purpose: 'proposal' },
    1,
    'k1',
  );
  const c = sealedBlobAad(
    { ownerTable: 'a', ownerId: 'b1', ownerVersion: 1, purpose: 'proposal' },
    1,
    'k1',
  );
  const d = sealedBlobAad(
    { ownerTable: 'a', ownerId: 'b', ownerVersion: 11, purpose: 'proposal' },
    1,
    'k1',
  );
  assert.equal(new Set([a, b, c, d].map((x) => x.toString('hex'))).size, 4);
});

test('暗号化した封筒は形式版・key_id・12 バイトの nonce・16 バイトのタグを分けて持ち、独立に組んだ AAD で AES-256-GCM として復号できる', () => {
  const envelope = seal();
  assert.equal(envelope.formatVersion, 1);
  assert.equal(SEALED_BLOB_FORMAT_VERSION, 1);
  assert.equal(envelope.keyId, 'data-key-v1');
  assert.equal(envelope.nonce.length, 12);
  assert.equal(envelope.tag.length, 16);
  // GCM の暗号文は平文と同じ長さで、平文をそのまま含まない。
  assert.equal(envelope.ciphertext.length, plaintext.length);
  assert.ok(!Buffer.from(envelope.ciphertext).equals(plaintext));

  // 実装の関数を使わずに、node:crypto で直接復号する（AAD は上の試験と同じ手書きの配置）。
  const aad = Buffer.concat([
    lengthField([0, 0, 0, 0x12], 'buddy/sealed_blobs'),
    lengthField([0, 0, 0, 0x01], '1'),
    lengthField([0, 0, 0, 0x0b], 'data-key-v1'),
    lengthField([0, 0, 0, 0x05], 'turns'),
    lengthField([0, 0, 0, 0x24], owner.ownerId),
    lengthField([0, 0, 0, 0x01], '3'),
    lengthField([0, 0, 0, 0x09], 'turn_text'),
  ]);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    dataKey.key,
    envelope.nonce,
    {
      authTagLength: 16,
    },
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(envelope.tag);
  const decrypted = Buffer.concat([
    decipher.update(envelope.ciphertext),
    decipher.final(),
  ]);
  assert.ok(decrypted.equals(plaintext));

  const opened = openBlob(dataKey, envelope, owner);
  assert.equal(opened.ok, true);
  if (opened.ok) assert.ok(opened.plaintext.equals(plaintext));
  // 空の平文も暗号化できる（タグで認証する）。
  const empty = seal(Buffer.alloc(0));
  assert.equal(empty.ciphertext.length, 0);
  const openedEmpty = openBlob(dataKey, empty, owner);
  assert.equal(openedEmpty.ok && openedEmpty.plaintext.length, 0);
});

test('nonce は呼び出しごとに異なり、同じ平文でも暗号文が異なる', () => {
  const nonces = new Set<string>();
  const ciphertexts = new Set<string>();
  const count = 2000;
  for (let i = 0; i < count; i += 1) {
    const envelope = seal();
    nonces.add(Buffer.from(envelope.nonce).toString('hex'));
    ciphertexts.add(Buffer.from(envelope.ciphertext).toString('hex'));
  }
  assert.equal(nonces.size, count);
  assert.equal(ciphertexts.size, count);
  // nonce は返したあとに書き換えても、次の暗号化に影響しない（使い回しのバッファでない）。
  const first = seal();
  const saved = Buffer.from(first.nonce);
  const second = seal();
  assert.ok(!Buffer.from(second.nonce).equals(saved));
});

test('別の行・別の版・別の用途・別の表への暗号文の差替えを検出する', () => {
  const envelope = seal();
  const others: SealedBlobOwner[] = [
    { ...owner, ownerId: '9d1f2a3b-4c5d-4e6f-8a7b-0c1d2e3f4a5b' },
    { ...owner, ownerVersion: 4 },
    { ...owner, ownerVersion: 2 },
    { ...owner, purpose: 'session_summary' },
    { ...owner, ownerTable: 'memories' },
  ];
  for (const other of others)
    assert.deepEqual(openBlob(dataKey, envelope, other), {
      ok: false,
      reason: 'authentication_failed',
    });
  // 別の行の正しい封筒と差し替えても検出する。
  const otherEnvelope = seal(Buffer.from('別の本文'), others[0]);
  assert.deepEqual(openBlob(dataKey, otherEnvelope, owner), {
    ok: false,
    reason: 'authentication_failed',
  });
});

test('暗号文・タグ・nonce の改ざんを検出し、平文を返さない', () => {
  const envelope = seal();
  const flip = (bytes: Uint8Array, index: number) => {
    const copy = Buffer.from(bytes);
    copy[index] = (copy[index] ?? 0) ^ 0x80;
    return copy;
  };
  const tampered: SealedEnvelope[] = [
    { ...envelope, ciphertext: flip(envelope.ciphertext, 0) },
    {
      ...envelope,
      ciphertext: flip(envelope.ciphertext, envelope.ciphertext.length - 1),
    },
    {
      ...envelope,
      ciphertext: Buffer.from(envelope.ciphertext).subarray(0, -1),
    },
    {
      ...envelope,
      ciphertext: Buffer.concat([envelope.ciphertext, Buffer.of(0)]),
    },
    { ...envelope, tag: flip(envelope.tag, 0) },
    { ...envelope, tag: flip(envelope.tag, 15) },
    { ...envelope, nonce: flip(envelope.nonce, 0) },
    { ...envelope, nonce: flip(envelope.nonce, 11) },
  ];
  for (const candidate of tampered) {
    const result = openBlob(dataKey, candidate, owner);
    assert.deepEqual(result, { ok: false, reason: 'authentication_failed' });
    assert.ok(!('plaintext' in result));
  }
});

test('鍵の取り違え・形式版の不一致・封筒の形の不正を区別できる理由で拒否する', () => {
  const envelope = seal();
  const otherKey: DataKeyMaterial = {
    keyId: 'data-key-v1',
    key: Buffer.alloc(32, 0x5a),
  };
  const cases: [DataKeyMaterial, SealedEnvelope, string][] = [
    // 同じ key_id で別の鍵（保護領域の鍵が入れ替わった）。
    [otherKey, envelope, 'authentication_failed'],
    // 別の key_id の鍵（鍵の取り違え）。
    [{ ...otherKey, keyId: 'data-key-v2' }, envelope, 'key_id_mismatch'],
    [dataKey, { ...envelope, keyId: 'data-key-v2' }, 'key_id_mismatch'],
    [dataKey, { ...envelope, formatVersion: 2 }, 'format_version_unsupported'],
    [dataKey, { ...envelope, formatVersion: 0 }, 'format_version_unsupported'],
    [dataKey, { ...envelope, nonce: Buffer.alloc(16) }, 'envelope_invalid'],
    [dataKey, { ...envelope, nonce: Buffer.alloc(11) }, 'envelope_invalid'],
    [dataKey, { ...envelope, tag: Buffer.alloc(12) }, 'envelope_invalid'],
    [
      dataKey,
      { ...envelope, ciphertext: 'abc' as unknown as Uint8Array },
      'envelope_invalid',
    ],
    [dataKey, null as unknown as SealedEnvelope, 'envelope_invalid'],
    [{ keyId: 'data-key-v1', key: Buffer.alloc(16) }, envelope, 'key_invalid'],
    [{ keyId: 'Bad Key', key: dataKey.key }, envelope, 'key_invalid'],
  ];
  for (const [key, candidate, reason] of cases)
    assert.deepEqual(openBlob(key, candidate, owner), { ok: false, reason });
  assert.deepEqual(
    openBlob(dataKey, envelope, { ...owner, ownerVersion: -1 }),
    { ok: false, reason: 'owner_invalid' },
  );
});

test('暗号化の入力の検査: 不正な鍵・key_id・所有者・平文は暗号化しない', () => {
  const cases: [DataKeyMaterial, unknown, SealedBlobOwner, string][] = [
    [
      { keyId: 'data-key-v1', key: Buffer.alloc(31) },
      plaintext,
      owner,
      'key_invalid',
    ],
    [
      { keyId: 'data-key-v1', key: 'x'.repeat(32) as unknown as Uint8Array },
      plaintext,
      owner,
      'key_invalid',
    ],
    [{ keyId: '', key: dataKey.key }, plaintext, owner, 'key_id_invalid'],
    [{ keyId: 'キー', key: dataKey.key }, plaintext, owner, 'key_id_invalid'],
    [dataKey, 'text', owner, 'plaintext_invalid'],
    [dataKey, plaintext, { ...owner, ownerTable: 'Turns' }, 'owner_invalid'],
    [dataKey, plaintext, { ...owner, ownerTable: '' }, 'owner_invalid'],
    [dataKey, plaintext, { ...owner, ownerId: '' }, 'owner_invalid'],
    [
      dataKey,
      plaintext,
      { ...owner, ownerId: 'x'.repeat(257) },
      'owner_invalid',
    ],
    [dataKey, plaintext, { ...owner, ownerId: '\ud800' }, 'owner_invalid'],
    [dataKey, plaintext, { ...owner, ownerVersion: 1.5 }, 'owner_invalid'],
    [dataKey, plaintext, { ...owner, ownerVersion: -1 }, 'owner_invalid'],
    [
      dataKey,
      plaintext,
      { ...owner, ownerVersion: Number.MAX_SAFE_INTEGER + 1 },
      'owner_invalid',
    ],
    [
      dataKey,
      plaintext,
      { ...owner, purpose: 'unknown' as SealedBlobOwner['purpose'] },
      'owner_invalid',
    ],
  ];
  for (const [key, input, target, reason] of cases)
    assert.deepEqual(sealBlob(key, input as Uint8Array, target), {
      ok: false,
      reason,
    });
  assert.throws(
    () => sealedBlobAad({ ...owner, ownerVersion: -1 }, 1, 'k'),
    RangeError,
  );
  assert.throws(() => sealedBlobAad(owner, 0, 'k'), RangeError);
  assert.throws(() => sealedBlobAad(owner, 1, 'K'), RangeError);
});

test('結果・例外に平文・鍵の値を含めない', () => {
  const envelope = seal();
  const results = [
    sealBlob({ ...dataKey, key: Buffer.alloc(8) }, plaintext, owner),
    openBlob(dataKey, { ...envelope, tag: Buffer.alloc(16) }, owner),
    openBlob(dataKey, envelope, { ...owner, ownerVersion: 9 }),
  ];
  const secrets = [
    plaintext.toString('hex'),
    plaintext.toString('utf8'),
    Buffer.from(dataKey.key).toString('hex'),
    Buffer.from(dataKey.key).toString('base64'),
  ];
  for (const result of results) {
    const text = `${JSON.stringify(result)} ${inspect(result, { depth: 5 })}`;
    for (const secret of secrets) assert.ok(!text.includes(secret));
  }
});

test('KeyStore から鍵を取得できなければ暗号化・復号をせず、平文に切り替えない', async () => {
  const envelope = seal();
  let calls = 0;
  const providers: [DataKeyProvider, string][] = [
    [
      {
        loadDataKey: () => {
          calls += 1;
          return Promise.resolve({ ok: false, reason: 'mock_unavailable' });
        },
      },
      'mock_unavailable',
    ],
    [
      {
        loadDataKey: () =>
          Promise.resolve({ ok: false, reason: 'keystore_read_failed' }),
      },
      'keystore_read_failed',
    ],
    [
      { loadDataKey: () => Promise.reject(new Error('boom')) },
      'provider_failed',
    ],
    [
      { loadDataKey: () => Promise.resolve(null as never) },
      'provider_result_invalid',
    ],
    [
      {
        loadDataKey: () =>
          Promise.resolve({ ok: false, reason: '/Users/synthetic\nKeychains' }),
      },
      'unknown',
    ],
  ];
  for (const [provider, detail] of providers) {
    const expected = { ok: false, reason: 'data_key_unavailable', detail };
    const sealed = await sealWithDataKeyProvider(provider, plaintext, owner);
    assert.deepEqual(sealed, expected);
    assert.ok(!('envelope' in sealed));
    const opened = await openWithDataKeyProvider(provider, envelope, owner);
    assert.deepEqual(opened, expected);
    assert.ok(!('plaintext' in opened));
  }
  assert.equal(calls, 2);

  // 鍵を取得できれば暗号化・復号する。
  const available: DataKeyProvider = {
    loadDataKey: () => Promise.resolve({ ok: true, dataKey }),
  };
  const sealed = await sealWithDataKeyProvider(available, plaintext, owner);
  assert.equal(sealed.ok, true);
  if (!sealed.ok || !('envelope' in sealed)) throw new Error('unreachable');
  const opened = await openWithDataKeyProvider(
    available,
    sealed.envelope,
    owner,
  );
  assert.equal(opened.ok, true);
  if (opened.ok) assert.ok(opened.plaintext.equals(plaintext));
});

test('用途の一覧は、最後に sealed_blobs を作ったマイグレーション（0011）の purpose の CHECK と一致する', () => {
  // 0011 で task_content を足して表を作り直した（ADR 0051）。0001 の一覧に task_content だけを足したもの。
  const sql = readFileSync(
    new URL('../migrations/0011_operation_body_retention.sql', import.meta.url),
    'utf8',
  );
  const original = readFileSync(
    new URL('../migrations/0001_initial.sql', import.meta.url),
    'utf8',
  );
  assert.match(
    original,
    /'connection_account', 'request_summary', 'proposal'\)\),/u,
  );
  const table = /CREATE TABLE sealed_blobs \(([\s\S]*?)\) STRICT;/u.exec(
    sql,
  )?.[1];
  assert.ok(table);
  const check =
    /purpose TEXT NOT NULL CHECK \(purpose IN \(([\s\S]*?)\)\)/u.exec(
      table,
    )?.[1];
  assert.ok(check);
  const purposes = [...check.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]);
  assert.deepEqual([...SEALED_BLOB_PURPOSES].sort(), purposes.sort());
  // nonce・tag の長さの CHECK も封筒の形と一致する。
  assert.match(table, /nonce BLOB NOT NULL CHECK \(length\(nonce\) = 12\)/u);
  assert.match(table, /tag BLOB NOT NULL CHECK \(length\(tag\) = 16\)/u);
});
