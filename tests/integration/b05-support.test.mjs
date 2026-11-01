// B05 の突き合わせの規則（findings）自体が、不正な記録を検出できることを、手で作った記録で確かめる。
// 規則が何も検出しない（常に空）ようになっても、統合の試験が通り続けることを防ぐ。
import assert from 'node:assert/strict';
import test from 'node:test';
import { CLEAN, findings, shuffled } from './b05-support.mjs';

const LIVE_ID = '00000000-0000-4000-8000-000000000001';
const RES_ID = '00000000-0000-4000-8000-0000000000a1';

const start = (overrides = {}) => ({
  generation: 1,
  channel: 'voice.start',
  payload: {
    live_session_id: LIVE_ID,
    io_epoch: '0',
    audio_epoch: '1',
    output_epoch: '0',
    session_epoch: '1',
    ...overrides,
  },
});

const live = (overrides = {}) => ({
  live_session_id: LIVE_ID,
  reservation_id: RES_ID,
  closure: 'close_confirmed',
  usage_seconds: 20,
  audio_epoch: 1,
  session_epoch: 1,
  ...overrides,
});

const reservation = (overrides = {}) => ({
  reservation_id: RES_ID,
  status: 'settled',
  reserved: '195',
  max_liability: '195',
  actual_gross: '20',
  dispatched: true,
  ...overrides,
});

// provider 自身の記録: 作成から閉じる要求まで 20 秒。
const truth = [
  { live_session_id: LIVE_ID, created_at: 1000, close_requested_at: 21_000 },
];

const base = {
  sent: [start()],
  lives: [live()],
  reservations: [reservation()],
  truth,
  voiceLimit: '2000',
};

test('正しい記録は不一致なし', () => {
  assert.deepEqual(findings(base), CLEAN);
});

test('最低の課金（15 秒）を下回る使用秒数は、15 秒分で精算する', () => {
  assert.deepEqual(
    findings({
      ...base,
      lives: [live({ usage_seconds: 3 })],
      reservations: [reservation({ actual_gross: '15' })],
      truth: [{ ...truth[0], close_requested_at: 4000 }],
    }),
    CLEAN,
  );
  assert.deepEqual(
    findings({
      ...base,
      lives: [live({ usage_seconds: 3 })],
      reservations: [reservation({ actual_gross: '3' })],
      truth: [{ ...truth[0], close_requested_at: 4000 }],
    }),
    ['settled_amount_differs'],
  );
});

test('命令の世代の後退・存在しない Live の開始・世代の食い違いを検出する', () => {
  assert.deepEqual(
    findings({
      ...base,
      sent: [
        { ...start(), payload: { ...start().payload, output_epoch: '2' } },
        {
          generation: 1,
          channel: 'voice.play',
          payload: { io_epoch: '0', output_epoch: '1' },
        },
      ],
    }),
    ['output_epoch_regressed:voice.play'],
  );
  assert.deepEqual(
    findings({
      ...base,
      sent: [
        {
          generation: 1,
          channel: 'voice.suspend_io',
          payload: { io_epoch: '1', output_epoch: '1' },
        },
        {
          generation: 1,
          channel: 'voice.play',
          payload: { io_epoch: '0', output_epoch: '1' },
        },
      ],
    }),
    ['io_epoch_regressed:voice.play'],
  );
  assert.deepEqual(
    findings({
      ...base,
      sent: [
        start({ live_session_id: '00000000-0000-4000-8000-0000000000ff' }),
      ],
    }),
    ['start_without_live'],
  );
  assert.deepEqual(findings({ ...base, sent: [start({ audio_epoch: '2' })] }), [
    'start_epoch_differs_from_live',
  ]);
  // 音声レンダラーの作り直し（世代 2）では、世代を 0 から数え直してよい。
  assert.deepEqual(
    findings({
      ...base,
      sent: [
        {
          generation: 1,
          channel: 'voice.suspend_io',
          payload: { io_epoch: '3', output_epoch: '3' },
        },
        {
          generation: 2,
          channel: 'voice.play',
          payload: { io_epoch: '0', output_epoch: '0' },
        },
      ],
    }),
    CLEAN,
  );
});

test('provider の真の使用時間と違う精算・精算の漏れ・開いたままの精算を検出する', () => {
  assert.deepEqual(
    findings({ ...base, lives: [live({ usage_seconds: 19 })] }),
    ['usage_differs_from_provider'],
  );
  assert.deepEqual(
    findings({ ...base, reservations: [reservation({ actual_gross: '19' })] }),
    ['settled_amount_differs'],
  );
  assert.deepEqual(
    findings({
      ...base,
      reservations: [
        reservation({ status: 'usage_unknown', actual_gross: null }),
      ],
    }),
    ['confirmed_but_not_settled'],
  );
  assert.deepEqual(
    findings({ ...base, truth: [{ ...truth[0], close_requested_at: null }] }),
    ['confirmed_without_provider_close'],
  );
  assert.deepEqual(
    findings({
      ...base,
      lives: [live({ closure: 'open', usage_seconds: null })],
    }),
    ['open_but_settled'],
  );
});

test('送出意図のある予約を使用秒数の確認なしに解放したことを検出する', () => {
  assert.deepEqual(
    findings({
      ...base,
      lives: [live({ closure: 'close_unconfirmed', usage_seconds: null })],
      reservations: [reservation({ status: 'released', actual_gross: null })],
    }),
    ['dispatched_released_without_usage'],
  );
  assert.deepEqual(
    findings({
      ...base,
      lives: [live({ closure: 'close_unconfirmed', usage_seconds: null })],
      reservations: [
        reservation({ status: 'usage_unknown', actual_gross: null }),
      ],
    }),
    CLEAN,
  );
});

test('音声の枠の上限の超過と、予約のない Live を検出する', () => {
  assert.deepEqual(
    findings({
      ...base,
      lives: [live({ closure: 'open', usage_seconds: null })],
      reservations: [
        reservation({
          status: 'reserved',
          actual_gross: null,
          max_liability: '2001',
        }),
      ],
    }),
    ['voice_limit_exceeded'],
  );
  assert.deepEqual(findings({ ...base, reservations: [] }), [
    'live_without_reservation',
  ]);
});

test('seed による並べ替えは再現でき、seed が違えば順序が変わる', () => {
  const values = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.deepEqual(shuffled(values, 7), shuffled(values, 7));
  assert.deepEqual([...shuffled(values, 7)].sort(), values);
  assert.notDeepEqual(shuffled(values, 7), shuffled(values, 1007));
});
