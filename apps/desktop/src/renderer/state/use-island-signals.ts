// 島を広げるきっかけ（ADR 0181 の段階 2）を、確認が必要な操作の一覧と行の知らせの流れから作るフック。
// 判断は純粋な関数 nextIslandMemory（island-state.ts）が持ち、ここは前の値を覚えて時刻を渡すだけ。
import { useEffect, useState } from 'react';
import type { DesktopOperationEntry } from '@buddy/contracts';
import { EMPTY_ISLAND_MEMORY, nextIslandMemory } from './island-state.js';
import type { IslandSignals } from './island-state.js';
import type { Notice } from './work-state.js';

export function useIslandSignals(
  shown: boolean,
  operations: readonly DesktopOperationEntry[],
  notices: Readonly<Record<string, Notice>>,
): IslandSignals {
  const [memory, setMemory] = useState(EMPTY_ISLAND_MEMORY);
  useEffect(() => {
    setMemory((previous) =>
      nextIslandMemory(previous, { shown, operations, notices }, Date.now()),
    );
  }, [shown, operations, notices]);
  return memory.signals;
}
