// 本人のタイムゾーンの出所（端末の OS、ADR 0131）。読み取りを差し替えて、正規化・拒否・要求ごとの読み直しを
// 確かめる。期待値（IANA の名前・null）は手で書いた値。

import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceTimeZone } from './device-time-zone.js';

test('端末のタイムゾーンが正規の名前ならそのまま返す', () => {
  assert.equal(
    deviceTimeZone(() => 'Asia/Tokyo'),
    'Asia/Tokyo',
  );
});

test('旧別名は正規の名前にする', () => {
  assert.equal(
    deviceTimeZone(() => 'Japan'),
    'Asia/Tokyo',
  );
});

test('読み取れない（undefined）ときは null で、代替しない', () => {
  assert.equal(
    deviceTimeZone(() => undefined),
    null,
  );
});

test('読み取りが例外を投げたときは null', () => {
  assert.equal(
    deviceTimeZone(() => {
      throw new Error('読み取り失敗');
    }),
    null,
  );
});

test('存在しない名前は null', () => {
  assert.equal(
    deviceTimeZone(() => 'Mars/Olympus'),
    null,
  );
});

test('Etc/* は domain の方針で拒否して null', () => {
  assert.equal(
    deviceTimeZone(() => 'Etc/GMT+9'),
    null,
  );
});

test('要求ごとに読み直す', () => {
  const values = ['Asia/Tokyo', 'America/New_York'];
  let calls = 0;
  const read = () => values[calls++];
  assert.equal(deviceTimeZone(read), 'Asia/Tokyo');
  assert.equal(deviceTimeZone(read), 'America/New_York');
  assert.equal(calls, 2);
});

test('既定の読み取りは OS のタイムゾーン（TZ）を読む', () => {
  const original = process.env['TZ'];
  try {
    process.env['TZ'] = 'Asia/Tokyo';
    assert.equal(deviceTimeZone(), 'Asia/Tokyo');
    process.env['TZ'] = 'Invalid/Zone';
    assert.equal(deviceTimeZone(), null);
  } finally {
    if (original === undefined) delete process.env['TZ'];
    else process.env['TZ'] = original;
  }
});
