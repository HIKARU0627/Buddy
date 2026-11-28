// メールの抽出の結果からの気づき（候補）の取り込みの入口（B11-04、ADR 0194、設計 11 §4・§5B）。
//
// 抽出の入口（mail-extraction.ts の createMailExtractor）が返した結果を受け、候補の下書き（candidate-intake.ts の
// mailCandidateDrafts）にして保存する（persistCandidateDrafts）。決めるのはコードの規則だけで、LLM の文をそのまま使わない。
// - フィルターで外したメール・抽出できなかったメール（送らなかった・失敗）からは作らない。
// - 記録しない会話の間は作らない。抽出を始めたときの区切り（保存境界の保持者の区切りの ID と世代）を控えて渡し、保存の直前に
//   今の区切りと照合する（api-turns.ts の originCurrent と同じ照合）。区切りが変わっていたら作らない。
// - 識別子は依頼 ID・依頼の版・期限から作るので、同じメールの再同期・再接続で二重に作らない（保存側が duplicate を返す）。
// 製品では抽出の入口そのものがまだ動いていない（LLM の抽出は実 API の承認の後。U546）。この入口は、抽出を配線するときに
// そのまま呼ぶ。
import type {
  CandidatePersistPorts,
  DraftSkip,
  MailCandidateContext,
  PersistedCandidate,
} from './candidate-intake.js';
import {
  mailCandidateDrafts,
  persistCandidateDrafts,
} from './candidate-intake.js';
import type { MailExtractionOutcome } from './mail-extraction.js';

export interface StorageSegment {
  readonly segment_id: string;
  readonly segment_generation: string;
}

export interface MailCandidateIntakePorts extends CandidatePersistPorts {
  // 保存境界の保持者（storage-gate.ts の privateConversation と origin）。
  readonly storage: {
    privateConversation(): boolean;
    origin(): StorageSegment;
  };
}

export type MailCandidateIntakeResult =
  | {
      readonly status: 'skipped';
      readonly reason:
        | 'filtered'
        | 'not_extracted'
        | 'private_conversation'
        | 'storage_boundary_changed';
    }
  | {
      readonly status: 'persisted';
      // 候補にしなかった依頼と理由（ID・理由だけ）。
      readonly skipped: readonly DraftSkip[];
      // 下書きごとの結果。途中で区切りが変わったら、残りは held（送っていない）。
      readonly results: readonly PersistedCandidate[];
    };

export async function intakeMailExtraction(
  ports: MailCandidateIntakePorts,
  input: {
    readonly outcome: MailExtractionOutcome;
    readonly context: MailCandidateContext;
    // 抽出を始めたときの区切り。
    readonly started: StorageSegment;
  },
): Promise<MailCandidateIntakeResult> {
  if (input.outcome.status === 'filtered')
    return { status: 'skipped', reason: 'filtered' };
  if (input.outcome.extraction.status !== 'extracted')
    return { status: 'skipped', reason: 'not_extracted' };
  if (ports.storage.privateConversation())
    return { status: 'skipped', reason: 'private_conversation' };
  // 今の区切りが抽出を始めたときと同じで、記録しない会話でないか。保存の前と、下書きを 1 件送る前ごとに照合する
  // （api-turns.ts の precommit と同じ形）。
  const current = (): boolean => {
    const present = ports.storage.origin();
    return (
      !ports.storage.privateConversation() &&
      present.segment_id === input.started.segment_id &&
      present.segment_generation === input.started.segment_generation
    );
  };
  if (!current())
    return { status: 'skipped', reason: 'storage_boundary_changed' };
  const { drafts, skipped } = mailCandidateDrafts(
    input.outcome.extraction.result,
    input.context,
  );
  const results =
    drafts.length === 0
      ? []
      : await persistCandidateDrafts({ ...ports, precommit: current }, drafts);
  return { status: 'persisted', skipped, results };
}
