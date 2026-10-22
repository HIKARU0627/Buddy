import assert from 'node:assert/strict';
import test from 'node:test';
import { parseControlRequest } from './control-protocol.js';
import { StrictJsonError, parseStrictJson } from './strict-json.js';

const ID = '3f0c8a52-6d1e-4b7a-9c2d-0e5f1a2b3c4d';
const bytes = (text: string) => new TextEncoder().encode(text);
const reason = (text: string | Uint8Array) => {
  const result = parseControlRequest(
    typeof text === 'string' ? bytes(text) : text,
  );
  return result.ok ? 'accepted' : result.reason;
};

test('accepts exactly status and stop with a lowercase UUID request_id', () => {
  assert.deepEqual(
    parseControlRequest(bytes(`{"op":"status","request_id":"${ID}"}`)),
    {
      ok: true,
      request: { op: 'status', request_id: ID },
    },
  );
  assert.deepEqual(
    parseControlRequest(
      bytes(` { "request_id" : "${ID}" , "op" : "stop" } \r`),
    ),
    { ok: true, request: { op: 'stop', request_id: ID } },
  );
});

test('rejects unknown ops, extra or missing fields, wrong types, and malformed JSON', () => {
  const cases: ReadonlyArray<[string, string]> = [
    [`{"op":"restart","request_id":"${ID}"}`, 'unknown_op'],
    [`{"op":"STATUS","request_id":"${ID}"}`, 'unknown_op'],
    [`{"op":"status","request_id":"${ID}","body":"x"}`, 'unknown_field'],
    [`{"__proto__":{},"op":"status","request_id":"${ID}"}`, 'unknown_field'],
    ['{"op":"status"}', 'missing_field'],
    [`{"request_id":"${ID}"}`, 'missing_field'],
    [`{"op":1,"request_id":"${ID}"}`, 'invalid_type'],
    ['{"op":"status","request_id":null}', 'invalid_type'],
    ['{"op":"status","request_id":"not-a-uuid"}', 'invalid_request_id'],
    [
      `{"op":"status","request_id":"${ID.toUpperCase()}"}`,
      'invalid_request_id',
    ],
    [`{"op":"status","op":"status","request_id":"${ID}"}`, 'duplicate_key'],
    [
      `{"op":"status","request_id":"${ID}","request_id":"${ID}"}`,
      'duplicate_key',
    ],
    ['{"op":', 'invalid_json'],
    [`{"op":"status","request_id":"${ID}",}`, 'invalid_json'],
    [`{"op":"status","request_id":"${ID}"} {}`, 'invalid_json'],
    [`{'op':'status'}`, 'invalid_json'],
    [`{"op":"\\ud800","request_id":"${ID}"}`, 'invalid_json'],
    ['', 'invalid_json'],
    ['[]', 'not_object'],
    ['"status"', 'not_object'],
    ['null', 'not_object'],
  ];
  for (const [text, expected] of cases)
    assert.equal(reason(text), expected, text);
  assert.equal(reason(new Uint8Array([0x7b, 0xff, 0x7d])), 'invalid_utf8');
});

test('the 4 KiB line limit is inclusive', () => {
  const base = `{"op":"status","request_id":"${ID}"}`;
  assert.equal(reason(base + ' '.repeat(4096 - base.length)), 'accepted');
  assert.equal(reason(base + ' '.repeat(4097 - base.length)), 'too_large');
  assert.equal(reason('a'.repeat(100_000)), 'too_large');
});

test('strict JSON parser rejects duplicates at any depth and deep nesting', () => {
  // オブジェクトは原型を持たないので、内容を JSON 文字列で比べる。
  assert.equal(
    JSON.stringify(parseStrictJson('{"a":[1,-2.5e3,true,null,"\\u00e9"]}')),
    '{"a":[1,-2500,true,null,"é"]}',
  );
  assert.equal(
    Object.getPrototypeOf(parseStrictJson('{"__proto__":{"x":1}}')),
    null,
  );
  const code = (text: string) => {
    try {
      parseStrictJson(text);
      return 'ok';
    } catch (error) {
      return error instanceof StrictJsonError ? error.code : 'other';
    }
  };
  assert.equal(code('{"a":{"b":1,"b":2}}'), 'duplicate_key');
  assert.equal(code(`${'['.repeat(17)}${']'.repeat(17)}`), 'too_deep');
  assert.equal(code(`${'['.repeat(16)}${']'.repeat(16)}`), 'ok');
  assert.equal(code('01'), 'invalid_json');
  assert.equal(code('1e999'), 'invalid_json');
  assert.equal(code('"\\udc00"'), 'invalid_unicode');
  assert.equal(code('"\\ud83d\\ude00"'), 'ok');
  assert.equal(code('"a\tb"'), 'invalid_json');
});

// 本人の判断（2026-10-21）: 端末の一覧と失効（1 台目の復旧手段。ADR 0021）。承認の命令はない。
test('device_list and device_revoke are accepted strictly; device_id belongs to revoke only', () => {
  const DEVICE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
  assert.deepEqual(
    parseControlRequest(bytes(`{"op":"device_list","request_id":"${ID}"}`)),
    { ok: true, request: { op: 'device_list', request_id: ID } },
  );
  assert.deepEqual(
    parseControlRequest(
      bytes(
        `{"op":"device_revoke","request_id":"${ID}","device_id":"${DEVICE}"}`,
      ),
    ),
    {
      ok: true,
      request: { op: 'device_revoke', request_id: ID, device_id: DEVICE },
    },
  );
  const cases: ReadonlyArray<[string, string]> = [
    [`{"op":"device_revoke","request_id":"${ID}"}`, 'missing_field'],
    [
      `{"op":"device_revoke","request_id":"${ID}","device_id":1}`,
      'invalid_type',
    ],
    [
      `{"op":"device_revoke","request_id":"${ID}","device_id":"not-a-uuid"}`,
      'invalid_device_id',
    ],
    [
      `{"op":"device_revoke","request_id":"${ID}","device_id":"${DEVICE.toUpperCase()}"}`,
      'invalid_device_id',
    ],
    [
      `{"op":"device_list","request_id":"${ID}","device_id":"${DEVICE}"}`,
      'unknown_field',
    ],
    [
      `{"op":"status","request_id":"${ID}","device_id":"${DEVICE}"}`,
      'unknown_field',
    ],
    [
      `{"op":"device_revoke","request_id":"${ID}","device_id":"${DEVICE}","pairing_id":"${DEVICE}"}`,
      'unknown_field',
    ],
    [
      `{"op":"device_revoke","request_id":"${ID}","device_id":"${DEVICE}","device_id":"${DEVICE}"}`,
      'duplicate_key',
    ],
    // 承認・登録の命令は足していない。
    [`{"op":"device_approve","request_id":"${ID}"}`, 'unknown_op'],
    [`{"op":"pairing_approve","request_id":"${ID}"}`, 'unknown_op'],
  ];
  for (const [text, expected] of cases)
    assert.equal(reason(text), expected, text);
});
