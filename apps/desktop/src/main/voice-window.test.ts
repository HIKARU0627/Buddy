// 音声レンダラーの隔離（B05-06、ADR 0050。設計 10 §1）。窓の作り方・通信の拒否・読み込むファイル・権限・送信元の判定。
// Electron は起動しない（判定の純粋な関数を確かめる）。期待値は手で書く。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  VOICE_ACK_CHANNEL,
  VOICE_COMMAND_CHANNEL,
  VOICE_CONTENT_SECURITY_POLICY,
  VOICE_ENTRY_URL,
  VOICE_FAULT_ARG,
  VOICE_PARTITION,
  isVoiceSender,
  resolveVoiceAsset,
  voiceFaultSpec,
  voiceMode,
  voiceNavigationAllowed,
  voicePermissionAllowed,
  voiceRequestAllowed,
  voiceWindowOptions,
} from './voice-window.js';
import { APP_ENTRY_URL } from './window-policy.js';

test('the voice window is hidden, sandboxed, isolated and uses its own non-persistent session', () => {
  const options = voiceWindowOptions('/app/preload/voice-preload.cjs', {
    packaged: true,
    fault: 'hang=suspend_io',
  });
  assert.equal(options.show, false);
  assert.equal(options.focusable, false);
  assert.equal(options.skipTaskbar, true);
  assert.equal(options.frame, false);
  assert.deepEqual(options.webPreferences, {
    preload: '/app/preload/voice-preload.cjs',
    partition: 'buddy-voice-renderer',
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    spellcheck: false,
    devTools: false,
    backgroundThrottling: false,
    // 配布版は故障の注入を渡さない。
    additionalArguments: [],
  });
  // 保存しないセッション（persist: を付けない）。
  assert.ok(!VOICE_PARTITION.startsWith('persist:'));
  const dev = voiceWindowOptions('/p.cjs', {
    packaged: false,
    fault: 'delay=10',
  });
  assert.deepEqual(dev.webPreferences.additionalArguments, [
    '--buddy-voice-fault=delay=10',
  ]);
  assert.equal(dev.webPreferences.devTools, true);
  assert.equal(VOICE_FAULT_ARG, '--buddy-voice-fault=');
});

test('only the voice entry and its built scripts may be requested; every other request is refused', () => {
  for (const url of [
    'buddy-voice://renderer/voice.html',
    'buddy-voice://renderer/assets/voice-abc123.js',
  ])
    assert.equal(voiceRequestAllowed(url), true, url);
  for (const url of [
    'https://api.openai.com/v1/realtime',
    'http://127.0.0.1:47999/v1/bootstrap',
    'wss://example.invalid/socket',
    'ws://localhost/',
    'file:///etc/passwd',
    'data:text/html,<script>1</script>',
    'blob:buddy-voice://renderer/1',
    'devtools://devtools/bundled/inspector.html',
    APP_ENTRY_URL,
    'buddy://app/assets/index.js',
    'buddy-voice://other/voice.html',
    'buddy-voice://user:pw@renderer/voice.html',
    'buddy-voice://renderer/voice.html?x=1',
    'buddy-voice://renderer/voice.html#x',
    'buddy-voice://renderer/assets/style.css',
    'buddy-voice://renderer/assets/image.png',
    'buddy-voice://renderer/',
    'not a url',
  ])
    assert.equal(voiceRequestAllowed(url), false, url);
  // 遷移はどこへも許さない（最初の読み込みは loadURL）。
  assert.equal(voiceNavigationAllowed(VOICE_ENTRY_URL), false);
  assert.equal(voiceNavigationAllowed('https://example.com/'), false);
});

test('the voice scheme maps only to HTML and JS files inside the voice build directory', () => {
  const root = '/opt/buddy/dist/voice';
  assert.deepEqual(resolveVoiceAsset(root, VOICE_ENTRY_URL), {
    path: join(root, 'voice.html'),
    contentType: 'text/html; charset=utf-8',
  });
  assert.deepEqual(
    resolveVoiceAsset(root, 'buddy-voice://renderer/assets/voice-1.js'),
    {
      path: join(root, 'assets', 'voice-1.js'),
      contentType: 'text/javascript; charset=utf-8',
    },
  );
  // URL の正規化で「..」は消える。どの要求もビルドのディレクトリの外へは出ない。
  for (const url of [
    'buddy-voice://renderer/../renderer/index.html',
    'buddy-voice://renderer/%2e%2e/renderer/index.html',
  ])
    assert.equal(
      resolveVoiceAsset(root, url)?.path,
      join(root, 'renderer', 'index.html'),
      url,
    );
  for (const url of [
    'buddy-voice://renderer/assets/%2e%2e%2f%2e%2e%2findex.html',
    'buddy-voice://renderer/assets%2fvoice.js',
    'buddy-voice://renderer/.hidden.js',
    'buddy-voice://renderer/assets/a.css',
    'buddy-voice://renderer/',
    'buddy-voice://renderer/voice.html?q',
    'buddy://app/index.html',
    'https://renderer/voice.html',
  ])
    assert.equal(resolveVoiceAsset(root, url), null, url);
});

