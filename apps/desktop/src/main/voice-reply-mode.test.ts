// 端末ごとの返し方（声／文字）の記録（B05-05、ADR 0052）。記録がなければ声、あるのに読めない・形が違うときは文字
// （外へ音声を送らない側へ倒す）。保存に失敗しても、この起動の間は選んだ値で動く。一時ディレクトリを使い、
// 実際のマイク・音声・実 API は使わない。期待値は手で書いた。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  VOICE_REPLY_MODE_FILE,
  VoiceReplyModeStore,
  loadVoiceReplyModeFile,
  memoryReplyModeStore,
  replyModeRecordFrom,
  saveVoiceReplyModeFile,
} from './voice-reply-mode.js';

test('the record is exactly {"reply_mode":"voice"|"text"}; anything else is not a record', () => {
  assert.equal(replyModeRecordFrom({ reply_mode: 'voice' }), 'voice');
  assert.equal(replyModeRecordFrom({ reply_mode: 'text' }), 'text');
  for (const bad of [
    null,
    undefined,
    'text',
    7,
    [],
    {},
    { reply_mode: 'both' },
    { reply_mode: '' },
    { reply_mode: null },
    { reply_mode: 'text', extra: 1 },
    { mode: 'text' },
  ])
    assert.equal(replyModeRecordFrom(bad), null, JSON.stringify(bad));
});

test('no record means voice, an unreadable or malformed record means text, a saved record is used as it is', () => {
  const logs: string[] = [];
  const store = (load: () => unknown) =>
    new VoiceReplyModeStore({
      load,
      save: () => undefined,
      log: (code) => logs.push(code),
    });
  assert.equal(store(() => undefined).mode, 'voice');
  assert.deepEqual(logs, []);
  assert.equal(store(() => ({ reply_mode: 'text' })).mode, 'text');
  assert.equal(store(() => ({ reply_mode: 'voice' })).mode, 'voice');
  assert.equal(
    store(() => {
      throw new Error('unreadable');
    }).mode,
    'text',
  );
  assert.equal(store(() => ({ reply_mode: 'both' })).mode, 'text');
  assert.equal(store(() => 'voice').mode, 'text');
  // JSON の null は「記録がない」ではなく「記録があって形が違う」（外へ音声を送らない側）。
  assert.equal(store(() => null).mode, 'text');
  assert.deepEqual(logs, [
    'voice_reply_mode_unreadable',
    'voice_reply_mode_invalid',
    'voice_reply_mode_invalid',
    'voice_reply_mode_invalid',
  ]);
});

test('a chosen mode is kept even when saving fails, and the failure is logged', () => {
  const saved: string[] = [];
  const logs: string[] = [];
  let fail = false;
  const store = new VoiceReplyModeStore({
    load: () => undefined,
    save: (mode) => {
      if (fail) throw new Error('disk full');
      saved.push(mode);
    },
    log: (code) => logs.push(code),
  });
  store.set('text');
  assert.equal(store.mode, 'text');
  fail = true;
  store.set('voice');
  assert.equal(store.mode, 'voice');
  assert.deepEqual(saved, ['text']);
  assert.deepEqual(logs, ['voice_reply_mode_save_failed']);
  assert.equal(memoryReplyModeStore().mode, 'voice');
  assert.equal(memoryReplyModeStore('text').mode, 'text');
});

test('the file round trip: missing is null, a saved mode is read back, and a damaged file reads as text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-reply-mode-'));
  try {
    const path = join(dir, VOICE_REPLY_MODE_FILE);
    assert.equal(loadVoiceReplyModeFile(path), undefined);
    saveVoiceReplyModeFile(path, 'text');
    assert.equal(readFileSync(path, 'utf8'), '{"reply_mode":"text"}\n');
    assert.deepEqual(loadVoiceReplyModeFile(path), { reply_mode: 'text' });
    saveVoiceReplyModeFile(path, 'voice');
    const reopened = new VoiceReplyModeStore({
      load: () => loadVoiceReplyModeFile(path),
      save: (mode) => saveVoiceReplyModeFile(path, mode),
    });
    assert.equal(reopened.mode, 'voice');
    reopened.set('text');
    assert.equal(
      new VoiceReplyModeStore({
        load: () => loadVoiceReplyModeFile(path),
        save: () => undefined,
      }).mode,
      'text',
    );
    // ファイルがあって中身が JSON の null: 記録なしと区別して文字（声へ倒さない）。
    writeFileSync(path, 'null\n', 'utf8');
    assert.equal(loadVoiceReplyModeFile(path), null);
    assert.equal(
      new VoiceReplyModeStore({
        load: () => loadVoiceReplyModeFile(path),
        save: () => undefined,
      }).mode,
      'text',
    );
    writeFileSync(path, '{broken', 'utf8');
    assert.throws(() => loadVoiceReplyModeFile(path));
    assert.equal(
      new VoiceReplyModeStore({
        load: () => loadVoiceReplyModeFile(path),
        save: () => undefined,
      }).mode,
      'text',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
