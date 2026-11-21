// 気づき（候補）の生成（B11-04 P1、ADR 0119、設計 11 §4・§5A、設計 04 気づきの作成）。
//
// - mailCandidateDrafts: 抽出の結果（ExtractionResult v2）から、メールの候補の下書きを作る。依頼の種類・宛先・引用・依頼 ID の
//   解決（5A）を見て、候補にしない依頼は理由を付けて返す。題は依頼の要約・期限・差出人の表示名から短く作り、未返信を断定する
//   題は固定の題に置き換える。LLM の文をそのまま通知の文にしない。
// - scheduleOverlapDrafts: 予定の重複（domain の findScheduleOverlaps の結果）から候補の下書きを作る。題は時刻から作る定型。
// - persistCandidateDrafts: 下書きを識別子（notification_key）へ変換し、題・抄録を暗号化して DB worker の candidate.create へ
//   渡す。同じ識別子の候補は作らない（再同期・再接続で二重に作らない）。結果は作った・すでにあった・拒否の別に返す。
// 承認・実行・状態・effect_kind はここで決めない（自動実行の判定は B13）。実メール・実 API・実請求は使わない。
import type {
  Deadline,
  ExtractionResult,
  ExtractedRequest,
} from '@buddy/contracts';
import {
  candidateLocalClock,
  candidateTitleErrors,
  notificationKey,
  parseCandidateUtc,
  scheduleOverlapDeadline,
} from '@buddy/domain';
import type {
  CandidateKindName,
  NotificationKeyParts,
  ScheduleOverlap,
} from '@buddy/domain';
import { sealBlob } from '@buddy/storage';
import type {
  CandidateCreateInput,
  CandidateOriginInput,
  CandidateRelatedAnalysisInput,
  DataKeyMaterial,
  DbWorkerClient,
  SealedBlobInput,
  SealedBlobOwner,
} from '@buddy/storage';

export const CANDIDATE_TITLE_LIMIT = 60;
export const CANDIDATE_EXCERPT_LIMIT = 200;

const codePoints = (text: string): string[] => [...text];

