// バックアップの制御チャネルの操作の形の検査（ADR 0055）。復旧キーは制御チャネルを通さないので、鍵の値を持つ項目はない。

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseControlRequest } from './control-protocol.js';

const ID = '3f0c8a52-6d1e-4b7a-9c2d-0e5f1a2b3c4d';
const bytes = (text: string) => new TextEncoder().encode(text);
const reason = (text: string) => {
  const result = parseControlRequest(bytes(text));
  return result.ok ? 'accepted' : result.reason;
};

test('backup ops: three take no fields, and backup_setup_record takes only a key id', () => {
  for (const op of ['backup_status', 'backup_run', 'backup_setup_inspect'])
    assert.deepEqual(
      parseControlRequest(bytes(`{"op":"${op}","request_id":"${ID}"}`)),
      { ok: true, request: { op, request_id: ID } },
    );
  assert.deepEqual(
    parseControlRequest(
      bytes(
        `{"op":"backup_setup_record","request_id":"${ID}","ledger_hmac_key_id":"ledger-hmac-0123abcd"}`,
      ),
    ),
    {
      ok: true,
      request: {
        op: 'backup_setup_record',
        request_id: ID,
        ledger_hmac_key_id: 'ledger-hmac-0123abcd',
      },
    },
  );
  const cases: ReadonlyArray<[string, string]> = [
    [
      `{"op":"backup_run","request_id":"${ID}","directory":"/tmp"}`,
      'unknown_field',
    ],
    [
      `{"op":"backup_status","request_id":"${ID}","ledger_hmac_key_id":"a"}`,
      'unknown_field',
    ],
    [`{"op":"backup_setup_record","request_id":"${ID}"}`, 'missing_field'],
    [
      `{"op":"backup_setup_record","request_id":"${ID}","ledger_hmac_key_id":1}`,
      'invalid_type',
    ],
    [
      `{"op":"backup_setup_record","request_id":"${ID}","ledger_hmac_key_id":"Bad Id"}`,
      'invalid_key_id',
    ],
    [
      `{"op":"backup_setup_record","request_id":"${ID}","ledger_hmac_key_id":""}`,
      'invalid_key_id',
    ],
    [
      `{"op":"backup_setup_record","request_id":"${ID}","ledger_hmac_key_id":"${'a'.repeat(65)}"}`,
      'invalid_key_id',
    ],
    [
      `{"op":"backup_setup_record","request_id":"${ID}","ledger_hmac_key_id":"a","recovery_code":"x"}`,
      'unknown_field',
    ],
    // 復旧キーを運ぶ命令・復元の命令は足していない。
    [`{"op":"backup_setup","request_id":"${ID}"}`, 'unknown_op'],
    [`{"op":"backup_restore","request_id":"${ID}"}`, 'unknown_op'],
  ];
  for (const [text, expected] of cases)
    assert.equal(reason(text), expected, text);
});
