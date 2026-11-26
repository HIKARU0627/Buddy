// 家計簿の重なっていそうな記録（家計簿 段階 3 の一部、ADR 0168）。
//
// 同じ利用が二つの出所から記録されたかもしれない組を見つける（カードの利用を手でも入れた、利用通知の後に書き出しの
// 同じ行を取り込んだ、など）。見つけるだけで、消すかどうかは本人が決める（自動では消さない）。
// - 同じ組: 向き・利用した日・金額が同じ記録。
// - 重なっていそうとみなす: 組の中に出所の種類が違う記録があるか、手入力の記録が二つ以上ある。利用通知だけ・書き出し
//   だけの組は、別々の通知・別々の行として記録されたもの（同じ日に同じ金額を二度使った）なので数えない。
// 時計・暗号・DB はここで扱わない。

import type { HouseholdDirection, HouseholdSourceKind } from './household.js';

export interface HouseholdDuplicateCandidate {
  // 呼び出し側が記録を指す値（画面の参照など）。
  readonly key: string;
  readonly source_kind: HouseholdSourceKind;
  readonly direction: HouseholdDirection;
  readonly occurred_on: string;
  readonly amount_yen: number;
}

/** 重なっていそうな記録の組（組の中は渡した順、組は最初の記録の順）。 */
export function householdDuplicateGroups(
  entries: readonly HouseholdDuplicateCandidate[],
): string[][] {
  const groups = new Map<string, HouseholdDuplicateCandidate[]>();
  for (const entry of entries) {
    const key = `${entry.direction}|${entry.occurred_on}|${String(entry.amount_yen)}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const found: string[][] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const kinds = new Set(group.map((entry) => entry.source_kind));
    const manual = group.filter((entry) => entry.source_kind === 'manual');
    if (kinds.size > 1 || manual.length > 1)
      found.push(group.map((entry) => entry.key));
  }
  return found;
}
