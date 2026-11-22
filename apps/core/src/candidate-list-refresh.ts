// 気づき（候補）の一覧を開くたびの状態の見直し（B11-05 P1、ADR 0132。設計 11 §4、ADR 0120）。
//
// 一覧の取得（GET /v1/candidates）の前に、保守（runCandidateMaintenance）の 1・3（時間による遷移と保持の掃除）を回す。
// 根拠の再確認（checkEvidence）は渡さない（取り直す connector は B08・B09）。
// - 本人のタイムゾーンが決まっていない（zone() が null）ときは保守を回さず、一覧の処理にそのまま渡す（一覧が 503 で閉じる）。
// - 時計の巻き戻りの保留は呼び出し側の clock が確かめる（candidate-maintenance.ts の約束）。確かめられなければ保守を
//   回さない（スキップ）。
// - 保守の失敗・スキップは一覧の応答を止めない（保守の skipped と同じ思想）。理由はログに残すが、題・本文・候補の ID は
//   含めない（段階と理由のコードだけ）。
// - 同時に来た一覧の要求は、進行中の保守を待って相乗りする（保守を重ねない）。
// 実メール・実 API・実請求は使わない。
import type { DbWorkerClient } from '@buddy/storage';
import type { ApiRouteHandler } from './api-server.js';
import { runCandidateMaintenance } from './candidate-maintenance.js';
import type {
  CandidateMaintenancePorts,
  MaintenanceReport,
} from './candidate-maintenance.js';

// 呼び出し側が確かめた現在時刻。巻き戻り・時計の状態が確かめられないときは ok: false と理由のコード。
export type CandidateRefreshClock =
  | { readonly ok: true; readonly now: string }
  | { readonly ok: false; readonly reason: string };

export type CandidateRefreshOutcome =
  | { readonly kind: 'ran'; readonly report: MaintenanceReport }
  | { readonly kind: 'skipped'; readonly reason: string };

export interface CandidateListRefreshOptions {
  readonly client: Pick<DbWorkerClient, 'candidate'>;
  // 本人のタイムゾーン（IANA）。決まっていなければ null（一覧の経路と同じ出所を渡す）。
  readonly zone: () => string | null;
  // 時計の巻き戻りを見て確かめた現在時刻（UTC）。
  readonly clock: () => Promise<CandidateRefreshClock>;
  readonly log: (message: string) => void;
  // 試験で差し替える（既定は runCandidateMaintenance）。
  readonly maintain?: (
    ports: CandidateMaintenancePorts,
  ) => Promise<MaintenanceReport>;
}

export interface CandidateListRefresh {
  // 保守を 1 回回す（進行中なら相乗りする）。例外を投げない。
  refresh(): Promise<CandidateRefreshOutcome>;
  // 一覧の処理の前に refresh を挟んだ処理。保守の結果に関わらず一覧の処理の応答を返す。
  wrap(list: ApiRouteHandler): ApiRouteHandler;
}

// 報告の書かなかったもの（段階と理由）を、ID を含めずに 1 行のコードにする。
function skippedSummary(report: MaintenanceReport): string | null {
  if (report.skipped.length === 0) return null;
  const parts = new Set<string>();
  for (const item of report.skipped)
    parts.add(`${item.step}:${[...item.reasons].sort().join('+')}`);
  return [...parts].sort().join(',');
}

export function createCandidateListRefresh(
  options: CandidateListRefreshOptions,
): CandidateListRefresh {
  const maintain =
    options.maintain ??
    ((ports: CandidateMaintenancePorts) => runCandidateMaintenance(ports));
  let running: Promise<CandidateRefreshOutcome> | null = null;

  const once = async (): Promise<CandidateRefreshOutcome> => {
    let zone: string | null;
    try {
      zone = options.zone();
    } catch {
      zone = null;
    }
    if (zone === null) return { kind: 'skipped', reason: 'zone_unavailable' };
    let clock: CandidateRefreshClock;
    try {
      clock = await options.clock();
    } catch {
      clock = { ok: false, reason: 'clock_unreadable' };
    }
    if (!clock.ok) {
      options.log(`candidate_refresh_skipped:${clock.reason}`);
      return { kind: 'skipped', reason: clock.reason };
    }
    const now = clock.now;
    let report: MaintenanceReport;
    try {
      report = await maintain({
        client: options.client,
        zone,
        now: () => now,
      });
    } catch {
      options.log('candidate_refresh_skipped:maintenance_failed');
      return { kind: 'skipped', reason: 'maintenance_failed' };
    }
    const skipped = skippedSummary(report);
    if (skipped !== null) options.log(`candidate_refresh_partial:${skipped}`);
    return { kind: 'ran', report };
  };

  const refresh = (): Promise<CandidateRefreshOutcome> => {
    if (running !== null) return running;
    const current = once().finally(() => {
      running = null;
    });
    running = current;
    return current;
  };

  return {
    refresh,
    wrap: (list) => async (request) => {
      await refresh();
      return list(request);
    },
  };
}
