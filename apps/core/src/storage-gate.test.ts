// B06-07a-2: 保存境界の保持者（StorageModeGate）。記録しない区切りの世代を時計の状態ファイルに番号だけ置き（ADR 0059）、
// 再起動の後も古い由来を拒否し、通常の区切りへ戻して知らせる。ファイルと Core は一時ディレクトリ・模擬の鍵。
// 期待値は手で書いた。実機・実 API・実請求は使わない。

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApiContract } from './api-contract.js';
import { onCleanup } from './api-test-support.js';
import {
  createClockStateFile,
  parseClockState,
  serializeClockState,
} from './clock-state.js';
import type {
  ClockStateContent,
  ClockStateFilePort,
  StorageBoundaryLoad,
  StorageBoundaryRecord,
} from './clock-state.js';
import { RecordingNoticeSink } from './notice-sink.js';
import { CLOCK_STATE_FILE } from './paths.js';
import { StorageModeGate } from './storage-gate.js';

const EPOCH = '00000000-0000-4000-8000-000000000001';
const NOTICE_ID = '00000000-0000-4000-8000-000000000a01';
const SEG_A = '00000000-0000-4000-8000-000000000b01';
const SEG_B = '00000000-0000-4000-8000-000000000b02';
const SEG_C = '00000000-0000-4000-8000-000000000b03';
const SEG_D = '00000000-0000-4000-8000-000000000b04';
const SEG_E = '00000000-0000-4000-8000-000000000b05';
const NOW = Date.parse('2031-06-01T00:00:00Z');

const clockContent = (
  boundary: ClockStateContent['storage_boundary'],
  revision = 5,
): ClockStateContent => ({
  schema: 'buddy.clock-state.v1',
  revision,
  last_checked_at: '2031-05-31T00:00:00Z',
  epoch: EPOCH,
  epoch_started_at: '2031-05-31T00:00:00Z',
  written_at: '2031-05-31T00:00:00Z',
  rechecks: [],
  storage_boundary: boundary,
});

async function tempDir(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-storage-gate-'));
  onCleanup(t, () =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  );
  return dir;
}

const readFileContent = async (dir: string) =>
  parseClockState(await readFile(join(dir, CLOCK_STATE_FILE), 'utf8'));

// 順番に ID を渡す。
function ids(...values: string[]): () => string {
  const queue = [...values];
  return () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('ids_exhausted');
    return next;
  };
}

// 模擬のファイルの口。書き込みの失敗・場所がない状態を作れる。
class FakeBoundaryClock implements Pick<
  ClockStateFilePort,
  'loadBoundary' | 'saveBoundary'
> {
  saved: StorageBoundaryRecord[] = [];
  constructor(
    public load: StorageBoundaryLoad,
    public mode: 'ok' | 'unavailable' | 'throws' = 'ok',
  ) {}
  loadBoundary(): Promise<StorageBoundaryLoad> {
    return Promise.resolve(this.load);
  }
  saveBoundary(
    record: StorageBoundaryRecord,
  ): Promise<'saved' | 'unavailable'> {
    if (this.mode === 'throws') return Promise.reject(new Error('disk'));
    if (this.mode === 'unavailable') return Promise.resolve('unavailable');
    this.saved.push(record);
    return Promise.resolve('saved');
  }
}

const open = (
  clock: FakeBoundaryClock,
  extra: Partial<Parameters<typeof StorageModeGate.open>[0]> = {},
) =>
  StorageModeGate.open({
    clock,
    now: () => NOW,
    newId: ids(SEG_A, SEG_B, SEG_C, SEG_D, SEG_E),
    ...extra,
  });

test('open: a first start has no record — normal, generation 1, nothing written, no notice', async () => {
  const clock = new FakeBoundaryClock({ status: 'absent' });
  const sink = new RecordingNoticeSink();
  const gate = await open(clock, { notices: sink });
  assert.equal(gate.mode, 'normal');
  assert.equal(gate.privateConversation(), false);
  assert.deepEqual(gate.origin(), {
    segment_id: SEG_A,
    segment_generation: '1',
    storage_mode: 'normal',
  });
  assert.deepEqual(clock.saved, []);
  assert.deepEqual(sink.boundaryNotices, []);
});

