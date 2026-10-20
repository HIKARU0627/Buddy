// ウィンドウ・トレイ・画面の読み込み・遷移・送信元の判断（ADR 0015）。期待値は手で書く。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  APP_ENTRY_URL,
  CONTENT_SECURITY_POLICY,
  ClientLifecycle,
  TRAY_MENU,
  externalOpenTarget,
  isTrustedSender,
  navigationAllowed,
  resolveAppAsset,
  trayTooltip,
} from './window-policy.js';

const ROOT = resolve('buddy-renderer-root');

test('closing the window hides it to the tray until the client is quit', () => {
  const lifecycle = new ClientLifecycle();
  assert.equal(lifecycle.onWindowCloseRequested(), 'hide');
  assert.equal(lifecycle.onWindowCloseRequested(), 'hide');
  assert.equal(lifecycle.onAllWindowsClosed(), 'stay_in_tray');
  assert.equal(lifecycle.quitting, false);
  lifecycle.requestQuit();
  assert.equal(lifecycle.onWindowCloseRequested(), 'close');
  assert.equal(lifecycle.onAllWindowsClosed(), 'quit');
});

test('the tray menu has show, local stop and client quit, but no resume or hub stop', () => {
  assert.deepEqual(
    TRAY_MENU.map((item) => [item.action, item.label]),
    [
      ['show_window', 'Buddy を表示'],
      ['io_stop', 'この端末の入出力を停止'],
      ['client_quit', 'クライアントを終了（中枢は止めません）'],
    ],
  );
});

test('the tray tooltip hides content while locked or unknown', () => {
  assert.equal(
    trayTooltip({ visibility: 'hidden', lock_state: 'locked' }),
    'Buddy（ロック中）',
  );
  assert.equal(
    trayTooltip({ visibility: 'hidden', lock_state: 'unknown' }),
    'Buddy（ロック状態を確認中）',
  );
  const shown = {
    visibility: 'shown',
    lock_state: 'unlocked',
    stop_scope: 'local',
    input_permitted: false,
    io_epoch: '1',
    voice_state: null,
    hub_connection: 'not_connected',
    hub_last_confirmed_at: null,
    display_target: null,
    storage_mode: null,
    budget_held: null,
    safety_stopped: null,
  } as const;
  assert.equal(trayTooltip(shown), 'Buddy（この端末の入出力: 停止中）');
  assert.equal(
    trayTooltip({ ...shown, stop_scope: 'none', input_permitted: true }),
    'Buddy（この端末の入出力: 受付中）',
  );
});

test('only files inside the built renderer are served from the app scheme', () => {
  assert.equal(APP_ENTRY_URL, 'buddy://app/index.html');
  assert.deepEqual(resolveAppAsset(ROOT, 'buddy://app/index.html'), {
    path: join(ROOT, 'index.html'),
    contentType: 'text/html; charset=utf-8',
  });
  assert.deepEqual(resolveAppAsset(ROOT, 'buddy://app/'), {
    path: join(ROOT, 'index.html'),
    contentType: 'text/html; charset=utf-8',
  });
  assert.deepEqual(
    resolveAppAsset(ROOT, 'buddy://app/assets/index-AbC1.js?v=1'),
    {
      path: join(ROOT, 'assets', 'index-AbC1.js'),
      contentType: 'text/javascript; charset=utf-8',
    },
  );
  assert.deepEqual(resolveAppAsset(ROOT, 'buddy://app/assets/index-AbC1.css'), {
    path: join(ROOT, 'assets', 'index-AbC1.css'),
    contentType: 'text/css; charset=utf-8',
  });
  // URL の正規化で .. は根で止まり、ディレクトリの外へ出ない。
  assert.deepEqual(
    resolveAppAsset(ROOT, 'buddy://app/%2e%2e/%2e%2e/secret.html'),
    {
      path: join(ROOT, 'secret.html'),
      contentType: 'text/html; charset=utf-8',
    },
  );
  for (const url of [
    'buddy://app/..%2Fsecret.html',
    'buddy://app/assets%2F..%2F..%2Fsecret.js',
    'buddy://app/assets%5C..%5Csecret.js',
    'buddy://app/.env.js',
    'buddy://app/assets/',
    'buddy://app/index.js.map',
    'buddy://app/a%00.js',
    'buddy://app/c:%2Fwindows.js',
    'buddy://other/index.html',
    'buddy://user:pw@app/index.html',
    'https://app/index.html',
    'file:///etc/passwd',
    'not a url',
  ])
    assert.equal(resolveAppAsset(ROOT, url), null, url);
});

test('navigation stays on the app screen and new windows go only to the browser over https', () => {
  assert.equal(navigationAllowed('buddy://app/index.html'), true);
  assert.equal(navigationAllowed('https://example.com/'), false);
  assert.equal(navigationAllowed('file:///tmp/x.html'), false);
  assert.equal(navigationAllowed('javascript:alert(1)'), false);
  assert.equal(
    externalOpenTarget('https://example.com/a?b=1'),
    'https://example.com/a?b=1',
  );
  for (const url of [
    'http://example.com/',
    'https://user@example.com/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'buddy://app/index.html',
    'mailto:someone@example.com',
    '',
  ])
    assert.equal(externalOpenTarget(url), null, url);
});

test('only the main frame of the UI renderer showing the app screen is a trusted sender', () => {
  const trusted = {
    senderWebContentsId: 3,
    uiWebContentsId: 3,
    senderIsMainFrame: true,
    senderFrameUrl: 'buddy://app/index.html',
  };
  assert.equal(isTrustedSender(trusted), true);
  assert.equal(isTrustedSender({ ...trusted, senderWebContentsId: 4 }), false);
  assert.equal(isTrustedSender({ ...trusted, uiWebContentsId: null }), false);
  assert.equal(
    isTrustedSender({ ...trusted, senderIsMainFrame: false }),
    false,
  );
  assert.equal(isTrustedSender({ ...trusted, senderFrameUrl: null }), false);
  assert.equal(
    isTrustedSender({ ...trusted, senderFrameUrl: 'https://example.com/' }),
    false,
  );
});

test('the CSP allows no inline script, eval or outside connection', () => {
  assert.equal(
    CONTENT_SECURITY_POLICY,
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  // 画面の meta の CSP も同じ（meta で使えない frame-ancestors を除く）。
  const html = readFileSync(
    new URL('../../src/renderer/index.html', import.meta.url),
    'utf8',
  );
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(
    html,
  )?.[1];
  assert.equal(
    meta,
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'",
  );
});
