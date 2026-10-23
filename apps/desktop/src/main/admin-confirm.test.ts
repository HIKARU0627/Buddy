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
    /^ルーターの MAC\u00a0アドレス（最後の\u00a02\u00a0組）: ··:··:··:··:53:01\n/u,
  );
  assert.match(
    text.detail,
    /ルーターのラベルや管理画面の MAC\u00a0アドレスの、最後の\u00a02\u00a0組と同じかを確かめてください。/u,
  );
  assert.match(text.detail, /\nサブネット: 192\.0\.2\.0\/24\n/u);
  assert.match(
    text.detail,
    /Wi-Fi 名（SSID）: 確かめる（合····・5\u00a0文字）/u,
  );
  assert.match(text.detail, /Tailscale で直接つながっているときだけ/u);
  assert.doesNotMatch(text.detail, /置き換わり|登録し直すと|確かめず/u);
  // 数字と単位の間に普通の空白を残さない（U+00A0）。
  assert.doesNotMatch(text.detail, /\d (?:組|文字)|MAC アドレス/u);
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
    /Wi-Fi 名は確かめず、ルーターの MAC\u00a0アドレス・サブネット・Tailscale の直接経路で判定します。/u,
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

test(
  "the operation confirmation shows the target and change from main's values, cleans control characters, and defaults to cancel",
  { timeout: 10_000 },
  () => {
    const text = adminConfirmText({
      action: 'approve_operation',
      operationKind: 'mail.draft.create',
      service: 'mock',
      target: 'mail-001',
      accountLabel: 'user@example.com',
      targetDetail: {
        subject: '来週の打ち合わせ',
        sender: 'sato@example.com',
        received_at: '2026-10-04T18:30:00+09:00',
      },
      fields: [
        { field: 'draft_to', values: ['a@example.com', 'b@example.com'] },
        { field: 'draft_subject', values: ['件名‮と\u0000制御'] },
        { field: 'draft_body', values: ['あ'.repeat(300)] },
      ],
    });
    assert.equal(text.title, '変更の承認');
    assert.equal(text.message, '「返信の下書きの作成」を承認しますか');
    assert.deepEqual(text.buttons, ['やめる', '承認する']);
    const lines = text.detail.split('\n');
    assert.deepEqual(lines.slice(0, 7), [
      '変更先: 模擬のメール',
      'アカウント: user@example.com',
      '対象の件名: 来週の打ち合わせ',
      '差出人: sato@example.com',
      '受信: 2026-10-04T18:30:00+09:00',
      '宛先: a@example.com、b@example.com',
      '件名: 件名 と 制御',
    ]);
    // 本文は先頭の 200 文字だけ（末尾に「…」）。
    assert.equal(lines[7], `本文: ${'あ'.repeat(200)}…`);
    assert.match(text.detail, /メールを送ることはありません。/u);
    assert.match(text.detail, /取り消せるのは、実行の前だけです。$/u);
    const task = adminConfirmText({
      action: 'approve_operation',
      operationKind: 'task.create',
      service: 'buddy',
      target: 'inbox',
      accountLabel: null,
      targetDetail: null,
      fields: [{ field: 'task_title', values: ['牛乳を買う'] }],
    });
    assert.equal(task.message, '「用事の登録」を承認しますか');
    assert.match(task.detail, /題名: 牛乳を買う/u);
    assert.match(task.detail, /Buddy の用事に登録します。/u);
  },
);