test('open: a restart after a normal run continues the generation (3 → 4) and writes it back', async () => {
  const clock = new FakeBoundaryClock({
    status: 'ok',
    record: { segment_generation: '3', private_open: false },
  });
  const sink = new RecordingNoticeSink();
  const gate = await open(clock, { notices: sink });
  assert.equal(gate.origin().segment_generation, '4');
  assert.deepEqual(clock.saved, [
    { segment_generation: '4', private_open: false },
  ]);
  // 記録しない区切りが開いていたわけではないので、知らせない。
  assert.deepEqual(sink.boundaryNotices, []);
});

test('open: a restart while a private segment was open returns to a normal segment and announces it (Q7)', async () => {
  const clock = new FakeBoundaryClock({
    status: 'ok',
    record: { segment_generation: '3', private_open: true },
  });
  const sink = new RecordingNoticeSink();
  const gate = await open(clock, {
    notices: sink,
    newId: ids(SEG_A, NOTICE_ID),
  });
  assert.equal(gate.mode, 'normal');
  assert.equal(gate.privateConversation(), false);
  assert.deepEqual(clock.saved, [
    { segment_generation: '4', private_open: false },
  ]);
  // 手で書いた期待値（番号と ID だけ）。
  assert.deepEqual(sink.boundaryNotices, [
    {
      schema: 'buddy.storage-boundary-notice.v1',
      notice_id: NOTICE_ID,
      occurred_at: '2031-06-01T00:00:00.000Z',
      kind: 'private_ended',
      reason: 'core_restarted',
      ended_generation: '3',
      segment_id: SEG_A,
      segment_generation: '4',
    },
  ]);
  // 契約の Schema に合う。
  assert.equal(
    createApiContract().valid('StorageBoundaryNotice', sink.boundaryNotices[0]),
    true,
  );
});

test('open: the old private origin is rejected after a restart, and so is every older generation', async () => {
  const clock = new FakeBoundaryClock({
    status: 'ok',
    record: { segment_generation: '3', private_open: true },
  });
  const gate = await open(clock);
  const oldPrivate = {
    segment_id: SEG_B,
    segment_generation: '3',
    storage_mode: 'private',
  };
  assert.equal(gate.originRejection(oldPrivate), 'origin_private');
  // 同じ世代の番号でも別の区切りの ID なら拒否（ID が違えば世代が一致しても通らない）。
  assert.equal(
    gate.originRejection({ ...gate.origin(), segment_id: SEG_B }),
    'origin_stale',
  );
  assert.equal(
    gate.originRejection({
      ...gate.origin(),
      segment_generation: '3',
    }),
    'origin_stale',
  );
  // 通常の区切りで保存モードが違う。
  assert.equal(
    gate.originRejection({ ...gate.origin(), storage_mode: 'private' }),
    'origin_mismatch',
  );
  assert.equal(gate.originRejection(gate.origin()), null);
  assert.equal(gate.originRejection({ segment_id: SEG_A }), 'origin_invalid');
});

test('open: a damaged record is not reinterpreted — generation restarts at 1, the field is rewritten, no notice', async () => {
  const clock = new FakeBoundaryClock({ status: 'invalid' });
  const sink = new RecordingNoticeSink();
  const messages: string[] = [];
  const gate = await open(clock, {
    notices: sink,
    log: (message) => messages.push(message),
  });
  assert.equal(gate.origin().segment_generation, '1');
  assert.deepEqual(clock.saved, [
    { segment_generation: '1', private_open: false },
  ]);
  assert.deepEqual(sink.boundaryNotices, []);
  assert.equal(messages.length, 1);
});

