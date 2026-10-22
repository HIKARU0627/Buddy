// キャンバスを前に出す・後ろへ戻す（UI-02、本人の判断 2026-10-22、ADR 0032）。期待値は手で書く。Electron は起動しない。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANVAS_SUMMON_ACCELERATOR,
  CanvasPresence,
  MAC_DESKTOP_RELATIVE_LEVEL,
  canvasLayerOps,
  isDismissKey,
} from './canvas-presence.js';

const READY = { lockState: 'unlocked', canvasAvailable: true } as const;

test('summon raises the canvas once; a second summon does nothing', () => {
  const presence = new CanvasPresence();
  assert.equal(presence.layer, 'behind');
  assert.deepEqual(presence.summon('shortcut', READY), {
    ok: true,
    effect: 'raise',
  });
  assert.equal(presence.layer, 'front');
  assert.equal(presence.lastSource, 'shortcut');
  // 二重に呼ぶ（別の呼び方でも）: 何もしない。呼び方の記録も変えない。
  assert.deepEqual(presence.summon('status', READY), {
    ok: true,
    effect: 'none',
  });
  assert.deepEqual(presence.summon('input', READY), {
    ok: true,
    effect: 'none',
  });
  assert.equal(presence.layer, 'front');
  assert.equal(presence.lastSource, 'shortcut');
});

test('escape, moving to another app and hiding put it back; only the first dismiss lowers', () => {
  for (const reason of ['escape', 'blur', 'hidden', 'lock'] as const) {
    const presence = new CanvasPresence();
    presence.summon('input', READY);
    assert.equal(presence.dismiss(reason), 'lower', reason);
    assert.equal(presence.layer, 'behind');
    assert.equal(presence.lastSource, null);
    assert.equal(presence.lastDismissReason, reason);
    // 後ろにあるときに戻しても何もしない（blur が続けて来ても、もう一度は戻さない）。
    assert.equal(presence.dismiss('blur'), 'none', reason);
  }
  // 戻した後は、もう一度呼べる。
  const presence = new CanvasPresence();
  presence.summon('status', READY);
  presence.dismiss('escape');
  assert.deepEqual(presence.summon('status', READY), {
    ok: true,
    effect: 'raise',
  });
});

test('a locked or unknown lock state never summons the canvas', () => {
  for (const lockState of ['locked', 'unknown'] as const) {
    const presence = new CanvasPresence();
    for (const source of ['shortcut', 'status', 'input'] as const)
      assert.deepEqual(
        presence.summon(source, { lockState, canvasAvailable: true }),
        { ok: false, reason: 'device_locked' },
      );
    assert.equal(presence.layer, 'behind');
  }
  // キャンバスの窓がない（従来の窓の組み立て・閉じた後）なら呼ばない。ロックの拒否を先に返す。
  const presence = new CanvasPresence();
  assert.deepEqual(
    presence.summon('shortcut', {
      lockState: 'unlocked',
      canvasAvailable: false,
    }),
    { ok: false, reason: 'canvas_unavailable' },
  );
  assert.deepEqual(
    presence.summon('shortcut', {
      lockState: 'locked',
      canvasAvailable: false,
    }),
    { ok: false, reason: 'device_locked' },
  );
  assert.equal(presence.layer, 'behind');
});

test('locking while the canvas is in front puts it back', () => {
  const presence = new CanvasPresence();
  assert.equal(presence.lockChanged('locked'), 'none');
  presence.summon('shortcut', READY);
  assert.equal(presence.lockChanged('unlocked'), 'none');
  assert.equal(presence.layer, 'front');
  assert.equal(presence.lockChanged('unknown'), 'lower');
  assert.equal(presence.layer, 'behind');
  presence.summon('shortcut', READY);
  assert.equal(presence.lockChanged('locked'), 'lower');
  assert.equal(presence.layer, 'behind');
  // ロックの後は、解除するまで呼べない。
  assert.equal(
    presence.summon('shortcut', { lockState: 'locked', canvasAvailable: true })
      .ok,
    false,
  );
});

test('a reset (the canvas window was closed) forgets the front state', () => {
  const presence = new CanvasPresence();
  presence.summon('status', READY);
  presence.reset();
  assert.equal(presence.layer, 'behind');
  assert.equal(presence.lastSource, null);
});

test('only a plain Escape key-down puts the canvas back', () => {
  const key = {
    type: 'keyDown',
    key: 'Escape',
    alt: false,
    control: false,
    meta: false,
    shift: false,
  };
  assert.equal(isDismissKey(key), true);
  assert.equal(isDismissKey({ ...key, type: 'keyUp' }), false);
  assert.equal(isDismissKey({ ...key, key: 'Enter' }), false);
  for (const modifier of ['alt', 'control', 'meta', 'shift'] as const)
    assert.equal(isDismissKey({ ...key, [modifier]: true }), false, modifier);
});

test('macOS switches the level and key input; other platforms only focus or blur', () => {
  assert.deepEqual(canvasLayerOps('darwin', 'front'), [
    { op: 'set_focusable', value: true },
    { op: 'set_level', level: 'normal' },
    { op: 'show_focus' },
  ]);
  assert.deepEqual(canvasLayerOps('darwin', 'behind'), [
    { op: 'set_level', level: 'desktop' },
    { op: 'set_focusable', value: false },
    { op: 'blur' },
  ]);
  assert.deepEqual(canvasLayerOps('win32', 'front'), [{ op: 'show_focus' }]);
  assert.deepEqual(canvasLayerOps('win32', 'behind'), [{ op: 'blur' }]);
  // デスクトップの段（試作の実機で測った値）。
  assert.equal(MAC_DESKTOP_RELATIVE_LEVEL, -2147483624);
});

test('the default shortcut avoids the IME switching keys', () => {
  assert.equal(CANVAS_SUMMON_ACCELERATOR, 'CommandOrControl+Alt+Shift+B');
  const parts = CANVAS_SUMMON_ACCELERATOR.split('+');
  // Space を使わない（⌃Space・⌃⌥Space・⌘Space・Win+Space・Shift+Space は IME・入力ソースの切り替え）。
  assert.equal(parts.includes('Space'), false);
  // 修飾キーを 3 つ使う（ほかのアプリの既定とぶつかりにくくする）。
  assert.equal(parts.length, 4);
});
