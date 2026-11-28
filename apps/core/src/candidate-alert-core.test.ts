// 製品の Core（startCore、HTTPS は 127.0.0.1・鍵は模擬）での気づきの OS 通知の配線（ADR 0196）。
// - 入・切の経路（GET・POST /v1/candidates/alert-settings）: 既定は切・版 0、本人の画面操作で入、古い版は 409、ロック中の
//   読み取りは 403。
// - 切の間に作った候補では購読へ何も送らない。入にした知らせ（数 0）の後、新しい候補で数 1 の知らせが購読へ届き、配信の
//   記録は delivered。知らせに題・候補 ID・識別子を含めない。切に戻すと知らせ（数 0）の後は送らない。
// 期待値は手で書いた値で、検査対象の関数から作らない。模擬の試験だけ（実機の OS 通知は未実施）。

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { CandidateOpValues } from '@buddy/storage';
import { sharedApiContract } from './api-test-support.js';
import type { TestDevice } from './api-test-support.js';
import {
  bootstrap,
  getJson,
  insertDevice,
  openStream,
  postJson,
  startEventCore,
} from './event-test-support.js';
import type { EventCore, StreamClient } from './event-test-support.js';

const contract = sharedApiContract();
const SCREEN = { 'buddy-input-origin': 'screen' };

const sealed = () => ({
  blob_id: randomUUID(),
  format_version: 1,
  key_id: 'k-test',
  nonce: randomBytes(12),
  ciphertext: randomBytes(8),
  tag: randomBytes(16),
});

// 候補を保存層へ直接作る（由来は発言）。題は暗号文の封筒のまま（中身は使わない）。
async function createCandidate(
  core: EventCore,
  key: string,
  turnId: string,
): Promise<void> {
  const created = await core.handle.store.candidate({
    kind: 'candidate.create',
    input: {
      candidate_id: randomUUID(),
      candidate_kind: 'research_done',
      notification_key: key,
      request_entity_id: null,
      request_revision: null,
      source_revision: null,
      deadline: { kind: 'none' },
      initial_import: false,
      unread_partial: false,
      related_analysis: null,
      received_at: new Date().toISOString().replace(/\.\d+Z$/u, 'Z'),
      created_at: new Date().toISOString().replace(/\.\d+Z$/u, 'Z'),
      title: sealed(),
      excerpt: null,
      origins: [{ source_kind: 'turn', source_id: turnId }],
    },
  });
  assert.equal(created.ok, true, JSON.stringify(created));
}

const openAt = async (
  t: test.TestContext,
  core: EventCore,
  device: TestDevice,
): Promise<StreamClient> => {
  const snapshot = await getJson(core, device, '/v1/snapshot');
  assert.equal(snapshot.status, 200, snapshot.text);
  const stream = openStream(
    t,
    core,
    device,
    String(snapshot.json?.['event_cursor']),
  );
  assert.deepEqual(await stream.opened, { ok: true });
  return stream;
};

