// 自宅の指紋の定期報告の試験（ADR 0022・0025）。模擬の時計・送信で、5 分ごと・ネットワークの変化・
// 形に合わない要素を null にすることを確かめる。値（MAC・サブネット）は文書用の合成値。期待値は手で書いた値。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientApiOutcome } from '@buddy/client';
import { createDesktopContract, loadContractSchema } from './contract.js';
import {
  HomeReporter,
  networkSignatureOf,
  sanitizeFingerprint,
} from './home-reporter.js';
import type { HomeReportResult } from './home-reporter.js';

const contract = createDesktopContract(loadContractSchema());
const valid = (name: string, value: unknown) => contract.valid(name, value);

class ManualClock {
  now = Date.UTC(2030, 9, 1);
  timers: { at: number; run: () => void; id: number }[] = [];
  #next = 0;
  setTimer = (ms: number, run: () => void) => {
    const id = (this.#next += 1);
    this.timers.push({ at: this.now + ms, run, id });
    return () => {
      this.timers = this.timers.filter((timer) => timer.id !== id);
    };
  };
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      this.now = due.at;
      due.run();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    }
    this.now = target;
  }
}

const STATUS = {
  allowed: true,
  exempt: false,
  reasons: [],
  report_expires_at: '2030-10-01T00:06:00Z',
};

test('reports at start, every five minutes and when the network changes', async () => {
  const clock = new ManualClock();
  const sent: Record<string, unknown>[] = [];
  const results: HomeReportResult[] = [];
  let signature = 'net-1';
  let id = 0;
  const reporter = new HomeReporter({
    collect: () =>
      Promise.resolve({
        gateway_mac: '00:00:5e:00:53:01',
        subnet: '192.0.2.0/24',
        ssid: null,
      }),
    send: (body) => {
      sent.push(body);
      return Promise.resolve<ClientApiOutcome>({
        kind: 'response',
        status: 200,
        body: STATUS,
      });
    },
    valid,
    networkSignature: () => signature,
    now: () => clock.now,
    setTimer: clock.setTimer,
    newRequestId: () => `00000000-0000-4000-8000-00000000010${(id += 1)}`,
    onResult: (result) => results.push(result),
  });
  reporter.start();
  await reporter.idle();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    request_id: '00000000-0000-4000-8000-000000000101',
    fingerprint: {
      gateway_mac: '00:00:5e:00:53:01',
      subnet: '192.0.2.0/24',
      ssid: null,
    },
  });
  assert.equal(results[0]?.status.allowed, true);
  await clock.advance(4 * 60_000 + 59_000);
  assert.equal(sent.length, 1);
  await clock.advance(1_000);
  assert.equal(sent.length, 2);
  // 接続口が変わったら 15 秒以内に報告し直し、5 分の数え直しをする。
  signature = 'net-2';
  await clock.advance(15_000);
  assert.equal(sent.length, 3);
  await clock.advance(4 * 60_000 + 50_000);
  assert.equal(sent.length, 3);
  await clock.advance(10_000);
  assert.equal(sent.length, 4);
  reporter.stop();
  assert.deepEqual(clock.timers, []);
  await clock.advance(60 * 60_000);
  assert.equal(sent.length, 4);
});

test('values that do not match the contract are sent as null, and failures are only logged', async () => {
  assert.deepEqual(
    sanitizeFingerprint(
      {
        gateway_mac: '00-00-5E-00-53-01',
        subnet: '192.0.2.0/31',
        ssid: 'x'.repeat(33),
      },
      valid,
    ),
    { gateway_mac: null, subnet: null, ssid: null },
  );
  assert.deepEqual(
    sanitizeFingerprint(
      {
        gateway_mac: '00:00:5e:00:53:01',
        subnet: '192.0.2.0/24',
        ssid: '合成の SSID',
      },
      valid,
    ),
    {
      gateway_mac: '00:00:5e:00:53:01',
      subnet: '192.0.2.0/24',
      ssid: '合成の SSID',
    },
  );
  const clock = new ManualClock();
  const logs: string[] = [];
  const reporter = new HomeReporter({
    collect: () => Promise.reject(new Error('runner failed')),
    send: () =>
      Promise.resolve<ClientApiOutcome>({ kind: 'unreachable', reason: 'x' }),
    valid,
    networkSignature: () => 'same',
    now: () => clock.now,
    setTimer: clock.setTimer,
    newRequestId: () => '00000000-0000-4000-8000-000000000201',
    onResult: () => assert.fail('no result expected'),
    log: (code) => logs.push(code),
  });
  reporter.start();
  await reporter.idle();
  assert(logs.includes('home_report_failed:unreachable'));
  // 値を含むログはない。
  assert(logs.every((line) => /^[a-z_:]+$/u.test(line)));
  reporter.stop();
  assert.equal(
    networkSignatureOf({
      lo0: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          internal: true,
        },
      ],
      en0: [
        {
          address: '192.0.2.7',
          netmask: '255.255.255.0',
          family: 'IPv4',
          internal: false,
        },
      ],
    }),
    'en0|IPv4|192.0.2.7|255.255.255.0',
  );
});
