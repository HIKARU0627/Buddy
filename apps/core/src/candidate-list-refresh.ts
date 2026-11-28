// 気づき（候補）の一覧を開くたびの状態の見直し（B11-05 P1、ADR 0132。設計 11 §4、ADR 0120）。
//
// 一覧の取得（GET /v1/candidates）の前に、保守（runCandidateMaintenance）の 1・3（時間による遷移と保持の掃除）を回す。
// 根拠の再確認（checkEvidence。candidate-evidence.ts、ADR 0201）は、渡されたときだけ、一覧の応答とは切り離して後ろで回す
// （一覧は待たない。U681）。前の再確認を始めてから一定の間隔（既定 15 分）が空いた一覧の要求のときだけ始め、走っている間は
// 重ねない。1 回あたりの件数（既定 20 件）と時間（既定 20 秒）の上限で止め、残りは続きの位置から次の回に回す。後ろの回で
// 状態が変わったときは、保存の書込みの知らせ（candidate-alerts.ts の件数の知らせ）で端末が読み直す。まとめて 1 回の判定に
// するために、渡されたら batch で包む。
// - 本人のタイムゾーンが決まっていない（zone() が null）ときは保守を回さず、一覧の処理にそのまま渡す（一覧が 503 で閉じる）。
// - 時計の巻き戻りの保留は呼び出し側の clock が確かめる（candidate-maintenance.ts の約束）。確かめられなければ保守を
//   回さない（スキップ）。
// - 保守の失敗・スキップは一覧の応答を止めない（保守の skipped と同じ思想）。理由はログに残すが、題・本文・候補の ID は
//   含めない（段階と理由のコードだけ）。
// - 同時に来た一覧の要求は、進行中の保守を待って相乗りする（保守を重ねない）。
// 実メール・実 API・実請求は使わない。
import type { DbWorkerClient } from '@buddy/storage';
import type { ApiRouteHandler } from './api-server.js';
import type { CandidateListCursor } from '@buddy/storage';
import {
  runCandidateEvidenceRecheck,
  runCandidateMaintenance,
} from './candidate-maintenance.js';
import type {
  CandidateMaintenancePorts,
  EvidenceRecheckReport,
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
  // 根拠を許可範囲から取り直す（ADR 0201）。省略は再確認しない。
  readonly checkEvidence?: CandidateMaintenancePorts['checkEvidence'];
  // 根拠の再確認の間隔（ミリ秒。既定 15 分）。前の再確認を始めてからこの間隔が空くまで、再確認を始めない。
  readonly evidenceIntervalMs?: number;
  // 1 回の再確認の件数と時間（ミリ秒）の上限（既定 20 件・20 秒）。
  readonly evidenceMaxChecks?: number;
  readonly evidenceBudgetMs?: number;
  // 時間の上限を数える時計（ミリ秒。既定 Date.now）。試験で差し替える。
  readonly monotonic?: () => number;
  // 後ろの回の書込みを、気づきの通知の 1 回の判定にまとめる（candidate-alerts.ts の batch）。
  readonly batch?: <T>(run: () => Promise<T>) => Promise<T>;
  // 後ろの回が終わったときに呼ぶ（試験用）。
  readonly onEvidenceRecheck?: (report: EvidenceRecheckReport) => void;
}

export const CANDIDATE_EVIDENCE_INTERVAL_MS = 15 * 60_000;
export const CANDIDATE_EVIDENCE_MAX_CHECKS = 20;
export const CANDIDATE_EVIDENCE_BUDGET_MS = 20_000;

export interface CandidateListRefresh {
  // 保守を 1 回回す（進行中なら相乗りする）。例外を投げない。
  refresh(): Promise<CandidateRefreshOutcome>;
  // 一覧の処理の前に refresh を挟んだ処理。保守の結果に関わらず一覧の処理の応答を返す。
  wrap(list: ApiRouteHandler): ApiRouteHandler;
  // 後ろで走っている根拠の再確認が終わるまで待つ（試験・終了用）。走っていなければすぐ返る。
  evidenceIdle(): Promise<void>;
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
  const evidenceInterval =
    options.evidenceIntervalMs ?? CANDIDATE_EVIDENCE_INTERVAL_MS;
  // 前の根拠の再確認を始めた時刻（確かめた時計のミリ秒）。まだなら null。
  let evidenceCheckedAt: number | null = null;
  // 走っている後ろの再確認と、前の回が上限で止めた続きの位置。
  let evidenceRunning: Promise<void> | null = null;
  let evidenceResume: CandidateListCursor | undefined;
  const monotonic = options.monotonic ?? (() => Date.now());

  // 根拠の再確認を後ろで 1 回回す。一覧の応答はこれを待たない。例外を投げない。
  const startEvidence = (zone: string, now: string): void => {
    const checkEvidence = options.checkEvidence;
    if (checkEvidence === undefined || evidenceRunning !== null) return;
    const startedAt = monotonic();
    const budget = options.evidenceBudgetMs ?? CANDIDATE_EVIDENCE_BUDGET_MS;
    const run = () =>
      runCandidateEvidenceRecheck(
        { client: options.client, zone, now: () => now, checkEvidence },
        {
          maxChecks: options.evidenceMaxChecks ?? CANDIDATE_EVIDENCE_MAX_CHECKS,
          expired: () => monotonic() - startedAt >= budget,
          ...(evidenceResume === undefined ? {} : { after: evidenceResume }),
        },
      );
    evidenceRunning = (options.batch === undefined ? run() : options.batch(run))
      .then(
        (report) => {
          evidenceResume = report.resume_after ?? undefined;
          if (report.stopped !== 'done')
            options.log(`candidate_evidence_recheck_stopped:${report.stopped}`);
          options.onEvidenceRecheck?.(report);
        },
        () => {
          options.log('candidate_evidence_recheck_failed');
        },
      )
      .finally(() => {
        evidenceRunning = null;
      });
  };

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
    const nowMs = Date.parse(now);
    let report: MaintenanceReport;
    try {
      report = await maintain({ client: options.client, zone, now: () => now });
    } catch {
      options.log('candidate_refresh_skipped:maintenance_failed');
      return { kind: 'skipped', reason: 'maintenance_failed' };
    }
    const skipped = skippedSummary(report);
    if (skipped !== null) options.log(`candidate_refresh_partial:${skipped}`);
    // 根拠の再確認は間隔が空いた回だけ、後ろで始める（待たない）。時計が前の再確認より前に戻っていたら、間隔が空いた
    // ものとして扱わない。走っている間は始めない（間隔の起点も動かさない）。
    if (
      options.checkEvidence !== undefined &&
      evidenceRunning === null &&
      Number.isFinite(nowMs) &&
      (evidenceCheckedAt === null ||
        nowMs - evidenceCheckedAt >= evidenceInterval)
    ) {
      evidenceCheckedAt = nowMs;
      startEvidence(zone, now);
    }
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
    evidenceIdle: async () => {
      await evidenceRunning;
    },
  };
}