// コードポイントで数えて切る。切ったときは末尾を … にする。
function clip(text: string, limit: number): string {
  const chars = codePoints(text);
  return chars.length <= limit
    ? text
    : `${chars.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

const squash = (text: string): string => text.replace(/\s+/gu, ' ').trim();

// --- 下書き ---

export interface CandidateDraft {
  readonly candidate_kind: CandidateKindName;
  readonly key_parts: NotificationKeyParts;
  // 表示用の題（60 文字以内）。期限の原文は deadline_original_text に分けて、題の封筒の中に入れる。
  readonly title: string;
  readonly deadline: Deadline;
  // 根拠の抄録（200 文字以内）。無ければ null。
  readonly excerpt: string | null;
  readonly request_entity_id: string | null;
  readonly request_revision: string | null;
  readonly source_revision: string | null;
  readonly initial_import: boolean;
  readonly unread_partial: boolean;
  readonly related_analysis: CandidateRelatedAnalysisInput | null;
  // 受信（予定の重複では作った時刻）。UTC。
  readonly received_at: string;
  readonly origins: readonly CandidateOriginInput[];
}

export type DraftSkipReason =
  | 'not_a_request' // fyi（対応を求めていない）
  | 'not_addressed_to_me' // 別人宛て
  | 'in_quoted_text' // 引用の中の過去の依頼
  | 'entity_unresolved' // 依頼 ID を一意に決められない（5A）。気づきの前に解決が要る
  | 'revision_missing'
  | 'duplicate_in_batch'
  | 'time_invalid'
  | 'title_invalid';

export interface DraftSkip {
  readonly source: string;
  readonly reason: DraftSkipReason;
}

export interface MailCandidateContext {
  // 本人のタイムゾーン（IANA）。
  readonly zone: string;
  // メールの受信時刻（UTC）。
  readonly received_at: string;
  readonly initial_import: boolean;
  // 差出人の表示名。アドレスは渡さない（@ を含むものは使わない）。
  readonly sender_label: string | null;
  readonly related_analysis?: CandidateRelatedAnalysisInput | null;
}

function deadlineLabel(deadline: Deadline): string | null {
  const unpad = (value: string): number => Number(value);
  if (deadline.kind === 'instant') {
    const date = deadline.local_datetime.slice(5, 10).split('-');
    const time = deadline.local_datetime.slice(11, 16);
    return `${unpad(date[0] ?? '')}/${unpad(date[1] ?? '')} ${unpad(time.slice(0, 2))}:${time.slice(3, 5)}`;
  }
  if (deadline.kind === 'date') {
    const date = deadline.date.slice(5, 10).split('-');
    return `${unpad(date[0] ?? '')}/${unpad(date[1] ?? '')}`;
  }
  return null;
}

function deadlineOriginalText(deadline: Deadline): string | null {
  return deadline.kind === 'none' ? null : deadline.original_text;
}

const FALLBACK_TITLE: Readonly<Record<CandidateKindName, string>> = {
  mail_reply: '返信の依頼',
  mail_deadline: '対応の依頼',
  schedule_overlap: '予定の重複',
  research_done: '調査の完了',
};

// 題: 「依頼の要約：M/D H:MMまで（差出人）」。要約を削って 60 文字に収める。差出人・期限は先に外す。
// 未返信などを断定する題は固定の題に置き換える（原本: 返信の有無は確認できていない）。
export function mailCandidateTitle(input: {
  readonly kind: CandidateKindName;
  readonly summary: string;
  readonly deadline: Deadline;
  readonly sender_label: string | null;
}): string | null {
  const summary = squash(input.summary);
  const label = deadlineLabel(input.deadline);
  const sender =
    input.sender_label !== null &&
    !input.sender_label.includes('@') &&
    squash(input.sender_label) !== ''
      ? squash(input.sender_label)
      : null;
  const suffixes = [
    `${label === null ? '' : `：${label}まで`}${sender === null ? '' : `（${clip(sender, 12)}）`}`,
    label === null ? '' : `：${label}まで`,
    '',
  ];
  const build = (base: string): string | null => {
    for (const suffix of suffixes) {
      const budget = CANDIDATE_TITLE_LIMIT - codePoints(suffix).length;
      if (budget < 6) continue;
      const title = `${clip(base, budget)}${suffix}`;
      return candidateTitleErrors(title).length === 0 ? title : null;
    }
    return null;
  };
  const fromSummary = summary === '' ? null : build(summary);
  if (fromSummary !== null) return fromSummary;
  return build(FALLBACK_TITLE[input.kind]);
}

function excerptOf(request: ExtractedRequest): string | null {
  const preferred = request.fields.find(
    (field) => field.field === 'summary' && field.refs.length > 0,
  );
  const any = request.fields.find((field) => field.refs.length > 0);
  const quote = (preferred ?? any)?.refs[0]?.quote;
  if (quote === undefined) return null;
  const text = clip(squash(quote), CANDIDATE_EXCERPT_LIMIT);
  return text === '' ? null : text;
}

export function mailCandidateDrafts(
  result: ExtractionResult,
  context: MailCandidateContext,
): { readonly drafts: CandidateDraft[]; readonly skipped: DraftSkip[] } {
  const drafts: CandidateDraft[] = [];
  const skipped: DraftSkip[] = [];
  const seen = new Set<string>();
  const unreadPartial =
    result.completeness.unread_source_ids.length > 0 ||
    result.completeness.truncated_source_ids.length > 0;
  const requests = [...result.requests].sort(
    (a, b) => a.request_index - b.request_index,
  );
  for (const request of requests) {
    const source = `request:${request.request_index}`;
    const skip = (reason: DraftSkipReason): void => {
      skipped.push({ source, reason });
    };
    if (request.kind === 'fyi') {
      skip('not_a_request');
      continue;
    }
    if (!request.addressed_to_me) {
      skip('not_addressed_to_me');
      continue;
    }
    if (request.in_quoted_text) {
      skip('in_quoted_text');
      continue;
    }
    if (request.request_entity_id === null) {
      skip('entity_unresolved');
      continue;
    }
    if (request.request_revision === null) {
      skip('revision_missing');
      continue;
    }
    const kind: CandidateKindName =
      request.kind === 'reply_required' ? 'mail_reply' : 'mail_deadline';
    const title = mailCandidateTitle({
      kind,
      summary: request.summary,
      deadline: request.deadline,
      sender_label: context.sender_label,
    });
    if (title === null) {
      skip('title_invalid');
      continue;
    }
    const keyParts: NotificationKeyParts = {
      kind,
      source_account_id: result.source_account_id,
      request_entity_id: request.request_entity_id,
      request_revision: request.request_revision,
      due: request.deadline,
    };
    // 同じ依頼（ID と版が同じ）が 1 回の抽出に重ねて出ても、候補は 1 つ。
    const dedupe = `${kind}\u0000${request.request_entity_id}\u0000${request.request_revision}`;
    if (seen.has(dedupe)) {
      skip('duplicate_in_batch');
      continue;
    }
    seen.add(dedupe);
    drafts.push({
      candidate_kind: kind,
      key_parts: keyParts,
      title,
      deadline: request.deadline,
      excerpt: excerptOf(request),
      request_entity_id: request.request_entity_id,
      request_revision: request.request_revision,
      source_revision: result.source_revision,
      initial_import: context.initial_import,
      unread_partial: unreadPartial,
      related_analysis: context.related_analysis ?? null,
      received_at: context.received_at,
      origins: [{ source_kind: 'source_item', source_id: result.message_id }],
    });
  }
  return { drafts, skipped };
}

export interface OverlapCandidateContext {
  readonly zone: string;
  // 候補を作る時刻（UTC）。予定の重複は受信がないので、この時刻を受信として使う。
  readonly now: string;
  readonly initial_import: boolean;
  // 予定の元情報（source_items の remote_id）。取得側（connector）が付ける呼び方に合わせる。
  readonly originOf: (event: {
    readonly calendar_id: string;
    readonly event_id: string;
  }) => string;
}

const pad2 = (value: string): string => value.padStart(2, '0');

function overlapTitle(overlap: ScheduleOverlap, zone: string): string | null {
  if (overlap.period.kind === 'all_day') {
    const date = overlap.period.start_date.slice(5, 10).split('-');
    return `予定の重複：${Number(date[0])}/${Number(date[1])}`;
  }
  const start = parseCandidateUtc(overlap.period.start);
  const end = parseCandidateUtc(overlap.period.end);
  if (start === null || end === null) return null;
  const from = candidateLocalClock(start, zone);
  const to = candidateLocalClock(end, zone);
  if (from === null || to === null) return null;
  const day = from.date.slice(5, 10).split('-');
  const range = `${Number(from.time.slice(0, 2))}:${pad2(from.time.slice(3, 5))}–${Number(to.time.slice(0, 2))}:${pad2(to.time.slice(3, 5))}`;
  return `予定の重複：${Number(day[0])}/${Number(day[1])} ${range}`;
}

export function scheduleOverlapDrafts(
  overlaps: readonly ScheduleOverlap[],
  context: OverlapCandidateContext,
): { readonly drafts: CandidateDraft[]; readonly skipped: DraftSkip[] } {
  const drafts: CandidateDraft[] = [];
  const skipped: DraftSkip[] = [];
  const seen = new Set<string>();
  for (const overlap of overlaps) {
    const source = `overlap:${overlap.refs.join('|')}`;
    const title = overlapTitle(overlap, context.zone);
    const deadline = scheduleOverlapDeadline(overlap, context.zone);
    if (title === null || deadline === null) {
      skipped.push({ source, reason: 'time_invalid' });
      continue;
    }
    const keyParts: NotificationKeyParts = {
      kind: 'schedule_overlap',
      event_refs: overlap.refs,
      period: overlap.period,
    };
    const dedupe = JSON.stringify([overlap.refs, overlap.period]);
    if (seen.has(dedupe)) {
      skipped.push({ source, reason: 'duplicate_in_batch' });
      continue;
    }
    seen.add(dedupe);
    drafts.push({
      candidate_kind: 'schedule_overlap',
      key_parts: keyParts,
      title,
      deadline,
      // 同一性を確かめられない組は、重複候補として根拠を示す（固定の文。予定の題・参加者は載せない）。
      excerpt:
        overlap.identity === 'unconfirmed'
          ? '同じ予定の写しかどうかを確認できません（重複候補）'
          : null,
      request_entity_id: null,
      request_revision: null,
      source_revision: null,
      initial_import: context.initial_import,
      unread_partial: false,
      related_analysis: null,
      received_at: context.now,
      // 同じ元予定（繰り返しの別の回）から来た由来は 1 つにする（保存側は同じ由来の重複を拒否する）。
      origins: [
        ...new Set(overlap.events.map((event) => context.originOf(event))),
      ].map((sourceId) => ({
        source_kind: 'source_item' as const,
        source_id: sourceId,
      })),
    });
  }
  return { drafts, skipped };
}

// --- 保存 ---

export interface CandidatePersistPorts {
  readonly client: Pick<DbWorkerClient, 'candidate'>;
  // データ鍵（Core が鍵の保管庫から取ったもの）。題・抄録をこの鍵で暗号化する。
  readonly dataKey: DataKeyMaterial;
  // SHA-256 の 16 進（node:crypto）。
  readonly sha256Hex: (material: string) => string;
  // 新しい ID（候補・封筒）。
  readonly newId: () => string;
  // いまの UTC 時刻。
  readonly now: () => string;
}

export type PersistedCandidate =
  | {
      readonly outcome: 'created';
      readonly candidate_id: string;
      readonly notification_key: string;
      readonly candidate_kind: CandidateKindName;
      readonly initial_import: boolean;
    }
  | {
      readonly outcome: 'duplicate';
      readonly candidate_id: string;
      readonly notification_key: string;
      readonly state: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly index: number;
      readonly reasons: readonly string[];
    }
  // 保存の成否が不明（COMMIT の失敗・応答の喪失）。書けたかもしれないので、未保存の拒否と区別する。照合に使う
  // candidate_id と notification_key を返す。同じ下書きを保存し直すと、書けていれば duplicate になる。
  | {
      readonly outcome: 'unknown';
      readonly index: number;
      readonly candidate_id: string;
      readonly notification_key: string;
      readonly reasons: readonly string[];
    };

function seal(
  ports: CandidatePersistPorts,
  candidateId: string,
  purpose: 'candidate_title' | 'candidate_excerpt',
  plaintext: string,
): SealedBlobInput | null {
  const owner: SealedBlobOwner = {
    ownerTable: 'notification_candidates',
    ownerId: candidateId,
    ownerVersion: 0,
    purpose,
  };
  const sealed = sealBlob(ports.dataKey, Buffer.from(plaintext, 'utf8'), owner);
  if (!sealed.ok) return null;
  return {
    blob_id: ports.newId(),
    format_version: sealed.envelope.formatVersion,
    key_id: sealed.envelope.keyId,
    nonce: sealed.envelope.nonce,
    ciphertext: sealed.envelope.ciphertext,
    tag: sealed.envelope.tag,
  };
}

// 題の封筒の中身（JSON）。題と、期限の原文（本文の断片なので封筒の中にだけ置く。U281）。
export function candidateTitlePayload(draft: CandidateDraft): string {
  return JSON.stringify({
    title: draft.title,
    deadline_original_text: deadlineOriginalText(draft.deadline),
  });
}

function toDeadlineInput(deadline: Deadline): CandidateCreateInput['deadline'] {
  switch (deadline.kind) {
    case 'instant':
      return {
        kind: 'instant',
        local_datetime: deadline.local_datetime,
        zone: deadline.zone,
      };
    case 'date':
      return { kind: 'date', date: deadline.date };
    case 'unresolved':
      return { kind: 'unresolved', reason: deadline.reason };
    case 'none':
      return { kind: 'none' };
  }
}

// 下書きを保存する。1 件ずつ送り、1 件の拒否で残りを止めない。識別子が作れない・封をできない下書きは拒否として返す。
export async function persistCandidateDrafts(
  ports: CandidatePersistPorts,
  drafts: readonly CandidateDraft[],
): Promise<PersistedCandidate[]> {
  const results: PersistedCandidate[] = [];
  for (const [index, draft] of drafts.entries()) {
    const key = notificationKey(draft.key_parts, ports.sha256Hex);
    if (key === null) {
      results.push({ outcome: 'rejected', index, reasons: ['key_invalid'] });
      continue;
    }
    const candidateId = ports.newId();
    const title = seal(
      ports,
      candidateId,
      'candidate_title',
      candidateTitlePayload(draft),
    );
    const excerpt =
      draft.excerpt === null
        ? null
        : seal(ports, candidateId, 'candidate_excerpt', draft.excerpt);
    if (title === null || (draft.excerpt !== null && excerpt === null)) {
      results.push({ outcome: 'rejected', index, reasons: ['seal_failed'] });
      continue;
    }
    const outcome = await ports.client.candidate({
      kind: 'candidate.create',
      input: {
        candidate_id: candidateId,
        candidate_kind: draft.candidate_kind,
        notification_key: key,
        request_entity_id: draft.request_entity_id,
        request_revision: draft.request_revision,
        source_revision: draft.source_revision,
        deadline: toDeadlineInput(draft.deadline),
        initial_import: draft.initial_import,
        unread_partial: draft.unread_partial,
        related_analysis: draft.related_analysis,
        received_at: draft.received_at,
        created_at: ports.now(),
        title,
        excerpt,
        origins: draft.origins,
      },
    });
    if (!outcome.ok) {
      results.push(
        outcome.outcome === 'unknown'
          ? {
              outcome: 'unknown',
              index,
              candidate_id: candidateId,
              notification_key: key,
              reasons: outcome.reasons,
            }
          : { outcome: 'rejected', index, reasons: outcome.reasons },
      );
      continue;
    }
    results.push(
      outcome.value.result === 'created'
        ? {
            outcome: 'created',
            candidate_id: outcome.value.candidate_id,
            notification_key: key,
            candidate_kind: draft.candidate_kind,
            initial_import: draft.initial_import,
          }
        : {
            outcome: 'duplicate',
            candidate_id: outcome.value.candidate_id,
            notification_key: key,
            state: outcome.value.state,
          },
    );
  }
  return results;
}
