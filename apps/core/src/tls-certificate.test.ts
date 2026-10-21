// 自己署名証明書と DER の符号化の試験（ADR 0020）。
// DER の期待値は X.690・RFC 5280 から手で書いたバイト列。証明書は検査対象とは別に node:crypto の
// X509Certificate で読み戻し、指紋の期待値は X509Certificate#fingerprint256（コロン区切りの大文字）から求める。

import assert from 'node:assert/strict';
import { X509Certificate, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  bitString,
  objectIdentifier,
  sequence,
  unsignedInteger,
  x509Time,
} from './der.js';
import {
  CERTIFICATE_NOT_AFTER,
  certificateFingerprint,
  certificateFromPem,
  certificateReasons,
  certificateToPem,
  createSelfSignedCertificate,
} from './tls-certificate.js';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

test(
  'DER primitives encode the X.690 forms used by the certificate',
  { timeout: 30_000 },
  () => {
    // ecdsa-with-SHA256（RFC 5758）。
    assert.equal(
      hex(objectIdentifier('1.2.840.10045.4.3.2')),
      '06082a8648ce3d040302',
    );
    // id-kp-serverAuth。
    assert.equal(
      hex(objectIdentifier('1.3.6.1.5.5.7.3.1')),
      '06082b06010505070301',
    );
    assert.equal(hex(unsignedInteger(Buffer.from([0x00, 0x7f]))), '02017f');
    // 先頭のビットが立つ値は 0x00 を前に置いて正の数にする。
    assert.equal(hex(unsignedInteger(Buffer.from([0x80]))), '02020080');
    assert.equal(hex(unsignedInteger(Buffer.from([0x00, 0x00]))), '020100');
    assert.equal(hex(bitString(Buffer.from([0x80]), 7)), '03020780');
    // 長さが 128 以上なら長形式（0x81 0x80）。
    const long = sequence(Buffer.alloc(128));
    assert.equal(hex(long.subarray(0, 3)), '308180');
    // 2049 年までは UTCTime、2050 年以降は GeneralizedTime（RFC 5280 §4.1.2.5）。
    assert.equal(
      x509Time(new Date(Date.UTC(2049, 11, 31, 23, 59, 59))).toString('latin1'),
      '\x17\x0d491231235959Z',
    );
    assert.equal(
      x509Time(new Date(Date.UTC(2050, 0, 1, 0, 0, 0))).toString('latin1'),
      '\x18\x0f20500101000000Z',
    );
    assert.equal(
      x509Time(CERTIFICATE_NOT_AFTER).toString('latin1'),
      '\x18\x0f99991231235959Z',
    );
    assert.throws(() => objectIdentifier('3.1'));
    assert.throws(() => objectIdentifier('1.40'));
  },
);

test(
  'the self-signed certificate reads back with X509Certificate and its fingerprint is the SHA-256 of the DER',
  { timeout: 30_000 },
  () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const now = new Date(Date.UTC(2030, 9, 5, 12, 0, 0));
    const der = createSelfSignedCertificate(privateKey, publicKey, { now });
    const certificate = new X509Certificate(der);
    assert(certificate.verify(publicKey));
    assert(certificate.checkPrivateKey(privateKey));
    assert.equal(certificate.subject, 'CN=Buddy Core');
    assert.equal(certificate.issuer, 'CN=Buddy Core');
    assert.equal(certificate.ca, false);
    assert.deepEqual(certificate.keyUsage, ['1.3.6.1.5.5.7.3.1']);
    assert.equal(certificate.subjectAltName, undefined);
    // 開始は 1 日前、期限は期限を定めない値。
    assert.equal(
      Date.parse(certificate.validFrom),
      Date.UTC(2030, 9, 4, 12, 0, 0),
    );
    assert.equal(
      Date.parse(certificate.validTo),
      Date.UTC(9999, 11, 31, 23, 59, 59),
    );
    assert.equal(
      certificate.publicKey.asymmetricKeyDetails?.namedCurve,
      'prime256v1',
    );
    // 証明書の DER を書き換えていない（読み戻した raw と同じ）。
    assert.equal(hex(certificate.raw), hex(der));
    // 指紋は X509Certificate の fingerprint256 と同じ値（小文字・区切りなし）。
    const expected = certificate.fingerprint256
      .replace(/:/gu, '')
      .toLowerCase();
    assert.match(expected, /^[0-9a-f]{64}$/u);
    assert.equal(certificateFingerprint(der), expected);
    assert.deepEqual(certificateReasons(der, privateKey, publicKey, now), []);
    // PEM への変換と読み戻し。
    const pem = certificateToPem(der);
    assert.equal(pem, certificate.toString());
    assert.equal(hex(certificateFromPem(pem) ?? Buffer.alloc(0)), hex(der));
    assert.equal(certificateFromPem('not a certificate'), null);
    // 同じ鍵でも作るたびに通し番号・署名が変わり、指紋が変わる（再作成は再登録を伴う）。
    const again = createSelfSignedCertificate(privateKey, publicKey, { now });
    assert.notEqual(certificateFingerprint(again), expected);
  },
);

test(
  'certificate checks reject another key, tampering and the validity window',
  { timeout: 30_000 },
  () => {
    const pair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const a = pair();
    const b = pair();
    const now = new Date(Date.UTC(2030, 9, 5));
    const der = createSelfSignedCertificate(a.privateKey, a.publicKey, { now });
    assert(
      certificateReasons(der, b.privateKey, b.publicKey, now).includes(
        'certificate_key_mismatch',
      ),
    );
    // 署名した鍵と証明書の公開鍵が違う（b の公開鍵を a の鍵で署名）。
    const forged = createSelfSignedCertificate(a.privateKey, b.publicKey, {
      now,
    });
    assert(
      certificateReasons(forged, b.privateKey, b.publicKey, now).includes(
        'certificate_signature_invalid',
      ),
    );
    // 通し番号の 1 バイトを書き換えると署名が合わない。
    const tampered = Buffer.from(der);
    // 版（[0] INTEGER 2）の直後の通し番号（INTEGER、16 バイト）。
    const marker = Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02, 0x02, 0x10]);
    assert(tampered.indexOf(marker) > 0);
    const serialAt = tampered.indexOf(marker) + marker.length;
    tampered[serialAt] = (tampered[serialAt] as number) ^ 0x01;
    assert(
      certificateReasons(tampered, a.privateKey, a.publicKey, now).includes(
        'certificate_signature_invalid',
      ),
    );
    assert.deepEqual(
      certificateReasons(Buffer.from('xx'), a.privateKey, a.publicKey, now),
      ['certificate_unreadable'],
    );
    // 端末の時計が開始より前なら、まだ有効でない。
    assert(
      certificateReasons(
        der,
        a.privateKey,
        a.publicKey,
        new Date(now.getTime() - 2 * 86_400_000),
      ).includes('certificate_not_yet_valid'),
    );
  },
);