test('open: with no clock file, nothing is written and entering a private segment is refused', async () => {
  const clock = new FakeBoundaryClock({ status: 'unavailable' }, 'unavailable');
  const gate = await open(clock);
  assert.deepEqual(clock.saved, []);
  const result = await gate.enterPrivate();
  assert.deepEqual(result, { ok: false, reason: 'persist_unavailable' });
  // 入れなかったので通常の区切りのまま（Live も開ける側）。
  assert.equal(gate.privateConversation(), false);
});

test('open: a failing write at startup does not stop the start and a notice for a private end is still sent', async () => {
  const clock = new FakeBoundaryClock(
    {
      status: 'ok',
      record: { segment_generation: '7', private_open: true },
    },
    'throws',
  );
  const sink = new RecordingNoticeSink();
  const gate = await open(clock, { notices: sink });
  assert.equal(gate.mode, 'normal');
  assert.equal(sink.boundaryNotices.length, 1);
  assert.equal(sink.boundaryNotices[0]?.ended_generation, '7');
});

test('open: a notice sink that throws or rejects never fails the start', async () => {
  for (const publish of [
    () => {
      throw new Error('sink');
    },
    () => Promise.reject(new Error('sink')),
  ]) {
    const clock = new FakeBoundaryClock({
      status: 'ok',
      record: { segment_generation: '1', private_open: true },
    });
    const gate = await open(clock, { notices: { publish } });
    assert.equal(gate.mode, 'normal');
  }
});

test('enter / exit: the generation is written first, then the commands run in the domain order (close Live → canvas → open segment)', async () => {
  const clock = new FakeBoundaryClock({ status: 'absent' });
  const seen: string[] = [];
  const gate = await open(clock, {
    effects: {
      run: (command) => {
        // 命令の実行時には、世代がもう書かれていて、RAM の状態も進んでいる。
        seen.push(
          `${command.type}|saved=${clock.saved.length}|private=${gate.privateConversation()}`,
        );
      },
    },
  });
  const entered = await gate.enterPrivate();
  assert.deepEqual(entered, {
    ok: true,
    origin: {
      segment_id: SEG_B,
      segment_generation: '2',
      storage_mode: 'private',
    },
  });
  assert.deepEqual(seen, [
    'close_voice_session|saved=1|private=true',
    'begin_private_canvas|saved=1|private=true',
    'open_segment|saved=1|private=true',
  ]);
  assert.deepEqual(clock.saved, [
    { segment_generation: '2', private_open: true },
  ]);
  seen.length = 0;
  const exited = await gate.exitPrivate('normal');
  assert.deepEqual(exited, {
    ok: true,
    origin: {
      segment_id: SEG_C,
      segment_generation: '3',
      storage_mode: 'normal',
    },
  });
  assert.deepEqual(seen, [
    'discard_private_ram|saved=2|private=false',
    'end_private_canvas|saved=2|private=false',
    'open_segment|saved=2|private=false',
  ]);
  assert.deepEqual(clock.saved[1], {
    segment_generation: '3',
    private_open: false,
  });
});

test('enter: when the write fails or the place is missing, state and commands do not move (fail closed to "cannot enter")', async () => {
  for (const mode of ['throws', 'unavailable'] as const) {
    const clock = new FakeBoundaryClock({ status: 'absent' }, mode);
    const commands: string[] = [];
    const gate = await open(clock, {
      effects: { run: (command) => void commands.push(command.type) },
    });
    const before = gate.origin();
    assert.deepEqual(await gate.enterPrivate(), {
      ok: false,
      reason: mode === 'throws' ? 'persist_failed' : 'persist_unavailable',
    });
    assert.deepEqual(gate.origin(), before);
    assert.deepEqual(commands, []);
  }
});

test('exit: when the write fails the segment stays private (never falls back to saving)', async () => {
  const clock = new FakeBoundaryClock({ status: 'absent' });
  const gate = await open(clock);
  assert.equal((await gate.enterPrivate()).ok, true);
  clock.mode = 'throws';
  assert.deepEqual(await gate.exitPrivate('normal'), {
    ok: false,
    reason: 'persist_failed',
  });
  assert.equal(gate.privateConversation(), true);
});

