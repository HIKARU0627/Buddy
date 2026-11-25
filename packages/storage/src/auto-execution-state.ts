// 候補を起点にした自動実行の判定に使う DB の現在値（設計 11 §5・§5A・§5B、08 §1・§9、ADR 0146〜0149）。
//
// - Core が judgeAutoExecution に入れる事実のうち、DB に正本があるもの（安全停止・時間窓の件数・候補の状態・
//   依頼の状態と版・作成済みの操作・忘却の世代）を一つの読み取り transaction で返す。
// - ここで読んだ値は判定の材料にすぎない。操作の作成（operation.create）と送出の直前は、保存層が同じ値を
//   変更の transaction の中で読み直して照合する（ADR 0148 の最終ガード）。この読み取りを照合の代わりにしない。
// - 本文（題・抄録・確定 intent）は読まない。

import type { AutoApprovalCounter, EntityRecord } from '@buddy/domain';
import type { SqliteDatabase } from './connection.js';
import { readSafetyState } from './safety-store.js';
import { readConsistently } from './snapshot-store.js';

export interface AutoExecutionCandidateRow {
  readonly candidate_id: string;
  readonly candidate_kind: string;
  readonly state: string;
  readonly request_entity_id: string | null;
  readonly request_revision: string | null;
}

export interface AutoExecutionStateRecord {
  // 安全停止の状態と、方針による自動承認の時間窓（無ければ null）。
  readonly safety_stopped: boolean;
  readonly auto_approvals: AutoApprovalCounter | null;
  // 忘却台帳の世代（命令の forgetting_generation に使う）。
  readonly forgetting_generation: string;
  // 候補の行。無ければ null（忘却・期限切れで消えた）。
  readonly candidate: AutoExecutionCandidateRow | null;
  // 候補が指す依頼の現在値。候補に依頼が無い・依頼の行が無いときは null。
  readonly entity: {
    readonly record: EntityRecord;
    readonly request_revision: string;
  } | null;
}

const text = (value: number): string => String(value);

export function readAutoExecutionState(
  db: SqliteDatabase,
  candidateId: string,
): AutoExecutionStateRecord {
  return readConsistently(db, () => {
    const safety = readSafetyState(db);
    const forgetting = db
      .prepare(
        'SELECT coalesce(max(forgetting_generation), 0) AS value FROM forget_ledger',
      )
      .get() as { value: number };
    const row = db
      .prepare(
        'SELECT candidate_id, kind, state, request_entity_id, request_revision FROM notification_candidates WHERE candidate_id = ?',
      )
      .get(candidateId) as
      | {
          candidate_id: string;
          kind: string;
          state: string;
          request_entity_id: string | null;
          request_revision: number | null;
        }
      | undefined;
    const candidate: AutoExecutionCandidateRow | null =
      row === undefined
        ? null
        : {
            candidate_id: row.candidate_id,
            candidate_kind: row.kind,
            state: row.state,
            request_entity_id: row.request_entity_id,
            request_revision:
              row.request_revision === null ? null : text(row.request_revision),
          };
    let entity: AutoExecutionStateRecord['entity'] = null;
    if (candidate?.request_entity_id != null) {
      const found = db
        .prepare(
          'SELECT state, request_revision, recreation_suppressed FROM request_entities WHERE request_entity_id = ?',
        )
        .get(candidate.request_entity_id) as
        | {
            state: 'active' | 'cancelled' | 'completed';
            request_revision: number;
            recreation_suppressed: number;
          }
        | undefined;
      if (found !== undefined) {
        const created = db
          .prepare(
            'SELECT operation_kind, account_id, calendar_id FROM request_entity_operations WHERE request_entity_id = ? ORDER BY operation_kind, account_id, calendar_id',
          )
          .all(candidate.request_entity_id) as {
          operation_kind: string;
          account_id: string;
          calendar_id: string;
        }[];
        entity = {
          record: {
            request_entity_id: candidate.request_entity_id,
            state: found.state,
            recreation_suppressed: found.recreation_suppressed === 1,
            // カレンダーなしは DB では空文字。判定（autoCreationReasons）は null で比べる。
            created_operations: created.map((operation) => ({
              operation_kind: operation.operation_kind,
              account_id: operation.account_id,
              calendar_id:
                operation.calendar_id === '' ? null : operation.calendar_id,
            })),
          },
          request_revision: text(found.request_revision),
        };
      }
    }
    return {
      safety_stopped: safety.state === 'stopped',
      auto_approvals: safety.auto_approvals,
      forgetting_generation: text(forgetting.value),
      candidate,
      entity,
    };
  });
}
