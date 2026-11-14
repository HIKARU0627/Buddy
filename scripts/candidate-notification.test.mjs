import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  candidateAlertDecision,
  candidateIntakeDecision,
  notificationKey,
  notificationKeyMaterial,
} from '../packages/domain/dist/index.js';

// B11-02 P3: 通知の識別子と重複排除（ADR 0117、設計 04 通知の重複と再通知、設計 11 §4、QA12）。
// 材料の文字列は手で書いた。ハッシュの値は材料の文字列から別に計算して埋めた。
const sha256 = (material) =>
  createHash('sha256').update(material).digest('hex');
const HEADER = 'buddy.notification-key.v1';

const mail = (over = {}) => ({
  kind: 'mail_reply',
  source_account_id: 'acct-1',
  request_entity_id: 'req-1',
  request_revision: '2',
  due: { kind: 'date', date: '2030-10-07', original_text: '10月7日まで' },
  ...over,
});
const overlap = (over = {}) => ({
  kind: 'schedule_overlap',
  event_refs: ['id:cal-b/ev-2', 'id:cal-a/ev-1'],
  period: {
    kind: 'timed',
    start: '2030-10-09T01:30:00Z',
    end: '2030-10-09T02:00:00Z',
  },
  ...over,
});
const research = (over = {}) => ({
  kind: 'research_done',
  workflow_id: 'wf-1',
  completion_version: '1',
  ...over,
});

test('the key material is fixed for each kind and the hash is the 64 digit SHA-256', () => {
  assert.equal(
    notificationKeyMaterial(mail()),
    [
      HEADER,
      'kind=mail_reply',
      'source_account_id=acct-1',
      'request_entity_id=req-1',
      'request_revision=2',
      'due=date:2030-10-07',
    ].join('\n'),
  );
  assert.equal(
    notificationKey(mail(), sha256),
    '8c4e310b65a9515aff0aac38da0aa454a70456556be1c222c2d5ce65bec96f66',
  );
  // 予定の参照は昇順に並べて材料にする。
  assert.equal(
    notificationKeyMaterial(overlap()),
    [
      HEADER,
      'kind=schedule_overlap',
      'event_refs=["id:cal-a/ev-1","id:cal-b/ev-2"]',
      'period=timed:2030-10-09T01:30:00Z/2030-10-09T02:00:00Z',
    ].join('\n'),
  );
  assert.equal(
    notificationKey(overlap(), sha256),
    '9326a725708b047cb7041128ca462bd14668440ff51e4c7919938a30cd79a8fb',
  );
  assert.equal(
    notificationKeyMaterial(research()),
    [
      HEADER,
      'kind=research_done',
      'workflow_id=wf-1',
      'completion_version=1',
    ].join('\n'),
  );
  assert.equal(
    notificationKey(research(), sha256),
    'f87a71dade4c7cdfaf5637b3ce1c5a4fe988fe2fa3fd04ee63222dee3224548f',
  );
});

test('the same meaning gives the same key, whatever order or wording it arrives in', () => {
  const base = notificationKey(mail(), sha256);
  // 期限の原文（本文の言い回し）は材料にしない。
  assert.equal(
    notificationKey(
      mail({
        due: { kind: 'date', date: '2030-10-07', original_text: '来週の月曜' },
      }),
      sha256,
    ),
    base,
  );
  // 種類が同じメールの候補でも kind が違えば別の識別子。
  assert.notEqual(
    notificationKey(mail({ kind: 'mail_deadline' }), sha256),
    base,
  );
  // 時刻付きの期限は、秒の有無で変わらない。
  const instant = (local) => ({
    kind: 'instant',
    local_datetime: local,
    zone: 'Asia/Tokyo',
    original_text: 'x',
  });
  assert.equal(
    notificationKey(mail({ due: instant('2030-10-07T17:00') }), sha256),
    notificationKey(mail({ due: instant('2030-10-07T17:00:00') }), sha256),
  );
  // 参照の並びや重複の入力順で変わらない。
  assert.equal(
    notificationKey(
      overlap({ event_refs: ['id:cal-a/ev-1', 'id:cal-b/ev-2'] }),
      sha256,
    ),
    notificationKey(overlap(), sha256),
  );
});

