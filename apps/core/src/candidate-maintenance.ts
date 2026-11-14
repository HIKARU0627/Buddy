// 気づき（候補）の保守（B11-04 P3、ADR 0120、設計 11 §4・§5B、設計 03 保存と忘却）。
//
// 定期（と起動時）に 1 回回す。順に次を行う。
//   1. 時間による遷移: 期限切れ（deadline_passed）とスヌーズの終わり（snooze_elapsed）。決めるのは domain の candidateDueEvent で、
//      書く前に DB worker が行を読み直して同じ判断になることを確かめる（時計の判断を呼び出し側だけに任せない）。
//   2. 根拠の再確認（注入された読み取りがあるとき）: 許可範囲から取り直した結果を domain の evidenceDecision で状態の遷移へ
//      変える。取得範囲外・削除は resolved、新しい版・取り直せないときは状態を変えない（資格の失効だけを報告する）。
//   3. 保持の掃除: 閉じた候補の題・抄録（7 日）と識別子の行（97 日）を candidate.sweep で消す。
// 時計の巻き戻りの保留（checkClock）は呼び出し側が先に行い、確かめた時刻を渡す。実メール・実 API・実請求は使わない。
import { candidateDueEvent, evidenceDecision } from '@buddy/domain';
import type {
  CandidateEvent,
  CandidateState,
  Deadline,
  EvidenceDecision,
  EvidenceObservation,
} from '@buddy/domain';
import type {
  CandidateListCursor,
  CandidateRow,
  DbWorkerClient,
} from '@buddy/storage';

export const LIVE_CANDIDATE_STATES: readonly CandidateState[] = [
  'new',
  'seen',
  'acted',
  'snoozed',
];

// 根拠の再確認の結果。予定の重複は、重複が解消した（予定の変更・辞退・取り消し）ときに 'overlap_resolved'。
export type CandidateCheck = EvidenceObservation | 'overlap_resolved';

export interface CandidateMaintenancePorts {
  readonly client: Pick<DbWorkerClient, 'candidate'>;
  // 本人のタイムゾーン（IANA）。
  readonly zone: string;
  // 呼び出し側が時計の巻き戻りを見て確かめた現在時刻（UTC）。
  readonly now: () => string;
  // 根拠を許可範囲から取り直す（B08・B09 の connector が実装する）。無ければ根拠の再確認を行わない。
  // 読み取りの失敗は例外にせず 'temporarily_unavailable' を返す（失敗で候補を解決しない）。
  readonly checkEvidence?: (candidate: CandidateRow) => Promise<CandidateCheck>;
}

export interface MaintenanceReport {
  // 期限切れで resolved にした候補。
  readonly deadline_passed: readonly string[];
  // スヌーズの終わりで new に戻した候補。
  readonly snooze_elapsed: readonly string[];
  // 根拠の再確認で resolved にした候補（取得範囲外・削除・重複の解消）。
  readonly evidence_resolved: readonly string[];
  // 根拠の資格を失効した（状態は変えていない）候補と、その扱い。
  readonly evidence_standing: readonly {
    readonly candidate_id: string;
    readonly evidence: EvidenceDecision['evidence'];
  }[];
  // 忘却された元情報の候補（物理削除は忘却の計画が行う。ここでは報告だけ）。
  readonly purge_requested: readonly string[];
  readonly swept: {
    readonly content_deleted: readonly string[];
    readonly deleted: readonly string[];
  };
  // 書かなかった（拒否された・読めなかった）もの。ID と理由だけ（本文・SQL を含めない）。
  readonly skipped: readonly {
    readonly candidate_id: string | null;
    readonly step: 'list' | 'due' | 'evidence' | 'sweep';
    readonly reasons: readonly string[];
  }[];
  // 頁数の上限で読み切れなかったとき true（残りは次の回に回る）。
  readonly truncated: boolean;
  // truncated のとき、次の回に渡す続きの位置（options.after）。同じ上限の反復でも後方へ進む。読み切ったら null。
  readonly resume_after: CandidateListCursor | null;
}

const toIso = (millis: number | null): string | null =>
  millis === null ? null : new Date(millis).toISOString();

// 保存した期限を domain の Deadline にする（原文は封筒の中なので空。期限の判定は原文を使わない）。
function domainDeadline(row: CandidateRow): Deadline {
  const deadline = row.deadline;
  switch (deadline.kind) {
    case 'instant':
      return {
        kind: 'instant',
        local_datetime: deadline.local_datetime,
        zone: deadline.zone,
        original_text: '',
      };
    case 'date':
      return { kind: 'date', date: deadline.date, original_text: '' };
    case 'unresolved':
      return {
        kind: 'unresolved',
        reason: deadline.reason as Extract<
          Deadline,
          { kind: 'unresolved' }
        >['reason'],
        original_text: '',
      };
    case 'none':
      return { kind: 'none' };
  }
}

