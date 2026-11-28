// 気づきの OS 通知とトレイの new の件数の表示（ADR 0073・0196）。Electron に依存しない純粋な関数で、main.ts が使う。
//
// - OS 通知を出すのは、中枢が出すと決めた数（CandidateNotice.alert_count）が 1 以上で、この端末がロック解除済みで、アプリの
//   どの窓も前面でないときだけ（ADR 0073）。設定の入・切は中枢の正本を main が読み直してから見る（core-link.ts）。
// - 文は定型だけ（「新しい気づきが N 件あります」）。題・差出人・期限・本文・種類を含めない（ADR 0073）。音は出さない。
// - トレイ: macOS はメニューバーのアイコンの横に件数（1 件以上のときだけ）、どの OS もツールチップに件数を添える。件数が
//   null（切・ロック中・読めていない）なら何も足さない。

import type { ClientLockState } from '@buddy/client';

export const CANDIDATE_ALERT_TITLE = 'Buddy';

export const candidateAlertBody = (count: number): string =>
  `新しい気づきが ${String(count)} 件あります`;

export function candidateAlertAllowed(input: {
  readonly count: number;
  readonly lockState: ClientLockState;
  readonly appFocused: boolean;
}): boolean {
  return (
    Number.isSafeInteger(input.count) &&
    input.count > 0 &&
    input.lockState === 'unlocked' &&
    !input.appFocused
  );
}

// macOS のメニューバーのアイコンの横の文字（Tray.setTitle）。0 件・出さないときは空。
export function candidateTrayTitle(count: number | null): string {
  return count === null || count <= 0 ? '' : ` ${String(count)}`;
}

// トレイのツールチップ。件数が null なら元のまま。
export function candidateTrayTooltip(
  base: string,
  count: number | null,
): string {
  return count === null ? base : `${base}・新しい気づき ${String(count)} 件`;
}
