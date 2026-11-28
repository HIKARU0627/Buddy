// 気づきの OS 通知とトレイの件数の表示の規則（ADR 0073・0196）。期待値は手で書いた文と真偽。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANDIDATE_ALERT_TITLE,
  candidateAlertAllowed,
  candidateAlertBody,
  candidateTrayTitle,
  candidateTrayTooltip,
} from './candidate-alert.js';

test('the OS notification is a fixed sentence with the number only', () => {
  assert.equal(CANDIDATE_ALERT_TITLE, 'Buddy');
  assert.equal(candidateAlertBody(1), '新しい気づきが 1 件あります');
  assert.equal(candidateAlertBody(12), '新しい気づきが 12 件あります');
});

test('an alert is shown only for one or more, while unlocked and while no window is in front', () => {
  const allowed = (
    count: number,
    lockState: 'unlocked' | 'locked' | 'unknown',
    appFocused: boolean,
  ) => candidateAlertAllowed({ count, lockState, appFocused });
  assert.equal(allowed(1, 'unlocked', false), true);
  assert.equal(allowed(1000, 'unlocked', false), true);
  // 0 件（件数が変わっただけ）・数でない値は出さない。
  assert.equal(allowed(0, 'unlocked', false), false);
  assert.equal(allowed(-1, 'unlocked', false), false);
  assert.equal(allowed(1.5, 'unlocked', false), false);
  assert.equal(allowed(Number.NaN, 'unlocked', false), false);
  // ロック中・ロック状態が分からないときは出さない。
  assert.equal(allowed(1, 'locked', false), false);
  assert.equal(allowed(1, 'unknown', false), false);
  // アプリが前面なら出さない（画面の気づきの欄で見える）。
  assert.equal(allowed(1, 'unlocked', true), false);
});

test('the tray shows the new count only when there is one to show', () => {
  assert.equal(candidateTrayTitle(null), '');
  assert.equal(candidateTrayTitle(0), '');
  assert.equal(candidateTrayTitle(3), ' 3');
  const base = 'Buddy（この端末の入出力: 受付中）';
  assert.equal(candidateTrayTooltip(base, null), base);
  assert.equal(
    candidateTrayTooltip(base, 0),
    'Buddy（この端末の入出力: 受付中）・新しい気づき 0 件',
  );
  assert.equal(
    candidateTrayTooltip(base, 3),
    'Buddy（この端末の入出力: 受付中）・新しい気づき 3 件',
  );
});