test('enter / exit: rule refusals are returned as they are (already private, not private, unknown target mode)', async () => {
  const clock = new FakeBoundaryClock({ status: 'absent' });
  const gate = await open(clock);
  assert.deepEqual(await gate.exitPrivate('normal'), {
    ok: false,
    reason: 'not_private',
  });
  assert.equal((await gate.enterPrivate()).ok, true);
  assert.deepEqual(await gate.enterPrivate(), {
    ok: false,
    reason: 'already_private',
  });
  assert.deepEqual(await gate.exitPrivate('private' as unknown as 'normal'), {
    ok: false,
    reason: 'storage_mode_unknown',
  });
  // 拒否では何も書かない（入った 1 回の書き込みだけ）。
  assert.equal(clock.saved.length, 1);
  assert.equal(gate.privateConversation(), true);
});

test('enter / exit / enter: results from an earlier private segment stay rejected after re-entering (generation never goes back)', async () => {
  const clock = new FakeBoundaryClock({ status: 'absent' });
  const gate = await open(clock);
  const first = await gate.enterPrivate();
  assert.equal(first.ok && first.origin.segment_generation, '2');
  const firstOrigin = first.ok ? first.origin : null;
  await gate.exitPrivate('normal');
  // 同じ区切りの ID を使い回さないので、入り直した 2 つ目の記録しない区切りも別の世代・別の ID。
  const second = await gate.enterPrivate();
  assert.equal(second.ok && second.origin.segment_generation, '4');
  assert.equal(gate.originRejection(firstOrigin), 'origin_private');
  assert.equal(gate.originRejection(second.ok ? second.origin : null), null);
});

test('enter and exit requests are serialized — two simultaneous enters make one segment', async () => {
  const clock = new FakeBoundaryClock({ status: 'absent' });
  const gate = await open(clock);
  const results = await Promise.all([gate.enterPrivate(), gate.enterPrivate()]);
  assert.deepEqual(
    results.map((result) => (result.ok ? 'ok' : result.reason)),
    ['ok', 'already_private'],
  );
  assert.equal(clock.saved.length, 1);
});

test('a failing command does not undo the move into the private segment, and later commands still run', async () => {
  const clock = new FakeBoundaryClock({ status: 'absent' });
  const seen: string[] = [];
  const messages: string[] = [];
  const gate = await open(clock, {
    log: (message) => messages.push(message),
    effects: {
      run: (command) => {
        seen.push(command.type);
        if (command.type === 'close_voice_session') throw new Error('close');
      },
    },
  });
  assert.equal((await gate.enterPrivate()).ok, true);
  assert.equal(gate.privateConversation(), true);
  assert.deepEqual(seen, [
    'close_voice_session',
    'begin_private_canvas',
    'open_segment',
  ]);
  assert.equal(messages.length, 1);
});

test('after close(), enter and exit are refused', async () => {
  const clock = new FakeBoundaryClock({ status: 'absent' });
  const gate = await open(clock);
  await gate.close();
  assert.deepEqual(await gate.enterPrivate(), { ok: false, reason: 'closed' });
  assert.deepEqual(await gate.exitPrivate('normal'), {
    ok: false,
    reason: 'closed',
  });
});

// ---- 書き込みの結果が不確かな失敗（置き換えは済み、その後の fsync が失敗した場合など） ----------------------------

