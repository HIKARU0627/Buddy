// キャンバスを置く画面の設定（複数のモニターの設定。UI-06、ADR 0032）。
// - 端末に保存してよい配置の設定は、これ（S:DesktopCanvasDisplaySettings）だけ。キャンバスの本文・見出し・参照・
//   ユーザーの置き場所・操作の記録は保存しない（Core の RAM）。
// - 既定は主の画面。選んだ画面がなければ主の画面にする（設定は書き換えない）。キャンバス・状態の層・入力バーを同じ画面に置く。
//   すべての画面を 1 枚につなぐ形は作らない。
// - 保存は userData の canvas-display.json。読み込みは Schema（additionalProperties: false）で検査し、反すれば既定にする。
//   書き込みは一時ファイル → fsync → rename で原子的に行う（device-io-store と同じ）。
// Electron に依存しない（node:test で一時ディレクトリを使って試験する）。
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { DesktopCanvasDisplaySettings } from '@buddy/contracts';
import type { DisplayGeometry, Rect } from './window-roles.js';

export const CANVAS_DISPLAY_FILE = 'canvas-display.json';

export const DEFAULT_CANVAS_DISPLAY_SETTINGS: DesktopCanvasDisplaySettings = {
  schema_version: 1,
  target: 'primary',
};

const MAX_FILE_BYTES = 1024;

// OS の画面（Electron の Display の一部と同じ形）。
export interface DisplayLike {
  readonly id: number;
  readonly bounds: Rect;
  readonly workArea: Rect;
}

export interface ResolvedCanvasDisplay {
  readonly id: number;
  readonly geometry: DisplayGeometry;
  // 選んだ画面がなく、主の画面にした。
  readonly fallback: boolean;
}

// 設定と今の画面の一覧から、キャンバス・状態の層・入力バーを置く画面を 1 つ選ぶ。主の画面が一覧にない（起こらない
// はずの）ときは一覧の最初の画面。画面が 1 つもなければ null。
export function resolveCanvasDisplay(
  settings: DesktopCanvasDisplaySettings,
  displays: readonly DisplayLike[],
  primaryId: number,
): ResolvedCanvasDisplay | null {
  const primary =
    displays.find((display) => display.id === primaryId) ?? displays[0];
  if (primary === undefined) return null;
  const of = (display: DisplayLike, fallback: boolean) => ({
    id: display.id,
    geometry: { bounds: display.bounds, workArea: display.workArea },
    fallback,
  });
  if (settings.target === 'primary') return of(primary, false);
  const chosen = displays.find((display) => display.id === settings.display_id);
  return chosen === undefined ? of(primary, true) : of(chosen, false);
}

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'ENOENT';

export type CanvasDisplayLoad =
  | {
      readonly kind: 'missing';
      readonly settings: DesktopCanvasDisplaySettings;
    }
  | { readonly kind: 'loaded'; readonly settings: DesktopCanvasDisplaySettings }
  // 読めない・形が違う（本文などの余計な項目を含む）。既定にする。
  | {
      readonly kind: 'invalid';
      readonly settings: DesktopCanvasDisplaySettings;
    };

// 保存した設定を読む。valid は契約の検査（DesktopCanvasDisplaySettings）。
export function loadCanvasDisplaySettings(
  path: string,
  valid: (value: unknown) => boolean,
): CanvasDisplayLoad {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return {
      kind: isMissing(error) ? 'missing' : 'invalid',
      settings: DEFAULT_CANVAS_DISPLAY_SETTINGS,
    };
  }
  if (bytes.length > MAX_FILE_BYTES)
    return { kind: 'invalid', settings: DEFAULT_CANVAS_DISPLAY_SETTINGS };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { kind: 'invalid', settings: DEFAULT_CANVAS_DISPLAY_SETTINGS };
  }
  return valid(value)
    ? { kind: 'loaded', settings: value as DesktopCanvasDisplaySettings }
    : { kind: 'invalid', settings: DEFAULT_CANVAS_DISPLAY_SETTINGS };
}

// 設定を保存する。契約に合わない値（本文・見出し・置き場所などの余計な項目を含む）は書かずに false。
// 書くのは設定の項目だけ（受け取った値をそのまま書かず、項目を選び直す）。
export function saveCanvasDisplaySettings(
  path: string,
  settings: DesktopCanvasDisplaySettings,
  valid: (value: unknown) => boolean,
): boolean {
  if (!valid(settings)) return false;
  const picked: DesktopCanvasDisplaySettings =
    settings.target === 'primary'
      ? { schema_version: 1, target: 'primary' }
      : {
          schema_version: 1,
          target: 'display',
          display_id: settings.display_id,
        };
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(picked)}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return true;
}

// キャンバスの窓の大きさに対する、作業領域の外の幅（macOS のメニューバー・Dock。Windows は最大化の窓なので 0）。
// main はこれを desktop.canvas_work_area でキャンバスの窓へ送り、画面は配置のエンジンの空ける場所を計算し直す（窓の
// 大きさが変わらずに作業領域だけが変わったときも。PR #121 のレビュー P2）。受け取る前は、画面が window.screen から求める。
export function canvasInsetsOf(
  canvas: Rect,
  workArea: Rect,
): { top: number; right: number; bottom: number; left: number } {
  return {
    top: Math.max(0, workArea.y - canvas.y),
    left: Math.max(0, workArea.x - canvas.x),
    right: Math.max(0, canvas.x + canvas.width - (workArea.x + workArea.width)),
    bottom: Math.max(
      0,
      canvas.y + canvas.height - (workArea.y + workArea.height),
    ),
  };
}

// キャンバスの窓へ送る作業領域の外の幅の通知（UI-06）。値は整数のピクセルに丸める。
export function canvasWorkAreaNotification(
  canvas: Rect,
  workArea: Rect,
): {
  readonly channel: 'desktop.canvas_work_area';
  readonly insets: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
} {
  const insets = canvasInsetsOf(canvas, workArea);
  return {
    channel: 'desktop.canvas_work_area',
    insets: {
      top: Math.round(insets.top),
      right: Math.round(insets.right),
      bottom: Math.round(insets.bottom),
      left: Math.round(insets.left),
    },
  };
}
