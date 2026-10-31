// B06-07a-1: Live の開始は、起動・復帰の掃除が済んで送信が許されているときだけ開く（ADR 0058 の U108）。
// 模擬の Live provider。実際の音声・実 API・実機・実請求は使わない（未実施）。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  A,
  TIMEOUT,
  bodyOf,
  liveBody,
  renew,
  withRig,
} from './voice-rig-test-support.js';
import { uuid } from './budget-test-support.js';

async function renewLease(rig: Parameters<Parameters<typeof withRig>[0]>[0]) {
  const lease = await renew(rig, A, {
    lease_id: uuid(0x1a),
    nonce: 'n1',
    previous_nonce: null,
    at: 10,
  });
  assert.equal(bodyOf(lease)['result'], 'renewed');
}

test(
  'Live: while the sweep gate is closed (no lease) nothing reaches the provider and the request is a 503 that can be retried',
  TIMEOUT,
  async () => {
    let waits = 0;
    await withRig(
      async (rig) => {
        await renewLease(rig);
        const refused = await rig.voice.createLiveSession(A, liveBody());
        assert.equal(refused.status, 503);
        assert.equal(rig.provider.created.length, 0);
        // 掃除が済むのを 3 回まで待ち直して、それでも取れなければ断る。
        assert.equal(waits, 3);
      },
      {
        retention: {
          ready: async () => {
            waits += 1;
          },
          lease: () => null,
        },
      },
    );
  },
);

test(
  'Live: the lease is taken before anything else, kept until the connection is built, and then returned (a sweep waits for it)',
  TIMEOUT,
  async () => {
    const events: string[] = [];
    await withRig(
      async (rig) => {
        await renewLease(rig);
        const created = await rig.voice.createLiveSession(A, liveBody());
        assert.equal(created.status, 201, JSON.stringify(created.body));
        await rig.wait();
        assert.equal(rig.provider.created.length, 1);
        // 貸し出しは provider への作成より前に取り、作成の後に返す。
        assert.deepEqual(events, ['ready', 'lease', 'release']);
      },
      {
        retention: {
          ready: async () => {
            events.push('ready');
          },
          lease: () => {
            events.push('lease');
            return () => {
              events.push('release');
            };
          },
        },
      },
    );
  },
);

test(
  'Live: a closed gate never takes a reservation, and the lease is returned even when admission refuses',
  TIMEOUT,
  async () => {
    let released = 0;
    await withRig(
      async (rig) => {
        // リースを更新していない端末は受付で断られる。貸し出しは返す。
        const refused = await rig.voice.createLiveSession(A, liveBody());
        assert.notEqual(refused.status, 201);
        assert.equal(released, 1);
        assert.equal(rig.provider.created.length, 0);
      },
      {
        retention: {
          ready: async () => undefined,
          lease: () => () => {
            released += 1;
          },
        },
      },
    );
  },
);
