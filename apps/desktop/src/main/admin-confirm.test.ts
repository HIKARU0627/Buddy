// 承認・拒否・失効の OS の確認ダイアログの文言の試験（本人の判断 2026-10-22、ADR 0026）。期待値は手で書く。
import assert from 'node:assert/strict';
import test from 'node:test';
import { adminConfirmText, displayText } from './admin-confirm.js';

const at = new Date(2030, 9, 1, 9, 5, 7).toISOString();

test('the confirmation shows the device name, OS, time and claim check, with cancel first', () => {
  const text = adminConfirmText({
    action: 'approve',
    deviceName: '合成の端末',
    platform: 'windows',
    claimCheck: '0a1b2c3d',
    at,
  });
  assert.equal(
    text.message,
    '「合成の端末」（Windows・10/1 09:05:07 の申請）を承認しますか',
  );
  assert.match(text.detail, /^確認コード: 0a1b 2c3d\n\n/u);
  assert.match(text.detail, /8 桁すべて同じときだけ承認してください。/u);
  // 0 番（既定・取り消し）は「やめる」。
  assert.deepEqual(text.buttons, ['やめる', '承認する']);
  assert.deepEqual(
    adminConfirmText({
      action: 'revoke',
      deviceName: '合成の端末',
      platform: 'macos',
      claimCheck: null,
      at,
    }).buttons,
    ['やめる', '失効する'],
  );
  assert.equal(
    adminConfirmText({
      action: 'reject',
      deviceName: '合成の端末',
      platform: 'linux',
      claimCheck: '0a1b2c3d',
      at,
    }).buttons[1],
    '拒否する',
  );
});

test('control and direction characters from the self-reported name are removed and long names are cut', () => {
  assert.equal(displayText('合成\u0000の\n端末\u202e'), '合成 の 端末');
  assert.equal(displayText('\u200b\ufeff名前\u2066'), '名前');
  assert.equal(displayText('あ'.repeat(70)), `${'あ'.repeat(60)}…`);
  const text = adminConfirmText({
    action: 'approve',
    deviceName: '\u202e悪意の名前\u0007',
    platform: 'unknown\u0000os',
    claimCheck: '0a1b2c3d',
    at,
  });
  assert.equal(
    text.message,
    '「悪意の名前」（unknown os・10/1 09:05:07 の申請）を承認しますか',
  );
});
