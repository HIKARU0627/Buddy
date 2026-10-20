// AES-256-GCM を NIST CAVP の公開テストベクトル（独立した期待値）と照合する。
// 出典: NIST CAVP「GCM Test Vectors」gcmtestvectors.zip の gcmEncryptExtIV256.rsp・gcmDecrypt256.rsp
// （https://csrc.nist.gov/projects/cryptographic-algorithm-validation-program/cavp-testing-block-cipher-modes）。
// 値は fixtures/aes-256-gcm-cavp.json に .rsp からそのまま写した。期待値をこの実装で生成していない。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { aes256GcmDecrypt, aes256GcmEncrypt } from './aes-gcm.js';

interface CavpCase {
  readonly section: string;
  // NIST SP 800-38D の記号。K: 鍵、IV: 初期化ベクトル、P: 平文、A: 追加認証データ、C: 暗号文、T: 認証タグ。
  readonly K: string;
  readonly IV: string;
  readonly P?: string;
  readonly A: string;
  readonly C: string;
  readonly T: string;
  readonly fail?: boolean;
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../fixtures/aes-256-gcm-cavp.json', import.meta.url),
    'utf8',
  ),
) as {
  readonly source: { readonly publisher: string };
  readonly encrypt: { readonly cases: readonly CavpCase[] };
  readonly decrypt: { readonly cases: readonly CavpCase[] };
};
const hex = (value: string) => Buffer.from(value, 'hex');

test('fixture は NIST CAVP の鍵 256 ビット・IV 96 ビット・タグ 128 ビットの組', () => {
  assert.match(fixture.source.publisher, /NIST/u);
  const all = [...fixture.encrypt.cases, ...fixture.decrypt.cases];
  assert.ok(fixture.encrypt.cases.length >= 6);
  assert.ok(fixture.decrypt.cases.some((c) => c.fail === true));
  for (const c of all) {
    assert.match(c.section, /\[Keylen = 256\] \[IVlen = 96\]/u);
    assert.match(c.section, /\[Taglen = 128\]/u);
    assert.equal(hex(c.K).length, 32);
    assert.equal(hex(c.IV).length, 12);
    assert.equal(hex(c.T).length, 16);
  }
});

test('暗号化: 公開テストベクトルの暗号文・タグと一致する', () => {
  for (const c of fixture.encrypt.cases) {
    const { ciphertext, tag } = aes256GcmEncrypt(
      hex(c.K),
      hex(c.IV),
      hex(c.P ?? ''),
      hex(c.A),
    );
    assert.equal(ciphertext.toString('hex'), c.C, c.section);
    assert.equal(tag.toString('hex'), c.T, c.section);
  }
});

test('復号: 公開テストベクトルの平文を返し、FAIL の組は拒否する', () => {
  for (const c of [...fixture.encrypt.cases, ...fixture.decrypt.cases]) {
    const plaintext = aes256GcmDecrypt(
      hex(c.K),
      hex(c.IV),
      hex(c.C),
      hex(c.T),
      hex(c.A),
    );
    if (c.fail === true) assert.equal(plaintext, null, c.section);
    else assert.equal(plaintext?.toString('hex'), c.P ?? '', c.section);
  }
});

test('復号: テストベクトルの暗号文・タグ・nonce・AAD・鍵を 1 ビット変えると拒否する', () => {
  const c = fixture.encrypt.cases.find(
    (v) => (v.P ?? '').length > 0 && v.A.length > 0,
  );
  assert.ok(c);
  const flip = (value: string, byte = 0) => {
    const bytes = hex(value);
    bytes[byte] = (bytes[byte] ?? 0) ^ 0x01;
    return bytes;
  };
  const inputs = () => ({
    key: hex(c.K),
    iv: hex(c.IV),
    ct: hex(c.C),
    tag: hex(c.T),
    aad: hex(c.A),
  });
  const variants = [
    { ...inputs(), key: flip(c.K) },
    { ...inputs(), iv: flip(c.IV, 11) },
    { ...inputs(), ct: flip(c.C) },
    { ...inputs(), tag: flip(c.T, 15) },
    { ...inputs(), aad: flip(c.A) },
    { ...inputs(), aad: Buffer.concat([hex(c.A), Buffer.of(0)]) },
    { ...inputs(), ct: hex(c.C).subarray(1) },
  ];
  for (const v of variants)
    assert.equal(aes256GcmDecrypt(v.key, v.iv, v.ct, v.tag, v.aad), null);
});

test('鍵・nonce・タグの長さが違えば例外にし、メッセージに値を含めない', () => {
  const key = Buffer.alloc(32, 7);
  const nonce = Buffer.alloc(12, 9);
  const cases: [() => unknown, RegExp][] = [
    [
      () =>
        aes256GcmEncrypt(
          Buffer.alloc(16),
          nonce,
          Buffer.alloc(1),
          Buffer.alloc(0),
        ),
      /^key must be 32 bytes$/u,
    ],
    [
      () =>
        aes256GcmEncrypt(
          key,
          Buffer.alloc(16),
          Buffer.alloc(1),
          Buffer.alloc(0),
        ),
      /^nonce must be 12 bytes$/u,
    ],
    [
      () =>
        aes256GcmDecrypt(
          key,
          nonce,
          Buffer.alloc(1),
          Buffer.alloc(12),
          Buffer.alloc(0),
        ),
      /^tag must be 16 bytes$/u,
    ],
  ];
  for (const [run, message] of cases)
    assert.throws(run, (error: unknown) => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, message);
      return true;
    });
});