test('the voice CSP allows only same-scheme scripts and no connection, media, frame or worker', () => {
  assert.equal(
    VOICE_CONTENT_SECURITY_POLICY,
    "default-src 'none'; script-src 'self'; style-src 'none'; img-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
});

test('every permission (microphone, camera, notifications, ...) is refused for the mock renderer', () => {
  for (const permission of [
    'media',
    'audioCapture',
    'videoCapture',
    'notifications',
    'geolocation',
    'clipboard-read',
    'display-capture',
    'midi',
    'unknown',
  ])
    assert.equal(voicePermissionAllowed(permission), false, permission);
});

test('ACKs are taken only from the main frame of the current voice renderer', () => {
  const base = {
    senderWebContentsId: 21,
    voiceWebContentsId: 21,
    senderIsMainFrame: true,
    senderFrameUrl: VOICE_ENTRY_URL,
  };
  assert.equal(isVoiceSender(base), true);
  for (const facts of [
    { ...base, voiceWebContentsId: null },
    { ...base, senderWebContentsId: 22 },
    { ...base, senderIsMainFrame: false },
    { ...base, senderFrameUrl: null },
    { ...base, senderFrameUrl: APP_ENTRY_URL },
    { ...base, senderFrameUrl: 'https://example.com/' },
  ])
    assert.equal(isVoiceSender(facts), false, JSON.stringify(facts));
});

test('voice mode and faults are read only in a development start; packaged builds are always off', () => {
  assert.equal(
    voiceMode(['--buddy-voice=mock'], {}, { packaged: false }),
    'mock',
  );
  assert.equal(
    voiceMode([], { BUDDY_DESKTOP_VOICE: 'mock' }, { packaged: false }),
    'mock',
  );
  assert.equal(
    voiceMode(['--buddy-voice=mock'], {}, { packaged: true }),
    'off',
  );
  assert.equal(voiceMode([], {}, { packaged: false }), 'off');
  assert.equal(
    voiceMode(['--buddy-voice=real'], {}, { packaged: false }),
    'off',
  );
  assert.equal(
    voiceFaultSpec(
      ['--buddy-voice-fault=hang=suspend_io'],
      {},
      { packaged: false },
    ),
    'hang=suspend_io',
  );
  assert.equal(
    voiceFaultSpec(
      ['--buddy-voice-fault=hang=suspend_io'],
      {},
      { packaged: true },
    ),
    null,
  );
  assert.equal(
    voiceFaultSpec(['--buddy-voice-fault=$(rm)'], {}, { packaged: false }),
    null,
  );
  assert.equal(voiceFaultSpec([], {}, { packaged: false }), null);
});

// ビルド後の音声レンダラーの preload（dist/preload/voice-preload.cjs）を、模擬の contextBridge・ipcRenderer で動かす。
function loadVoicePreload(argv?: readonly string[]) {
  const exposed = new Map<string, Record<string, unknown>>();
  const sent: [string, unknown][] = [];
  const listeners = new Map<
    string,
    Set<(event: unknown, value: unknown) => void>
  >();
  const requested: string[] = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld: (key: string, api: Record<string, unknown>) =>
        exposed.set(key, api),
    },
    ipcRenderer: {
      send: (channel: string, value: unknown) => sent.push([channel, value]),
      on: (
        channel: string,
        listener: (event: unknown, value: unknown) => void,
      ) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)?.add(listener);
      },
      removeListener: (
        channel: string,
        listener: (event: unknown, value: unknown) => void,
      ) => listeners.get(channel)?.delete(listener),
      invoke: () => {
        throw new Error('voice preload must not invoke');
      },
    },
  };
  const source = readFileSync(
    new URL('../preload/voice-preload.cjs', import.meta.url),
    'utf8',
  );
  const module = { exports: {} };
  runInNewContext(source, {
    module,
    exports: module.exports,
    require: (name: string) => {
      requested.push(name);
      if (name !== 'electron') throw new Error(`unexpected require: ${name}`);
      return electron;
    },
    Error,
    ...(argv === undefined ? {} : { process: { argv } }),
  });
  return { exposed, sent, listeners, requested };
}

test('the voice preload exposes only command delivery, ACK and the fault spec', () => {
  const { exposed, requested, sent, listeners } = loadVoicePreload([
    '--buddy-voice-fault=drop=suspend_io',
  ]);
  assert.deepEqual(requested, ['electron']);
  assert.deepEqual([...exposed.keys()], ['buddyVoice']);
  const api = exposed.get('buddyVoice') as {
    faults: string | null;
    onCommand(listener: (value: unknown) => void): () => void;
    ack(value: unknown): void;
  };
  assert.deepEqual(Object.keys(api).sort(), ['ack', 'faults', 'onCommand']);
  assert.equal(api.faults, 'drop=suspend_io');
  const received: unknown[] = [];
  const off = api.onCommand((value) => received.push(value));
  assert.deepEqual([...listeners.keys()], [VOICE_COMMAND_CHANNEL]);
  // 命令の本体だけを渡し、Electron のイベント（送信元の情報）を渡さない。
  for (const listener of listeners.get(VOICE_COMMAND_CHANNEL) ?? [])
    listener({ sender: 'main', ports: [] }, { channel: 'voice.play' });
  assert.deepEqual(received, [{ channel: 'voice.play' }]);
  off();
  assert.equal(listeners.get(VOICE_COMMAND_CHANNEL)?.size, 0);
  api.ack({ request_id: 'x' });
  assert.deepEqual(sent, [[VOICE_ACK_CHANNEL, { request_id: 'x' }]]);
  // 知らない形の故障の指定・2 つ以上は渡さない。
  for (const argv of [
    [],
    ['--buddy-voice-fault=$(x)'],
    ['--buddy-voice-fault=a', '--buddy-voice-fault=b'],
  ])
    assert.equal(
      (loadVoicePreload(argv).exposed.get('buddyVoice') as { faults: unknown })
        .faults,
      null,
      argv.join(' '),
    );
});
