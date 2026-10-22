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

// 自宅の登録・登録し直しの確認（B03-08）。伏せた値だけを出し、何と見比べるか・置き換え・Wi-Fi 名の確認の変化を書く。
const HOME = {
  action: 'register_home',
  replacing: false,
  macTail: '53:01',
  subnet: '192.0.2.0/24',
  includeSsid: true,
  ssidHint: { first: '合', length: 5 },
  ssidChange: null,
} as const;

test('the home registration confirmation shows only masked values and what to compare them with', () => {
  const text = adminConfirmText(HOME);
  assert.equal(text.title, '自宅の登録');
  assert.equal(text.message, 'このネットワークを自宅として登録しますか');
  assert.deepEqual(text.buttons, ['やめる', '登録する']);
  assert.match(
    text.detail,
    /^ルーターの MAC アドレス（最後の 2 組）: ··:··:··:··:53:01\n/u,
  );
  assert.match(
    text.detail,
    /ルーターのラベルや管理画面の MAC アドレスの、最後の 2 組と同じかを確かめてください。/u,
  );
  assert.match(text.detail, /\nサブネット: 192\.0\.2\.0\/24\n/u);
  assert.match(text.detail, /Wi-Fi 名（SSID）: 確かめる（合····・5 文字）/u);
  assert.match(text.detail, /Tailscale で直接つながっているときだけ/u);
  assert.doesNotMatch(text.detail, /置き換わり|登録し直すと|確かめず/u);
});

test('without the Wi-Fi name the confirmation says it is not sent and what is still checked', () => {
  const text = adminConfirmText({
    ...HOME,
    includeSsid: false,
    ssidHint: null,
  });
  assert.match(
    text.detail,
    /Wi-Fi 名（SSID）: 確かめない（Wi-Fi 名は送りません）/u,
  );
  assert.match(
    text.detail,
    /Wi-Fi 名は確かめず、ルーターの MAC アドレス・サブネット・Tailscale の直接経路で判定します。/u,
  );
  assert.doesNotMatch(text.detail, /合/u);
});

test('re-registering warns about the replacement and a change of the Wi-Fi check', () => {
  const removed = adminConfirmText({
    ...HOME,
    replacing: true,
    includeSsid: false,
    ssidHint: null,
    ssidChange: 'removed',
  });
  assert.equal(removed.title, '自宅の登録し直し');
  assert.equal(removed.message, '自宅の登録を今のネットワークで置き換えますか');
  assert.deepEqual(removed.buttons, ['やめる', '登録し直す']);
  assert.match(removed.detail, /登録し直すと、Wi-Fi 名は確かめなくなります。/u);
  assert.match(
    removed.detail,
    /今の登録は置き換わり、元に戻せません。前のネットワークにいる端末は接続できなくなります。$/u,
  );
  const added = adminConfirmText({
    ...HOME,
    replacing: true,
    ssidChange: 'added',
  });
  assert.match(
    added.detail,
    /登録し直すと、Wi-Fi 名も確かめるようになります（Wi-Fi 名の違う端末は接続できなくなります）。/u,
  );
});