test('a meaningful change gives another key', () => {
  const base = notificationKey(mail(), sha256);
  const others = [
    mail({ request_revision: '3' }), // 依頼の版が上がった（期限の訂正）
    mail({ request_entity_id: 'req-2' }),
    mail({ source_account_id: 'acct-2' }),
    mail({ due: { kind: 'date', date: '2030-10-08', original_text: 'x' } }),
    mail({ due: { kind: 'none' } }),
    mail({
      due: { kind: 'unresolved', reason: 'relative', original_text: 'x' },
    }),
    mail({
      due: {
        kind: 'instant',
        local_datetime: '2030-10-07T17:00',
        zone: 'Asia/Tokyo',
        original_text: 'x',
      },
    }),
  ];
  const keys = new Set([
    base,
    ...others.map((parts) => notificationKey(parts, sha256)),
  ]);
  assert.equal(keys.size, others.length + 1);
  // 時刻付きの期限は、タイムゾーンが違えば別。
  const tokyo = {
    kind: 'instant',
    local_datetime: '2030-10-07T17:00',
    zone: 'Asia/Tokyo',
    original_text: 'x',
  };
  assert.notEqual(
    notificationKey(mail({ due: tokyo }), sha256),
    notificationKey(mail({ due: { ...tokyo, zone: 'UTC' } }), sha256),
  );
  // 予定の重複は、組・時間帯が変われば別。終日どうしの重複は日付で表す。
  const overlapKeys = new Set([
    notificationKey(overlap(), sha256),
    notificationKey(
      overlap({ event_refs: ['id:cal-a/ev-1', 'id:cal-b/ev-3'] }),
      sha256,
    ),
    notificationKey(
      overlap({
        event_refs: ['id:cal-a/ev-1', 'id:cal-b/ev-2', 'id:cal-c/ev-9'],
      }),
      sha256,
    ),
    notificationKey(
      overlap({
        period: {
          kind: 'timed',
          start: '2030-10-09T01:30:00Z',
          end: '2030-10-09T02:30:00Z',
        },
      }),
      sha256,
    ),
    notificationKey(
      overlap({
        period: {
          kind: 'all_day',
          start_date: '2030-10-10',
          end_date: '2030-10-11',
        },
      }),
      sha256,
    ),
  ]);
  assert.equal(overlapKeys.size, 5);
  assert.notEqual(
    notificationKey(research({ completion_version: '2' }), sha256),
    notificationKey(research(), sha256),
  );
  assert.notEqual(
    notificationKey(research({ workflow_id: 'wf-2' }), sha256),
    notificationKey(research(), sha256),
  );
});

test('material that could carry body text, an address or a malformed value is refused', () => {
  const refused = [
    mail({ source_account_id: 'taro@example.com' }), // メールアドレスは材料にしない
    mail({ source_account_id: '' }),
    mail({ request_entity_id: 'req 1' }),
    mail({ request_entity_id: 'req-1\nkind=research_done' }), // 材料の行を差し込む
    mail({ request_revision: '02' }),
    mail({ request_revision: '-1' }),
    mail({ request_revision: '' }),
    mail({ due: { kind: 'date', date: '2030-02-30', original_text: 'x' } }),
    mail({ due: { kind: 'date', date: '2030-2-3', original_text: 'x' } }),
    mail({
      due: {
        kind: 'instant',
        local_datetime: '2030-10-07T25:00',
        zone: 'UTC',
        original_text: 'x',
      },
    }),
    mail({
      due: {
        kind: 'instant',
        local_datetime: '2030-10-07T17:00',
        zone: '',
        original_text: 'x',
      },
    }),
    overlap({ event_refs: ['id:cal-a/ev-1'] }), // 2 つ未満
    overlap({ event_refs: [] }),
    overlap({ event_refs: ['id:cal-a/ev-1', 'id:cal-a/ev-1'] }), // 同じ予定どうし
    overlap({ event_refs: ['id:cal-a/ev-1', ''] }),
    overlap({ event_refs: ['id:cal-a/ev-1', 'id:cal-b/ev-2\n'] }),
    overlap({
      period: {
        kind: 'timed',
        start: '2030-10-09T02:00:00Z',
        end: '2030-10-09T02:00:00Z',
      },
    }),
    overlap({
      period: {
        kind: 'timed',
        start: '2030-10-09T10:00:00+09:00',
        end: '2030-10-09T11:00:00+09:00',
      },
    }),
    overlap({
      period: {
        kind: 'all_day',
        start_date: '2030-10-10',
        end_date: '2030-10-10',
      },
    }),
    research({ workflow_id: 'a b' }),
    research({ completion_version: 'done' }),
  ];
  for (const [index, parts] of refused.entries()) {
    assert.equal(notificationKeyMaterial(parts), null, `material ${index}`);
    assert.equal(notificationKey(parts, sha256), null, `key ${index}`);
  }
  // 計算の結果が 64 桁の小文字の 16 進でなければ受けない。
  for (const bad of [
    '',
    'ABCDEF'.repeat(11).slice(0, 64),
    'a'.repeat(63),
    'g'.repeat(64),
  ])
    assert.equal(
      notificationKey(mail(), () => bad),
      null,
    );
});