// ディスクの中身を持つ模擬。計画の各項目が 1 回の書き込みの結果: ok（書いて成功）・throw（書かずに失敗）・
// apply_then_throw（書いた後で失敗＝置き換えの後の fsync の失敗）。計画が尽きたら ok。
class DiskModelClock {
  disk: StorageBoundaryRecord | null;
  writes = 0;
  constructor(
    disk: StorageBoundaryRecord | null,
    public plan: ('ok' | 'throw' | 'apply_then_throw')[] = [],
  ) {
    this.disk = disk;
  }
  loadBoundary(): Promise<StorageBoundaryLoad> {
    return Promise.resolve(
      this.disk === null
        ? { status: 'absent' }
        : { status: 'ok', record: this.disk },
    );
  }
  saveBoundary(
    record: StorageBoundaryRecord,
  ): Promise<'saved' | 'unavailable'> {
    this.writes += 1;
    const step = this.plan.shift() ?? 'ok';
    if (step === 'throw') return Promise.reject(new Error('disk'));
    this.disk = record;
    if (step === 'apply_then_throw') return Promise.reject(new Error('fsync'));
    return Promise.resolve('saved');
  }
}

test('exit: rename succeeded but the directory fsync failed — the file is put back to "private open" so a restart still announces the end (AO review P2)', async () => {
  const clock = new DiskModelClock(null);
  const gate = await StorageModeGate.open({
    clock,
    now: () => NOW,
    newId: ids(SEG_A, SEG_B, SEG_C, SEG_D, SEG_E),
  });
  assert.equal((await gate.enterPrivate()).ok, true);
  assert.deepEqual(clock.disk, { segment_generation: '2', private_open: true });
  // 出る側の書き込み: 置き換えは済み（ファイルは「出た」と読める）、その後の fsync が失敗。
  clock.plan = ['apply_then_throw'];
  assert.deepEqual(await gate.exitPrivate('normal'), {
    ok: false,
    reason: 'persist_failed',
  });
  // 失敗の応答を受けて記録しない会話を続ける（RAM は記録しない区切りのまま）。ファイルは合わせ直されている。
  assert.equal(gate.privateConversation(), true);
  assert.deepEqual(clock.disk, { segment_generation: '2', private_open: true });
  // そのまま再起動すると、記録しない会話が終わったことを知らせる。
  const sink = new RecordingNoticeSink();
  const restarted = await StorageModeGate.open({
    clock,
    notices: sink,
    now: () => NOW,
    newId: ids(SEG_D, NOTICE_ID),
  });
  assert.equal(restarted.privateConversation(), false);
  assert.equal(sink.boundaryNotices.length, 1);
  assert.equal(sink.boundaryNotices[0]?.ended_generation, '2');
});

test('exit: the put-back is retried — one failed attempt does not lose the notice, and a stuck put-back is retried at the next chance and at close()', async () => {
  const clock = new DiskModelClock(null);
  const messages: string[] = [];
  const gate = await StorageModeGate.open({
    clock,
    now: () => NOW,
    newId: ids(SEG_A, SEG_B, SEG_C, SEG_D, SEG_E),
    log: (message) => messages.push(message),
  });
  assert.equal((await gate.enterPrivate()).ok, true);
  // 出る側の書き込みが「書いて失敗」、合わせ直しの 1 回目が失敗、2 回目が成功。
  clock.plan = ['apply_then_throw', 'throw', 'ok'];
  assert.equal((await gate.exitPrivate('normal')).ok, false);
  assert.deepEqual(clock.disk, { segment_generation: '2', private_open: true });
  assert.deepEqual(messages, []);
  // 合わせ直しがすべて失敗した場合: 書いて失敗の後、3 回とも失敗 → ファイルは「出た」のまま、記録が残る。
  clock.plan = ['apply_then_throw', 'throw', 'throw', 'throw'];
  assert.equal((await gate.exitPrivate('normal')).ok, false);
  assert.deepEqual(clock.disk, {
    segment_generation: '3',
    private_open: false,
  });
  assert.equal(messages.length, 1);
  assert.equal(gate.privateConversation(), true);
  // 停止（close）が最後にもう一度試し、ファイルを記録しない区切りが開いている状態へ合わせ直す。
  await gate.close();
  assert.deepEqual(clock.disk, { segment_generation: '2', private_open: true });
});

