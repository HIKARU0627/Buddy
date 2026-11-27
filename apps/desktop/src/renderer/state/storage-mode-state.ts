// 保存モードの切り替えの欄と、記録しない間の印・区切りの知らせ（UI-05 の段階 6、ADR 0189。設計 01 いつも見える状態、
// 03 記録しない会話の境界、ADR 0014・0024・0181）。React と DOM に依存しない純粋な関数だけを置き、node:test で試験する。
// 保存モードの正本は中枢（main が状態欄の storage_mode として渡す）。画面は表示と要求の組み立てだけで、切り替わったかは
// 状態欄の通知で知る（押した時点では表示を変えない）。
import type { DesktopStatusBar, StorageMode } from '@buddy/contracts';
import {
  STORAGE_MODE_CONTROL_LABELS,
  STORAGE_MODE_LABELS,
  storageBoundaryText,
} from '../labels.js';
import type { StatusLine } from '../tones.js';

// 切り替えの欄の選択肢の並び（固定。位置で覚えられるように）。
export const STORAGE_MODE_ORDER: readonly StorageMode[] = [
  'normal',
  'extended',
  'private',
];

// 状態欄から今の保存モード（ロック解除済みで、中枢から受け取っているときだけ）。
export function storageModeOf(
  status: DesktopStatusBar | null,
): StorageMode | null {
  return status?.visibility === 'shown' ? status.storage_mode : null;
}

// 記録しない間か（島の印・パネルの面）。受け取っていない・ロック中は false（印を出さない。未受信は専用の記号の点線で示す）。
export function privateModeOn(status: DesktopStatusBar | null): boolean {
  return storageModeOf(status) === 'private';
}

export interface StorageModeOption {
  readonly mode: StorageMode;
  readonly label: string;
  // 今の保存モードか（中枢の値。押しただけでは変えない）。
  readonly selected: boolean;
}

export type StorageModeControlView =
  | {
      // 出さない（ロック中・不明・受け取る前・中枢に接続していない）。
      readonly kind: 'hidden';
    }
  | {
      readonly kind: 'shown';
      readonly options: readonly StorageModeOption[];
      // 今の保存モードを中枢から受け取っていない（選ばれた物がない）。選べるが、どれが今の値かは出さない。
      readonly unknown: boolean;
      // 今の保存モードの記号と文言（選択肢の外に 1 行で出す。色だけに頼らない）。
      readonly line: StatusLine;
    };

// 今の保存モードの記号と文言。記録しないは ■（パネルの 8 項目と同じ記号）、それ以外は ●。未受信は記号なし。
export function storageModeLine(mode: StorageMode | null): StatusLine {
  if (mode === null)
    return {
      tone: 'neutral',
      mark: 'none',
      text: STORAGE_MODE_CONTROL_LABELS.unknown,
    };
  return {
    tone: 'neutral',
    mark: mode === 'private' ? 'square' : 'dot',
    text: STORAGE_MODE_LABELS[mode] ?? mode,
  };
}

// 切り替えの欄。ロック解除済みで中枢に接続している間だけ出す（中枢の値を読めないときに切り替えさせない）。
export function storageModeControlView(
  status: DesktopStatusBar | null,
): StorageModeControlView {
  if (status?.visibility !== 'shown' || status.hub_connection !== 'connected')
    return { kind: 'hidden' };
  const mode = status.storage_mode;
  return {
    kind: 'shown',
    options: STORAGE_MODE_ORDER.map((entry) => ({
      mode: entry,
      label: STORAGE_MODE_LABELS[entry] ?? entry,
      selected: entry === mode,
    })),
    unknown: mode === null,
    line: storageModeLine(mode),
  };
}

// 保存モードが変わったときの区切りの知らせ（島の広がる形・従来の窓の会話の区切りの行）。前も後も中枢から受け取った値の
// ときだけ（受け取っていなかった・ロック・切断の後の最初の値では知らせない。前の値が分からないので区切りと言えない）。
export interface StorageBoundary {
  readonly from: StorageMode;
  readonly to: StorageMode;
  readonly line: StatusLine;
}

export function storageBoundary(
  before: StorageMode | null,
  after: StorageMode | null,
): StorageBoundary | null {
  if (before === null || after === null) return null;
  const text = storageBoundaryText(before, after);
  if (text === null) return null;
  return {
    from: before,
    to: after,
    line: {
      tone: 'neutral',
      mark: after === 'private' ? 'square' : 'dot',
      text,
    },
  };
}
