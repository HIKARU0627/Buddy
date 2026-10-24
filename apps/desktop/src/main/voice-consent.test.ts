// 外部への送信の同意の端末側の記録（B05-06、ADR 0038・0050）。一時ディレクトリだけを使う。期待値は手で書く。
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  VOICE_CONSENT_FILE,
  VOICE_CONSENT_POLICY_VERSION,
  VoiceConsentStore,
  consentRecordFrom,
  loadVoiceConsentFile,
  localConsentStatus,
  saveVoiceConsentFile,
  voiceConsentText,
  type LocalVoiceConsent,
} from './voice-consent.js';

const GRANTED: LocalVoiceConsent = {
  kind: 'voice_live_audio',
  provider: 'openai_live',
  policy_version: '1',
  state: 'granted',
  method: 'os_dialog_main',
  confirmed_at: '2030-10-04T00:00:00.000Z',
  revoked_at: null,
};

test('only a well-formed record for the current policy version counts as consent', () => {
  assert.equal(VOICE_CONSENT_POLICY_VERSION, '1');
  assert.equal(localConsentStatus(consentRecordFrom(GRANTED)), 'granted');
  assert.equal(localConsentStatus(null), 'required');
  assert.equal(
    localConsentStatus(consentRecordFrom({ ...GRANTED, policy_version: '0' })),
    'required',
  );
  const revoked = {
    ...GRANTED,
    state: 'revoked',
    revoked_at: '2030-10-05T00:00:00.000Z',
  };
  assert.equal(localConsentStatus(consentRecordFrom(revoked)), 'required');
  for (const bad of [
    null,
    [],
    'granted',
    { ...GRANTED, method: 'renderer' },
    { ...GRANTED, kind: 'transcript' },
    { ...GRANTED, provider: 'other' },
    { ...GRANTED, policy_version: '01' },
    { ...GRANTED, state: 'maybe' },
    { ...GRANTED, confirmed_at: 'yesterday' },
    { ...GRANTED, revoked_at: '2030-10-05T00:00:00.000Z' },
    { ...revoked, revoked_at: null },
    { ...revoked, revoked_at: '2030-10-03T00:00:00.000Z' },
    { ...GRANTED, extra: true },
  ])
    assert.equal(consentRecordFrom(bad), null, JSON.stringify(bad));
});

test('grant and revoke are recorded; an unreadable or invalid record means no consent', () => {
  const saved: LocalVoiceConsent[] = [];
  const logs: string[] = [];
  let now = '2030-10-05T01:00:00.000Z';
  const store = new VoiceConsentStore({
    load: () => null,
    save: (record) => saved.push(record),
    now: () => now,
    log: (code) => logs.push(code),
  });
  assert.equal(store.status, 'required');
  store.grant();
  assert.equal(store.status, 'granted');
  assert.deepEqual(saved.at(-1), {
    ...GRANTED,
    confirmed_at: '2030-10-05T01:00:00.000Z',
  });
  now = '2030-10-05T02:00:00.000Z';
  store.revoke();
  assert.equal(store.status, 'required');
  assert.deepEqual(saved.at(-1), {
    ...GRANTED,
    state: 'revoked',
    confirmed_at: '2030-10-05T01:00:00.000Z',
    revoked_at: '2030-10-05T02:00:00.000Z',
  });

  const broken = new VoiceConsentStore({
    load: () => {
      throw new SyntaxError('bad json');
    },
    save: () => undefined,
    now: () => now,
    log: (code) => logs.push(code),
  });
  assert.equal(broken.status, 'required');
  const invalid = new VoiceConsentStore({
    load: () => ({ ...GRANTED, method: 'llm' }),
    save: () => undefined,
    now: () => now,
    log: (code) => logs.push(code),
  });
  assert.equal(invalid.status, 'required');
  assert.deepEqual(logs, ['voice_consent_unreadable', 'voice_consent_invalid']);
});

test('a failed save keeps the decision for this run (granted stays granted, revoked stays revoked)', () => {
  const logs: string[] = [];
  const store = new VoiceConsentStore({
    load: () => GRANTED,
    save: () => {
      throw new Error('disk full');
    },
    now: () => '2030-10-05T03:00:00.000Z',
    log: (code) => logs.push(code),
  });
  store.revoke();
  assert.equal(store.status, 'required');
  store.grant();
  assert.equal(store.status, 'granted');
  assert.deepEqual(logs, [
    'voice_consent_save_failed',
    'voice_consent_save_failed',
  ]);
});

test('the file is written atomically with owner-only permissions and read back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-voice-consent-'));
  try {
    const path = join(dir, VOICE_CONSENT_FILE);
    assert.equal(loadVoiceConsentFile(path), null);
    saveVoiceConsentFile(path, GRANTED);
    assert.deepEqual(loadVoiceConsentFile(path), GRANTED);
    assert.equal(readFileSync(path, 'utf8'), `${JSON.stringify(GRANTED)}\n`);
    if (process.platform !== 'win32')
      assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() =>
      saveVoiceConsentFile(path, { ...GRANTED, method: 'x' } as never),
    );
    writeFileSync(path, '{not json');
    assert.throws(() => loadVoiceConsentFile(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the dialog says where the voice goes, that it is shown while talking, and how to revoke; "やめる" is first', () => {
  const text = voiceConsentText();
  assert.equal(text.buttons[0], 'やめる');
  assert.equal(text.buttons[1], '同意して続ける');
  assert.match(text.message, /OpenAI/u);
  assert.match(text.detail, /印と効果音/u);
  assert.match(text.detail, /取り消せます/u);
  assert.match(text.detail, /文字で返す/u);
});