test('exit: a stuck put-back is retried at the next exit, and a successful exit then wins (no stale put-back afterwards)', async () => {
  const clock = new DiskModelClock(null);
  const gate = await StorageModeGate.open({
    clock,
    now: () => NOW,
    newId: ids(SEG_A, SEG_B, SEG_C, SEG_D, SEG_E),
  });
  assert.equal((await gate.enterPrivate()).ok, true);
  clock.plan = ['apply_then_throw', 'throw', 'throw', 'throw'];
  assert.equal((await gate.exitPrivate('normal')).ok, false);
  assert.deepEqual(clock.disk, {
    segment_generation: '3',
    private_open: false,
  });
  // 次の出る: 先に合わせ直しを試し（成功）、そのあと出る側の書き込みが成功する。
  assert.equal((await gate.exitPrivate('normal')).ok, true);
  assert.deepEqual(clock.disk, {
    segment_generation: '3',
    private_open: false,
  });
  assert.equal(gate.privateConversation(), false);
  // 出た後の停止は、古い合わせ直しを書き戻さない。
  await gate.close();
  assert.deepEqual(clock.disk, {
    segment_generation: '3',
    private_open: false,
  });
});

test('enter: rename succeeded but the fsync failed — the file is put back to "normal", so a restart does not announce an end that never began', async () => {
  const clock = new DiskModelClock(null, ['apply_then_throw']);
  const gate = await StorageModeGate.open({
    clock,
    now: () => NOW,
    newId: ids(SEG_A, SEG_B, SEG_C, SEG_D, SEG_E),
  });
  assert.deepEqual(await gate.enterPrivate(), {
    ok: false,
    reason: 'persist_failed',
  });
  assert.equal(gate.privateConversation(), false);
  // 入っていない状態（通常の区切り）にファイルを合わせ直す。
  assert.deepEqual(clock.disk, {
    segment_generation: '1',
    private_open: false,
  });
  const sink = new RecordingNoticeSink();
  await StorageModeGate.open({
    clock,
    notices: sink,
    now: () => NOW,
    newId: ids(SEG_D, NOTICE_ID),
  });
  assert.deepEqual(sink.boundaryNotices, []);
});

// ---- 実ファイル ---------------------------------------------------------------------------------------------

test('real file: the boundary survives a restart and the clock fields are untouched by a boundary write', async (t) => {
  const dir = await tempDir(t);
  const file = createClockStateFile(dir);
  await writeFile(
    join(dir, CLOCK_STATE_FILE),
    serializeClockState(clockContent(null)),
  );
  const first = await StorageModeGate.open({
    clock: file,
    now: () => NOW,
    newId: ids(SEG_A, SEG_B, SEG_C),
  });
  assert.equal((await first.enterPrivate()).ok, true);
  // 世代の欄だけが変わる（版・最終確認時刻・採り直しの記録は同じ）。
  const written = await readFileContent(dir);
  assert.deepEqual(
    written,
    clockContent({
      segment_generation: '2',
      private_open: true,
    }),
  );
  // 再起動。記録しない区切りが開いていたので、通常に戻して知らせる。
  const sink = new RecordingNoticeSink();
  const second = await StorageModeGate.open({
    clock: createClockStateFile(dir),
    notices: sink,
    now: () => NOW,
    newId: ids('00000000-0000-4000-8000-000000000c01', NOTICE_ID),
  });
  assert.equal(second.origin().segment_generation, '3');
  assert.equal(sink.boundaryNotices[0]?.ended_generation, '2');
  assert.deepEqual(
    await readFileContent(dir),
    clockContent({
      segment_generation: '3',
      private_open: false,
    }),
  );
});

test('real file: the sweeper-side save keeps the latest boundary written by the gate (no lost update)', async (t) => {
  const dir = await tempDir(t);
  const file = createClockStateFile(dir);
  await writeFile(
    join(dir, CLOCK_STATE_FILE),
    serializeClockState(clockContent(null)),
  );
  const loaded = await file.load();
  assert.equal(loaded.status, 'verified');
  const stale =
    loaded.status === 'verified' ? loaded.content : clockContent(null);
  // 掃除の job が控えた内容（storage_boundary は古い null）を、世代を書いた後で保存する。
  assert.equal(
    await file.saveBoundary({ segment_generation: '9', private_open: true }),
    'saved',
  );
  await file.save({ ...stale, revision: stale.revision + 1 });
  const written = await readFileContent(dir);
  assert.equal(written?.revision, 6);
  assert.deepEqual(written?.storage_boundary, {
    segment_generation: '9',
    private_open: true,
  });
});