const subscribed = async (core: EventCore, count: number) => {
  const relay = core.handle.notices as unknown as { listenerCount: number };
  for (let i = 0; i < 200 && relay.listenerCount !== count; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(relay.listenerCount, count);
};

const candidateNotices = (stream: StreamClient) =>
  stream.messages
    .filter(
      (message) =>
        message.type === 'notice' &&
        message.notice?.['schema'] === 'buddy.candidate-notice.v1',
    )
    .map((message) => message.notice as Record<string, unknown>);

test(
  'the OS notification setting gates the candidate notice on the open stream, with the count only',
  { timeout: 60_000 },
  async (t) => {
    const core = await startEventCore(t);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);

    // 既定は切・版 0。読み取りは画面操作を求めない。ロック中は 403。
    const first = await getJson(core, device, '/v1/candidates/alert-settings');
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.json, {
      schema: 'buddy.candidate-alert-settings.v1',
      os_notification: 'off',
      candidate_alert_settings_revision: '0',
    });
    core.env.lock = 'locked';
    assert.equal(
      (await getJson(core, device, '/v1/candidates/alert-settings')).status,
      403,
    );
    core.env.lock = 'unlocked';

    // 候補の由来にする発言（合成）。
    const posted = await postJson(core, device, '/v1/stream/turns', {
      request_id: randomUUID(),
      command_scope_id: scope,
      text: 'こんにちは',
      input_kind: 'text',
      expected_canvas_revision: '0',
    });
    assert.equal(posted.status, 200, posted.text);
    const turnId = String(posted.json?.['turn_id']);

    const stream = await openAt(t, core, device);
    await subscribed(core, 1);

    // 切の間に作った候補では送らない。
    await createCandidate(core, 'a'.repeat(64), turnId);

    const change = (expected: string, value: string, headers = SCREEN) =>
      postJson(
        core,
        device,
        '/v1/candidates/alert-settings',
        {
          request_id: randomUUID(),
          command_scope_id: scope,
          expected_candidate_alert_settings_revision: expected,
          os_notification: value,
        },
        headers,
      );
    // 画面操作でない起源は 403。
    assert.equal(
      (await change('0', 'on', { 'buddy-input-origin': 'voice' })).status,
      403,
    );
    const on = await change('0', 'on');
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json?.['candidate_alert_settings_revision'], '1');
    // 古い版からの変更（切にするときも）は 409。
    assert.equal((await change('0', 'off')).status, 409);

    // 入にした知らせ（数 0）が先に届く。切の間の候補の知らせは無い。
    await stream.waitFor(
      () => candidateNotices(stream).length === 1,
      'settings notice',
    );
    assert.equal(candidateNotices(stream)[0]?.['alert_count'], 0);

    await createCandidate(core, 'b'.repeat(64), turnId);
    await stream.waitFor(
      () => candidateNotices(stream).length === 2,
      'alert notice',
    );
    const notice = candidateNotices(stream)[1] as Record<string, unknown>;
    assert.deepEqual(Object.keys(notice).sort(), [
      'alert_count',
      'notice_id',
      'occurred_at',
      'schema',
    ]);
    assert.equal(notice['alert_count'], 1);
    for (const message of stream.messages)
      assert(
        contract.valid('EventStreamMessage', message),
        JSON.stringify(message),
      );
    const records = await core.handle.store.candidate({
      kind: 'candidate.alert_records',
      notification_key: 'b'.repeat(64),
    });
    assert.equal(records.ok, true);
    assert.deepEqual(
      (records as { value: CandidateOpValues['candidate.alert_records'] }).value
        .records,
      [
        {
          notification_key: 'b'.repeat(64),
          reminder_id: '',
          status: 'delivered',
        },
      ],
    );
    // 切の間に作った候補には配信の記録が無い（入にしても後から通知しない）。
    const before = await core.handle.store.candidate({
      kind: 'candidate.alert_records',
      notification_key: 'a'.repeat(64),
    });
    assert.deepEqual(
      (before as { value: CandidateOpValues['candidate.alert_records'] }).value
        .records,
      [],
    );

    // 切に戻すと、知らせ（数 0）の後は、新しい候補でも送らない。
    assert.equal((await change('1', 'off')).status, 200);
    await stream.waitFor(
      () => candidateNotices(stream).length === 3,
      'off notice',
    );
    assert.equal(candidateNotices(stream)[2]?.['alert_count'], 0);
    await createCandidate(core, 'c'.repeat(64), turnId);
    const third = await core.handle.store.candidate({
      kind: 'candidate.alert_records',
      notification_key: 'c'.repeat(64),
    });
    assert.deepEqual(
      (third as { value: CandidateOpValues['candidate.alert_records'] }).value
        .records,
      [],
    );
    // 判定は書込みの後にまとめて回る。もう一度入にした知らせが届いた時点で、切の間の知らせが無かったことを確かめる。
    assert.equal((await change('2', 'on')).status, 200);
    await stream.waitFor(
      () => candidateNotices(stream).length === 4,
      'on again notice',
    );
    assert.deepEqual(
      candidateNotices(stream).map((item) => item['alert_count']),
      [0, 1, 0, 0],
    );
  },
);
