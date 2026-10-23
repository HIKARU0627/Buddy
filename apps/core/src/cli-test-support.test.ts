import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { observeCliStart } from './cli-test-support.js';

// 子プロセスは親からの指示まで running を出さない。実時間の sleep で順序を作らない。
async function fixture(t: test.TestContext, signal = t.signal) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    process.on('message', (message) => {
      if ('exit' in message) process.exit(message.exit);
      else if (message.running) process.stdout.write(JSON.stringify({
        event: 'running', state: 'running', pid: process.pid,
      }) + '\\n');
      else process.stdout.write(message.line + '\\n');
    });
    process.stderr.write('synthetic-private-output');
    process.send('ready');
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  const ready = once(child, 'message');
  const observed = observeCliStart(child, signal);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await observed.exited;
  });
  await ready;
  return observed;
}

test(
  '起動通知を待ち、15 秒の経過や HTTPS の準備だけでは完了しない',
  { timeout: 10_000 },
  async (t) => {
    // 観測を始める前から置き換える。起動専用タイマーが再導入された場合も tick で発火させる。
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const core = await fixture(t);
    let running = false;
    void core.running.then(
      () => {
        running = true;
      },
      () => undefined,
    );
    const received = once(core.child.stdout!, 'data');
    core.child.send!({ line: '{"event":"https_listening"}' });
    await received;
    t.mock.timers.tick(15_001);
    await Promise.resolve();
    assert.equal(running, false);
    t.mock.timers.reset();
    core.child.send!({ running: true });
    assert.equal((await core.running)['state'], 'running');
    assert.deepEqual(
      core.events.map((event) => event['event']),
      ['https_listening', 'running'],
    );
    core.child.send!({ exit: 0 });
    assert.equal((await core.exited).code, 0);
  },
);

test(
  '起動の拒否・壊れた出力・早期終了を通知し、生の出力は診断へ載せない',
  { timeout: 15_000 },
  async (t) => {
    const cases = [
      [
        { line: '{"event":"refused","reason":"synthetic-private-output"}' },
        'refused',
      ],
      [{ line: 'synthetic-private-output' }, 'invalid_json'],
      [{ line: '[]' }, 'invalid_event'],
      [
        { line: '{"event":"running","state":"starting","pid":0}' },
        'invalid_running',
      ],
      [{ exit: 7 }, 'exited:7'],
    ] as const;
    for (const [message, reason] of cases) {
      await t.test(reason, async (t) => {
        const core = await fixture(t);
        core.child.send!(message);
        await assert.rejects(core.running, (error: Error) => {
          assert(error.message.includes(reason));
          assert.equal(
            error.message.includes('synthetic-private-output'),
            false,
          );
          return true;
        });
      });
    }
  },
);

test(
  '試験の中断は起動待ちを終え、開始済みの signal でも待ち続けない',
  { timeout: 10_000 },
  async (t) => {
    for (const alreadyAborted of [false, true]) {
      await t.test(String(alreadyAborted), async (t) => {
        const controller = new AbortController();
        if (alreadyAborted) controller.abort();
        const core = await fixture(
          t,
          AbortSignal.any([controller.signal, t.signal]),
        );
        controller.abort();
        await assert.rejects(
          core.running,
          /test_aborted; stage=process_start/u,
        );
      });
    }
  },
);

test(
  'プロセスを作れなければ起動待ちを即座に拒否する',
  { timeout: 10_000 },
  async (t) => {
    const child = spawn(join(tmpdir(), `buddy-missing-${randomUUID()}`), [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const core = observeCliStart(child, t.signal);
    await assert.rejects(core.running, /spawn_error/u);
    await core.exited;
  },
);
