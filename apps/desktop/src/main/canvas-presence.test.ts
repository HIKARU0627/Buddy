// キャンバスを前に出す・後ろへ戻す（UI-02、本人の判断 2026-10-22、ADR 0032）。期待値は手で書く。Electron は起動しない。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANVAS_SUMMON_ACCELERATOR,
  CanvasPresence,
  CanvasSummoner,
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

test('macOS switches the level and key input; other platforms switch key input and focus', () => {
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
  // Windows も、後ろにある間はフォーカスを受けない（呼んだときだけ受ける）。
  assert.deepEqual(canvasLayerOps('win32', 'front'), [
    { op: 'set_focusable', value: true },
    { op: 'show_focus' },
  ]);
  assert.deepEqual(canvasLayerOps('win32', 'behind'), [
    { op: 'set_focusable', value: false },
    { op: 'blur' },
  ]);
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

// --- 窓の模擬（PR #104 の再確認の P2 2 件）---
// フォーカスを受けない窓はクリックしても前面にならず、キー入力は前面の窓にだけ届く、という OS の振る舞いを模擬する。
// 前面が変わると、前の前面の窓に blur を知らせる（main の canvas の blur と同じ）。期待値は手で書く。
class FakeDesk {
  focused: FakeWindow | null = null;
  readonly keys: string[] = [];

  focus(window: FakeWindow): void {
    if (!window.focusable || !window.visible) return;
    if (this.focused === window) return;
    const before = this.focused;
    this.focused = window;
    before?.onBlur();
  }

  blur(window: FakeWindow): void {
    if (this.focused !== window) return;
    this.focused = null;
    window.onBlur();
  }

  click(window: FakeWindow): void {
    if (window.visible) this.focus(window);
  }

  // キー入力は前面の窓にだけ届く。
  key(name: string): string | null {
    const target = this.focused?.name ?? null;
    if (target !== null) this.keys.push(`${target}:${name}`);
    return target;
  }
}

class FakeWindow {
  visible = true;
  level: 'normal' | 'desktop' = 'desktop';
  onBlur: () => void = () => undefined;

  constructor(
    readonly desk: FakeDesk,
    readonly name: string,
    public focusable: boolean,
  ) {}

  setFocusable(value: boolean): void {
    this.focusable = value;
    if (!value) this.desk.blur(this);
  }

  setLevel(level: 'normal' | 'desktop'): void {
    this.level = level;
  }

  show(): void {
    this.visible = true;
  }

  showInactive(): void {
    // 前面を奪わない。ただし模擬では、表示の通知で前面の窓に blur が来る場合も確かめる（blurOnShow）。
    this.visible = true;
    if (this.blurOnShow && this.desk.focused !== null) {
      const before = this.desk.focused;
      before.onBlur();
    }
  }

  blurOnShow = false;

  focus(): void {
    this.desk.focus(this);
  }

  blur(): void {
    this.desk.blur(this);
  }

  hide(): void {
    this.visible = false;
    this.desk.blur(this);
  }

  isVisible(): boolean {
    return this.visible;
  }
}

function setup(platform: string) {
  const desk = new FakeDesk();
  const canvas = new FakeWindow(desk, 'canvas', false);
  const status = new FakeWindow(desk, 'status', true);
  const input = new FakeWindow(desk, 'input', true);
  const other = new FakeWindow(desk, 'other-app', true);
  const presence = new CanvasPresence();
  const logs: string[] = [];
  let lockState: 'unlocked' | 'locked' | 'unknown' = 'unlocked';
  const summoner = new CanvasSummoner({
    platform,
    presence,
    canvas: () => canvas,
    companions: () => [status, input],
    lockState: () => lockState,
    log: (code) => logs.push(code),
  });
  // main と同じく、キャンバスの blur で後ろへ戻す。
  canvas.onBlur = () => summoner.dismiss('blur');
  return {
    desk,
    canvas,
    status,
    input,
    other,
    presence,
    summoner,
    logs,
    lock: (state: 'unlocked' | 'locked' | 'unknown') => {
      lockState = state;
      summoner.lockChanged(state);
    },
  };
}

for (const platform of ['win32', 'darwin'] as const)
  test(`${platform}: summon, Escape, click again: the canvas gets no key input`, () => {
    const { desk, canvas, other, presence, summoner } = setup(platform);
    desk.click(other);
    // 後ろにある間はクリックしても前面にならない。
    desk.click(canvas);
    assert.equal(desk.key('a'), 'other-app');
    summoner.summon('shortcut');
    assert.equal(presence.layer, 'front');
    assert.equal(canvas.focusable, true);
    assert.equal(desk.key('b'), 'canvas');
    // Esc で戻す。
    assert.equal(summoner.dismiss('escape'), 'lower');
    assert.equal(presence.layer, 'behind');
    assert.equal(canvas.focusable, false);
    assert.notEqual(desk.focused, canvas);
    // もう一度クリックしても、キー入力は届かない。
    desk.click(canvas);
    assert.notEqual(desk.key('c'), 'canvas');
    assert.deepEqual(
      desk.keys.filter((key) => key.startsWith('canvas:')),
      ['canvas:b'],
    );
    // macOS はデスクトップの段に戻る。Windows は段を変えない（模擬の初期値のまま）。
    assert.equal(canvas.level, 'desktop');
  });

for (const platform of ['win32', 'darwin'] as const)
  test(`${platform}: after hiding every window, the shortcut shows all three and focuses the canvas`, () => {
    const { desk, canvas, status, input, presence, summoner } = setup(platform);
    // すべて隠す（desktop.window_hide。main は先にキャンバスを戻してから隠す）。
    summoner.dismiss('hidden');
    for (const window of [canvas, status, input]) window.hide();
    // 小さな窓の表示で前面の窓に blur が来ても、前に出す途中では戻さない。
    status.blurOnShow = true;
    input.blurOnShow = true;
    summoner.summon('shortcut');
    assert.deepEqual(
      [canvas.visible, status.visible, input.visible],
      [true, true, true],
    );
    assert.equal(desk.focused, canvas);
    assert.equal(presence.layer, 'front');
    assert.equal(desk.key('x'), 'canvas');
    // 前に出した後のほかの窓への移動では、いつもどおり戻る。
    desk.click(input);
    assert.equal(presence.layer, 'behind');
    assert.equal(canvas.focusable, false);
  });

test('a second summon keeps the canvas in front and focuses it again; lock refuses and puts it back', () => {
  const { desk, canvas, input, presence, summoner, logs, lock } =
    setup('win32');
  summoner.summon('input');
  assert.equal(desk.focused, canvas);
  // 二重に呼ぶ: 状態は変えず、キャンバスへフォーカスを戻す。
  assert.deepEqual(summoner.summon('status'), { ok: true, effect: 'none' });
  assert.equal(desk.focused, canvas);
  // ロックで戻り、ロック中は呼ばない（小さな窓も表示し直さない）。
  lock('locked');
  assert.equal(presence.layer, 'behind');
  assert.equal(canvas.focusable, false);
  input.hide();
  assert.deepEqual(summoner.summon('shortcut'), {
    ok: false,
    reason: 'device_locked',
  });
  assert.equal(input.visible, false);
  assert.deepEqual(logs, ['canvas_summon_refused:device_locked']);
});