test(
  'the cancel and retry confirmations show the content and the current state, with cancel first',
  { timeout: 10_000 },
  () => {
    const retry = adminConfirmText({
      action: 'retry_operation',
      operationKind: 'task.create',
      headline: '牛乳を買う',
      detail: '期限 2030-10-06',
      state: 'not_executed',
    });
    assert.equal(retry.title, '操作の再試行');
    assert.equal(retry.message, '「用事の登録」をもう一度実行しますか');
    assert.deepEqual(retry.buttons, ['やめる', '再試行する']);
    assert.deepEqual(retry.detail.split('\n').slice(0, 4), [
      '操作: 用事の登録',
      '内容: 牛乳を買う',
      '補足: 期限 2030-10-06',
      '今の状態: 実行されませんでした',
    ]);
    assert.match(retry.detail, /同じ内容・同じ承認で、もう一度実行します。/u);
    const cancel = adminConfirmText({
      action: 'cancel_operation',
      operationKind: 'mail.labels.change',
      headline: null,
      detail: null,
      state: 'awaiting_approval',
    });
    assert.equal(cancel.title, '操作の取消');
    assert.deepEqual(cancel.buttons, ['やめる', '取り消す']);
    assert.match(cancel.detail, /今の状態: 承認待ち/u);
    assert.doesNotMatch(cancel.detail, /内容:/u);
  },
);

// 予算の確認（B07-05、ADR 0039）。値は main が中枢の利用状況から読んだもの（手での精算の実費・照合 ID は本人の入力）。
// 金額は通貨単位の百万分の一の整数で、合成の XTS。期待値は手で書く。
const xts = (amount: string) => ({ currency: 'XTS', amount });

test('the overage approval confirmation shows the request M, the remaining overage, the month and the limit, with cancel first', () => {
  const text = adminConfirmText({
    action: 'approve_overage',
    poolId: 'llm',
    budgetMonth: '2030-10',
    maxLiability: xts('40000000'),
    overageRemaining: xts('60000000'),
    expiresAt: new Date(2030, 9, 15, 9, 10, 0).toISOString(),
    actualGross: null,
    reconciliationId: null,
  });
  assert.equal(text.title, '超過枠の承認');
  assert.equal(
    text.message,
    'この依頼の最大負担 XTS 40.00 を、超過枠から使うことを承認しますか',
  );
  assert.equal(
    text.detail,
    [
      '枠: llm（2030-10）',
      '最大負担 M: XTS 40.00',
      '超過枠の残り: XTS 60.00',
      '承認の期限: 10/15 09:10:00',
      '',
      '承認は、この依頼と最大負担だけに使います。別の依頼や、より大きな負担には使えません。',
    ].join('\n'),
  );
  assert.deepEqual(text.buttons, ['やめる', '承認する']);
});

test('the overrun review confirmation shows the recorded actual cost, M and the part over M', () => {
  const text = adminConfirmText({
    action: 'review_overrun',
    poolId: 'llm.background',
    budgetMonth: '2030-10',
    maxLiability: xts('40000000'),
    overageRemaining: null,
    expiresAt: null,
    actualGross: xts('55000000'),
    reconciliationId: null,
  });
  assert.equal(text.title, 'M 超過の確認');
  assert.equal(
    text.detail,
    [
      '枠: llm.background（2030-10）',
      '記録した実費: XTS 55.00',
      '最大負担 M: XTS 40.00',
      '超過: XTS 15.00',
      '',
      '確認すると、この枠と下位の枠の新しい受付が再開します。実費と計上先は変わりません。',
    ].join('\n'),
  );
  assert.deepEqual(text.buttons, ['やめる', '確認した']);
});

test('the manual settlement confirmation shows the typed actual cost and reconciliation id, cleaned of control characters', () => {
  const text = adminConfirmText({
    action: 'settle_manual',
    poolId: 'llm',
    budgetMonth: '2030-09',
    maxLiability: xts('40000000'),
    overageRemaining: null,
    expiresAt: null,
    actualGross: xts('3500000'),
    reconciliationId: 'manual:invoice-a‮',
  });
  assert.equal(text.title, '不明な費用の精算');
  assert.equal(text.message, '不明な費用を XTS 3.50 で精算しますか');
  assert.equal(
    text.detail,
    [
      '枠: llm（2030-09）',
      '保持している最大負担 M: XTS 40.00',
      '入力した実費: XTS 3.50',
      '照合 ID: manual:invoice-a',
      '',
      '精算は一度だけで、元の月・元の枠に計上します。請求の照合で確かめた値だけを入力してください。',
    ].join('\n'),
  );
  assert.deepEqual(text.buttons, ['やめる', '精算する']);
});