test('a candidate whose key already exists is not created again, in any state', () => {
  const existing = [
    { notification_key: 'a'.repeat(64), state: 'new' },
    { notification_key: 'b'.repeat(64), state: 'dismissed' },
    { notification_key: 'c'.repeat(64), state: 'resolved' },
    { notification_key: 'd'.repeat(64), state: 'snoozed' },
  ];
  for (const record of existing)
    assert.deepEqual(
      candidateIntakeDecision(existing, record.notification_key),
      {
        action: 'duplicate',
        state: record.state,
      },
    );
  assert.deepEqual(candidateIntakeDecision(existing, 'e'.repeat(64)), {
    action: 'create',
  });
  assert.deepEqual(candidateIntakeDecision([], 'e'.repeat(64)), {
    action: 'create',
  });
  for (const bad of ['', 'A'.repeat(64), 'a'.repeat(63)])
    assert.deepEqual(candidateIntakeDecision(existing, bad), {
      action: 'reject',
      reason: 'key_invalid',
    });
});

const KEY = notificationKey(mail(), sha256);
const alert = (over = {}) =>
  candidateAlertDecision({
    notification_key: KEY,
    state: 'new',
    initial_import: false,
    evidence: 'valid',
    trigger: 'new_candidate',
    reminder_id: null,
    existing: [],
    ...over,
  });
const record = (status, reminder_id = '') => ({
  notification_key: KEY,
  reminder_id,
  status,
});

test('a new candidate alerts once; reconnecting, refetching and moving device never alert again', () => {
  assert.deepEqual(alert(), { deliver: true, reason: null });
  // 配信の記録ができた後は、同じ候補の再同期が候補を作り直しても出さない。
  for (const status of ['intent_saved', 'delivered', 'delivery_unknown'])
    assert.deepEqual(
      alert({ existing: [record(status)] }),
      {
        deliver: false,
        reason: 'already_delivered',
      },
      status,
    );
  for (const trigger of ['reconnect', 'refetch', 'device_move']) {
    for (const existing of [[], [record('delivered')]])
      assert.deepEqual(
        alert({ trigger, existing }),
        {
          deliver: false,
          reason: 'not_a_new_alert',
        },
        trigger,
      );
  }
  // 別の識別子の記録は影響しない。
  assert.equal(
    alert({
      existing: [
        {
          notification_key: 'f'.repeat(64),
          reminder_id: '',
          status: 'delivered',
        },
      ],
    }).deliver,
    true,
  );
});

test('a reminder the user asked for alerts once per reminder id, after the source is confirmed again', () => {
  const remind = (over = {}) =>
    alert({
      trigger: 'user_reminder',
      reminder_id: 'r1',
      state: 'new',
      ...over,
    });
  assert.deepEqual(remind(), { deliver: true, reason: null });
  // 元の通知が配信済みでも、別の reminder_id なら 1 度出る。同じ reminder_id は 2 度出ない。
  assert.equal(remind({ existing: [record('delivered')] }).deliver, true);
  assert.deepEqual(
    remind({ existing: [record('delivered'), record('delivered', 'r1')] }),
    {
      deliver: false,
      reason: 'already_delivered',
    },
  );
  assert.equal(
    remind({ existing: [record('delivered', 'r1')], reminder_id: 'r2' })
      .deliver,
    true,
  );
  // 元情報を確かめられないとき（作り直し要・未確認・消えた）は出さない。
  for (const evidence of ['refresh_required', 'unconfirmed', 'gone'])
    assert.deepEqual(
      remind({ evidence }),
      { deliver: false, reason: 'source_not_confirmed' },
      evidence,
    );
  // reminder_id の取り違え。
  assert.deepEqual(alert({ trigger: 'user_reminder', reminder_id: null }), {
    deliver: false,
    reason: 'reminder_id_required',
  });
  assert.deepEqual(alert({ reminder_id: 'r1' }), {
    deliver: false,
    reason: 'reminder_id_only_for_user',
  });
});

test('closed candidates do not alert, and the first import is listed without individual alerts', () => {
  for (const state of ['dismissed', 'resolved']) {
    assert.deepEqual(
      alert({ state }),
      { deliver: false, reason: 'candidate_closed' },
      state,
    );
    assert.deepEqual(
      alert({ state, trigger: 'user_reminder', reminder_id: 'r1' }),
      { deliver: false, reason: 'candidate_closed' },
      state,
    );
  }
  assert.deepEqual(alert({ initial_import: true }), {
    deliver: false,
    reason: 'initial_import_listed_only',
  });
  // 初回取り込みでも、本人が指定した再通知は出る。
  assert.deepEqual(
    alert({
      initial_import: true,
      trigger: 'user_reminder',
      reminder_id: 'r1',
    }),
    { deliver: true, reason: null },
  );
});
