// 島を広げるきっかけ（ADR 0181 の段階 2）を、確認が必要な操作の一覧と行の知らせの流れから作るフック。
// 判断は純粋な関数 nextIslandMemory（island-state.ts）が持ち、ここは前の値を覚えて時刻を渡すだけ。
import { useEffect, useState } from 'react';
import type { DesktopOperationEntry, StorageMode } from '@buddy/contracts';
import { EMPTY_ISLAND_MEMORY, nextIslandMemory } from './island-state.js';
import type { IslandSignals } from './island-state.js';
import type { Notice } from './work-state.js';

export function useIslandSignals(
  shown: boolean,
  operations: readonly DesktopOperationEntry[],
  notices: Readonly<Record<string, Notice>>,
  // 状態欄の保存モード（UI-05 の段階 6、ADR 0189）。変わったら区切りの知らせで島を広げる。
  storageMode: StorageMode | null = null,
  // 承認を待つ記録しない会話の独立した確認の数（ADR 0197）。確認が必要な操作に足して数える。
  privateConfirmations = 0,
): IslandSignals {
  const [memory, setMemory] = useState(EMPTY_ISLAND_MEMORY);
  useEffect(() => {
    setMemory((previous) =>
      nextIslandMemory(
        previous,
        { shown, operations, notices, storageMode, privateConfirmations },
        Date.now(),
      ),
    );
  }, [shown, operations, notices, storageMode, privateConfirmations]);
  return memory.signals;
}