test('real file: simultaneous sweeper saves and boundary writes never drop either field', async (t) => {
  const dir = await tempDir(t);
  const file = createClockStateFile(dir);
  await writeFile(
    join(dir, CLOCK_STATE_FILE),
    serializeClockState(clockContent(null)),
  );
  const loaded = await file.load();
  const base =
    loaded.status === 'verified' ? loaded.content : clockContent(null);
  const writes: Promise<unknown>[] = [];
  for (let i = 1; i <= 12; i += 1) {
    writes.push(file.save({ ...base, revision: base.revision + i }));
    writes.push(
      file.saveBoundary({
        segment_generation: String(i),
        private_open: i % 2 === 0,
      }),
    );
  }
  await Promise.all(writes);
  const written = await readFileContent(dir);
  // 最後に書いた順で決まる: 版は 5 + 12、世代は 12（偶数なので private_open は true）。
  assert.equal(written?.revision, 17);
  assert.deepEqual(written?.storage_boundary, {
    segment_generation: '12',
    private_open: true,
  });
});

test('real file: a missing, damaged or unreadable clock file is never created or repaired by a boundary write', async (t) => {
  const dir = await tempDir(t);
  const file = createClockStateFile(dir);
  // 無い。
  assert.deepEqual(await file.loadBoundary(), { status: 'unavailable' });
  assert.equal(
    await file.saveBoundary({ segment_generation: '1', private_open: false }),
    'unavailable',
  );
  await assert.rejects(readFile(join(dir, CLOCK_STATE_FILE)), /ENOENT/u);
  // 壊れている（ファイル全体）。書き換えない。
  await writeFile(join(dir, CLOCK_STATE_FILE), '{"schema":');
  assert.deepEqual(await file.loadBoundary(), { status: 'unavailable' });
  assert.equal(
    await file.saveBoundary({ segment_generation: '1', private_open: false }),
    'unavailable',
  );
  assert.equal(
    await readFile(join(dir, CLOCK_STATE_FILE), 'utf8'),
    '{"schema":',
  );
});

test('real file: every malformed storage_boundary shape is invalid, not guessed', async (t) => {
  const dir = await tempDir(t);
  const file = createClockStateFile(dir);
  const shapes: unknown[] = [
    {},
    { segment_generation: '1' },
    { private_open: true },
    { segment_generation: 1, private_open: true },
    { segment_generation: '01', private_open: true },
    { segment_generation: '-1', private_open: true },
    { segment_generation: '', private_open: true },
    { segment_generation: '1'.repeat(20), private_open: true },
    { segment_generation: '1', private_open: 'true' },
    { segment_generation: '1', private_open: 1 },
    { segment_generation: '1', private_open: true, extra: 0 },
    [],
    'text',
    7,
    false,
  ];
  for (const shape of shapes) {
    await writeFile(
      join(dir, CLOCK_STATE_FILE),
      serializeClockState(
        clockContent(shape as ClockStateContent['storage_boundary']),
      ),
    );
    assert.deepEqual(
      await file.loadBoundary(),
      { status: 'invalid' },
      JSON.stringify(shape),
    );
  }
  // 19 桁までの 10 進は読める。
  await writeFile(
    join(dir, CLOCK_STATE_FILE),
    serializeClockState(
      clockContent({ segment_generation: '9'.repeat(19), private_open: false }),
    ),
  );
  assert.deepEqual(await file.loadBoundary(), {
    status: 'ok',
    record: { segment_generation: '9'.repeat(19), private_open: false },
  });
});