export async function runCandidateMaintenance(
  ports: CandidateMaintenancePorts,
  options: {
    readonly limit?: number;
    readonly maxPages?: number;
    // 前の回の resume_after。省略は先頭から。
    readonly after?: CandidateListCursor;
  } = {},
): Promise<MaintenanceReport> {
  const limit = options.limit ?? 1000;
  const maxPages = options.maxPages ?? 100;
  const skipped: {
    candidate_id: string | null;
    step: 'list' | 'due' | 'evidence' | 'sweep';
    reasons: readonly string[];
  }[] = [];
  const deadlinePassed: string[] = [];
  const snoozeElapsed: string[] = [];
  const evidenceResolved: string[] = [];
  const evidenceStanding: {
    candidate_id: string;
    evidence: EvidenceDecision['evidence'];
  }[] = [];
  const purgeRequested: string[] = [];
  const now = ports.now();

  const transition = async (
    row: CandidateRow,
    event: CandidateEvent,
    step: 'due' | 'evidence',
  ): Promise<boolean> => {
    const out = await ports.client.candidate({
      kind: 'candidate.transition',
      input: {
        candidate_id: row.candidate_id,
        event,
        expected_state: row.state,
        zone: ports.zone,
        snooze_until: null,
        now,
      },
    });
    if (out.ok) return true;
    // 古い読み取り（別の経路が先に遷移させた）・時計の再確認で「まだ」だったものは、書かずに報告だけ。
    skipped.push({
      candidate_id: row.candidate_id,
      step,
      reasons: out.reasons,
    });
    return false;
  };

  const processRow = async (row: CandidateRow): Promise<void> => {
    // 1. 時間による遷移。
    const due = candidateDueEvent(
      {
        state: row.state,
        deadline: domainDeadline(row),
        initial_import: row.initial_import,
        created_at: toIso(row.created_at) ?? now,
        snooze_until: toIso(row.snooze_until),
      },
      now,
      ports.zone,
    );
    if (!due.ok) {
      skipped.push({
        candidate_id: row.candidate_id,
        step: 'due',
        reasons: [due.reason],
      });
      return;
    }
    if (due.event !== null) {
      if (await transition(row, due.event, 'due'))
        (due.event === 'deadline_passed' ? deadlinePassed : snoozeElapsed).push(
          row.candidate_id,
        );
      // 遷移した候補の根拠は、この回では再確認しない（閉じた・戻した直後）。
      return;
    }
    // 2. 根拠の再確認。
    if (ports.checkEvidence === undefined) return;
    let check: CandidateCheck;
    try {
      check = await ports.checkEvidence(row);
    } catch {
      // 読めなかった。解決せず、未確認として報告する。
      check = 'temporarily_unavailable';
    }
    if (check === 'overlap_resolved') {
      if (await transition(row, 'overlap_resolved', 'evidence'))
        evidenceResolved.push(row.candidate_id);
      return;
    }
    const decision = evidenceDecision(row.state, check);
    if (decision.purge) purgeRequested.push(row.candidate_id);
    if (decision.event !== null) {
      if (await transition(row, decision.event, 'evidence'))
        evidenceResolved.push(row.candidate_id);
    } else if (decision.evidence !== 'valid') {
      evidenceStanding.push({
        candidate_id: row.candidate_id,
        evidence: decision.evidence,
      });
    }
  };

  // 一覧は keyset で全頁を読む（上限で切れた先の候補にも保守が届く）。頁の途中で遷移した候補があっても、位置は動かない。
  let truncated = false;
  let after: CandidateListCursor | undefined = options.after;
  let resumeAfter: CandidateListCursor | null = null;
  for (let page = 0; ; page += 1) {
    const listed = await ports.client.candidate({
      kind: 'candidate.list',
      states: LIVE_CANDIDATE_STATES,
      limit,
      ...(after === undefined ? {} : { after }),
    });
    if (!listed.ok) {
      skipped.push({
        candidate_id: null,
        step: 'list',
        reasons: listed.reasons,
      });
      break;
    }
    for (const row of listed.value.candidates) await processRow(row);
    if (!listed.value.truncated || listed.value.next_after === null) break;
    // 頁数の上限（異常な件数で止まらなくなるのを防ぐ）。残りは次の回に回る。
    if (page + 1 >= maxPages) {
      truncated = true;
      resumeAfter = listed.value.next_after;
      break;
    }
    after = listed.value.next_after;
  }

  // 3. 保持の掃除。
  const swept = await ports.client.candidate({ kind: 'candidate.sweep', now });
  if (!swept.ok)
    skipped.push({ candidate_id: null, step: 'sweep', reasons: swept.reasons });
  return {
    deadline_passed: deadlinePassed,
    snooze_elapsed: snoozeElapsed,
    evidence_resolved: evidenceResolved,
    evidence_standing: evidenceStanding,
    purge_requested: purgeRequested,
    swept: swept.ok ? swept.value : { content_deleted: [], deleted: [] },
    skipped,
    truncated,
    resume_after: resumeAfter,
  };
}
