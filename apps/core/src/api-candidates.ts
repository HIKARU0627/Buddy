// 気づき（候補）の一覧・根拠の再取得・状態の変更の経路（B11-04 P2、設計 11 §4・§5B、ADR 0073・0130）。
//
// 経路の検査（端末トークン・自宅判定・接続範囲・ロック解除・画面の操作）は api-server の admission が先に行う。
// ここは検査を通った要求の処理で、状態の遷移の正本は保存層（candidate-store.ts）と domain の candidateTransition。
// - 一覧は new・seen・acted だけを出す（snoozed は件数だけ。U270 の暫定 (a)）。並びは domain の orderCandidates。
//   題の封筒を開けない行があれば一覧全体を 503 にする（黙って落とさない）。
// - 根拠の再取得は注入された fetchEvidence（B08・B09 の connector）で許可範囲から取り直し、domain の evidenceDecision で
//   状態と応答を決める。有効なときだけ根拠の位置と保存済みの抄録を返し、本文全体は返さない。
// - 状態の変更は本人の操作（open・act・dismiss・snooze・resolve）だけ。expected_state による compare-and-swap は保存層が行う。
// - 本人のタイムゾーンが決まっていない（zone() が null）ときは、一覧・状態の変更を 503 で閉じる（端末の既定で置き換えない）。
// - 想定外の保存の失敗・成否不明は 503 dependency_unavailable にし、成功にも競合にも見せない。
// 実メール・実 API・実請求は使わない。

import type {
  CandidateEvidence,
  CandidateListResponse,
  CandidateSnapshot,
  CandidateStateCounts,
  Deadline,
  SourceRef,
} from '@buddy/contracts';
import {
  CANDIDATE_STATES,
  checkSnoozeUntil,
  evidenceDecision,
  orderCandidates,
} from '@buddy/domain';
import type {
  CandidateEvent,
  CandidateOrderItem,
  CandidateState,
  EvidenceObservation,
} from '@buddy/domain';
import { openBlob } from '@buddy/storage';
import type {
  CandidateBlobOutput,
  CandidateListCursor,
  CandidateOpResult,
  CandidateOpValues,
  CandidateOriginInput,
  CandidateRow,
  DataKeyMaterial,
  DbWorkerClient,
} from '@buddy/storage';
import { apiErrorResponse } from './api-server.js';
import type { ApiRouteHandler } from './api-server.js';
import type { JsonObject } from './strict-json.js';

// 一覧に出す状態（U270 の暫定 (a)。snoozed は件数だけ）。
export const LISTED_CANDIDATE_STATES: readonly CandidateState[] = [
  'new',
  'seen',
  'acted',
];
// 本人が画面から起こせる遷移（契約の CandidateStateCommand.event と同じ）。時計・観測の遷移は受け付けない。
const USER_EVENTS: ReadonlySet<string> = new Set<CandidateEvent>([
  'open',
  'act',
  'dismiss',
  'snooze',
  'resolve',
]);
const STATES: ReadonlySet<string> = new Set<string>(CANDIDATE_STATES);
const LIST_PAGE_LIMIT = 1000;
const LIST_MAX_PAGES = 100;
const EXCERPT_MAX_CODE_POINTS = 200;
const TITLE_MAX_CODE_POINTS = 60;

// 状態が変わった・変わり得たことを表す拒否（409）。画面は読み直す。
const CONFLICT_REASONS: ReadonlySet<string> = new Set([
  'state_mismatch',
  'time_backwards',
  'transition_not_allowed',
  'event_not_due',
]);

// 根拠を許可範囲から取り直した結果。予定の重複は、重複が解消したときに 'overlap_resolved'（保守の CandidateCheck と同じ）。
export interface CandidateEvidenceFetch {
  readonly observation: EvidenceObservation | 'overlap_resolved';
  // available のときに必須。Core が一意に照合できた根拠の位置。
  readonly source?: SourceRef;
  // available のときに必須。根拠の元情報に未読の部分があるか。
  readonly unread?: boolean;
}

export interface CandidateRoutesOptions {
  readonly store: Pick<DbWorkerClient, 'candidate'>;
  // データ鍵を読む（題・抄録の封筒を開く）。データ鍵を Core のメモリーに持ち続けないので要求ごとに読む。読めなければ null。
  readonly dataKey: () => Promise<DataKeyMaterial | null>;
  // 本人のタイムゾーン（IANA）。決まっていなければ null。
  readonly zone: () => string | null;
  // いまの UTC 時刻（ISO 8601）。
  readonly now: () => string;
  // 根拠を許可範囲から取り直す（B08・B09 の connector が実装する）。無ければ根拠の経路は 503。
  readonly fetchEvidence?: (
    candidate: CandidateRow,
    origins: readonly CandidateOriginInput[],
  ) => Promise<CandidateEvidenceFetch>;
  // 一覧の 1 頁の件数と頁数の上限（既定 1000 件・100 頁。保守と同じ）。試験で小さくする。
  readonly pageLimit?: number;
  readonly maxPages?: number;
}

export interface CandidateRoutes {
  readonly handlers: {
    readonly listCandidates: ApiRouteHandler;
    readonly getCandidateEvidence: ApiRouteHandler;
    readonly changeCandidateState: ApiRouteHandler;
  };
}

const stringOf = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const codePoints = (text: string): number => [...text].length;

type CandidateErrorCode =
  'conflict' | 'dependency_unavailable' | 'invalid_input';

// 拒否の応答。要求の request_id があれば応答に含める（api-connections.ts の流儀）。
const failWith =
  (requestId: string) => (status: number, code: CandidateErrorCode) =>
    apiErrorResponse(status, code, requestId === '' ? null : requestId);

type Opened =
  { readonly ok: true; readonly text: string } | { readonly ok: false };

function openText(
  dataKey: DataKeyMaterial,
  candidateId: string,
  purpose: 'candidate_title' | 'candidate_excerpt',
  blob: CandidateBlobOutput,
): Opened {
  const opened = openBlob(
    dataKey,
    {
      formatVersion: blob.format_version,
      keyId: blob.key_id,
      nonce: blob.nonce,
      ciphertext: blob.ciphertext,
      tag: blob.tag,
    },
    {
      ownerTable: 'notification_candidates',
      ownerId: candidateId,
      ownerVersion: 0,
      purpose,
    },
  );
  if (!opened.ok) return { ok: false };
  try {
    return {
      ok: true,
      text: new TextDecoder('utf-8', { fatal: true }).decode(opened.plaintext),
    };
  } catch {
    return { ok: false };
  }
}

// 題の封筒の中身（candidate-intake.ts の candidateTitlePayload と対）。形が違えば null。
function parseTitlePayload(
  text: string,
): { readonly title: string; readonly originalText: string | null } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  const item = value as Record<string, unknown>;
  const title = item['title'];
  const original = item['deadline_original_text'];
  if (
    typeof title !== 'string' ||
    title === '' ||
    codePoints(title) > TITLE_MAX_CODE_POINTS
  )
    return null;
  if (original !== null && typeof original !== 'string') return null;
  return { title, originalText: original };
}

// 保存した期限に、封筒の中の原文を付けて契約の Deadline にする。期限があるのに原文が無ければ null（読めない行）。
function contractDeadline(
  row: CandidateRow,
  originalText: string | null,
): Deadline | null {
  const deadline = row.deadline;
  if (deadline.kind === 'none') return { kind: 'none' };
  if (originalText === null) return null;
  switch (deadline.kind) {
    case 'instant':
      return {
        kind: 'instant',
        local_datetime: deadline.local_datetime,
        zone: deadline.zone,
        original_text: originalText,
      };
    case 'date':
      return { kind: 'date', date: deadline.date, original_text: originalText };
    case 'unresolved':
      return {
        kind: 'unresolved',
        reason: deadline.reason as Extract<
          Deadline,
          { kind: 'unresolved' }
        >['reason'],
        original_text: originalText,
      };
  }
}

const revisionText = (revision: number | null): string | null =>
  revision === null ? null : String(revision);

// 保存の行を契約の CandidateSnapshot にする。題を開けない・題の中身が読めない行は null。
function candidateSnapshot(
  row: CandidateRow,
  dataKey: DataKeyMaterial,
): CandidateSnapshot | null {
  if (row.title === null) return null;
  const opened = openText(
    dataKey,
    row.candidate_id,
    'candidate_title',
    row.title,
  );
  if (!opened.ok) return null;
  const payload = parseTitlePayload(opened.text);
  if (payload === null) return null;
  const deadline = contractDeadline(row, payload.originalText);
  if (deadline === null) return null;
  const related = row.related_analysis;
  return {
    candidate_id: row.candidate_id,
    kind: row.candidate_kind,
    state: row.state,
    request_entity_id: row.request_entity_id,
    request_revision: revisionText(row.request_revision),
    source_revision: row.source_revision,
    notification_key: row.notification_key,
    title: payload.title,
    deadline,
    initial_import: row.initial_import,
    unread_partial: row.unread_partial,
    // 保存は整数、契約は 10 進の文字列（AnalysisRevision・PublishedGeneration）。
    related_analysis:
      related === null
        ? null
        : {
            group_id: related.group_id,
            analysis_revision: String(related.analysis_revision),
            source_set_hash: related.source_set_hash,
            published_generation: String(related.published_generation),
          },
    // 候補と操作の結び付きは B13 で足す（U282 の暫定 (a)）。
    operation_ids: [],
  };
}

// 一覧の続きの位置。不透明な文字列（base64url の JSON）。
export function encodeCandidateCursor(cursor: CandidateListCursor): string {
  return Buffer.from(
    JSON.stringify({
      received_at: cursor.received_at,
      candidate_id: cursor.candidate_id,
    }),
    'utf8',
  ).toString('base64url');
}

const isoOf = (millis: number): string => new Date(millis).toISOString();

type CandidateRead =
  | {
      readonly kind: 'found';
      readonly value: CandidateOpValues['candidate.get'];
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed' };

export function createCandidateRoutes(
  options: CandidateRoutesOptions,
): CandidateRoutes {
  const { store } = options;
  const pageLimit = options.pageLimit ?? LIST_PAGE_LIMIT;
  const maxPages = options.maxPages ?? LIST_MAX_PAGES;

  const loadKey = async (): Promise<DataKeyMaterial | null> => {
    try {
      return await options.dataKey();
    } catch {
      return null;
    }
  };

  const listCandidates: ApiRouteHandler = async () => {
    const zone = options.zone();
    if (zone === null) return apiErrorResponse(503, 'dependency_unavailable');
    const now = options.now();
    const rows: CandidateRow[] = [];
    let after: CandidateListCursor | undefined;
    let nextCursor: string | null = null;
    for (let page = 0; ; page += 1) {
      const listed = await store.candidate({
        kind: 'candidate.list',
        states: LISTED_CANDIDATE_STATES,
        limit: pageLimit,
        ...(after === undefined ? {} : { after }),
      });
      if (!listed.ok) return apiErrorResponse(503, 'dependency_unavailable');
      const value = listed.value as CandidateOpValues['candidate.list'];
      rows.push(...value.candidates);
      if (!value.truncated || value.next_after === null) break;
      // 頁数の上限（異常な件数で止まらなくなるのを防ぐ）。読んだ分を返し、続きの位置を知らせる。
      if (page + 1 >= maxPages) {
        nextCursor = encodeCandidateCursor(value.next_after);
        break;
      }
      after = value.next_after;
    }
    const counted = await store.candidate({ kind: 'candidate.counts' });
    if (!counted.ok) return apiErrorResponse(503, 'dependency_unavailable');
    const countValue = counted.value as CandidateOpValues['candidate.counts'];
    const counts: CandidateStateCounts = {
      new: countValue.new,
      seen: countValue.seen,
      acted: countValue.acted,
      dismissed: countValue.dismissed,
      snoozed: countValue.snoozed,
      resolved: countValue.resolved,
    };
    const dataKey = rows.length === 0 ? null : await loadKey();
    if (rows.length > 0 && dataKey === null)
      return apiErrorResponse(503, 'dependency_unavailable');
    const items: (CandidateOrderItem & { snapshot: CandidateSnapshot })[] = [];
    for (const row of rows) {
      const snapshot = candidateSnapshot(row, dataKey as DataKeyMaterial);
      // 開けない行を黙って落とさない。一覧全体を保留にする。
      if (snapshot === null)
        return apiErrorResponse(503, 'dependency_unavailable');
      items.push({
        candidate_id: row.candidate_id,
        kind: row.candidate_kind,
        deadline: snapshot.deadline,
        initial_import: row.initial_import,
        received_at: isoOf(row.received_at),
        snapshot,
      });
    }
    const ordered = orderCandidates(items, { now, zone });
    if (!ordered.ok) return apiErrorResponse(503, 'dependency_unavailable');
    const body: CandidateListResponse = {
      // 見出しは応答に含めない（CandidateListResponse は配列だけ）。見出しの順に並べる。
      candidates: ordered.groups.flatMap((group) =>
        group.items.map((item) => item.snapshot),
      ),
      counts,
      next_cursor: nextCursor,
    };
    return { status: 200, body };
  };

  const readCandidate = async (candidateId: string): Promise<CandidateRead> => {
    const got = await store.candidate({
      kind: 'candidate.get',
      candidate_id: candidateId,
    });
    if (!got.ok)
      return got.reasons.includes('candidate_id_invalid')
        ? { kind: 'missing' }
        : { kind: 'failed' };
    const value = got.value as CandidateOpValues['candidate.get'];
    return value.candidate === null
      ? { kind: 'missing' }
      : { kind: 'found', value };
  };

  const getCandidateEvidence: ApiRouteHandler = async (request) => {
    const fail = failWith(stringOf(request.body?.['request_id']));
    const read = await readCandidate(request.params['candidate_id'] ?? '');
    // 契約に 404 は無い。存在しない候補は、指した ID が不正な入力として返す。
    if (read.kind === 'missing') return fail(422, 'invalid_input');
    if (read.kind === 'failed') return fail(503, 'dependency_unavailable');
    const row = read.value.candidate as CandidateRow;
    if (options.fetchEvidence === undefined)
      return fail(503, 'dependency_unavailable');
    let fetched: CandidateEvidenceFetch;
    try {
      fetched = await options.fetchEvidence(row, read.value.origins);
    } catch {
      // 読めなかった。解決せず、未確認として扱う（保守と同じ）。
      fetched = { observation: 'temporarily_unavailable' };
    }

    // 観測による遷移。成否は本文に出さず、どちらでも 409 で読み直させる（状態が変わった・変わり得た）。
    // 本人のタイムゾーンが決まっていなければ遷移を書けないので、状態を変えずに 503。
    const observe = async (event: CandidateEvent) => {
      const zone = options.zone();
      if (zone === null) return fail(503, 'dependency_unavailable');
      await store.candidate({
        kind: 'candidate.transition',
        input: {
          candidate_id: row.candidate_id,
          event,
          expected_state: row.state,
          zone,
          snooze_until: null,
          now: options.now(),
        },
      });
      return fail(409, 'conflict');
    };

    if (fetched.observation === 'overlap_resolved')
      return observe('overlap_resolved');
    const decision = evidenceDecision(row.state, fetched.observation);
    // 忘却: 物理削除は忘却の計画の仕事。ここでは遷移させず、読み直させる。
    if (decision.purge) return fail(409, 'conflict');
    if (decision.event !== null) return observe(decision.event);
    switch (decision.evidence) {
      case 'valid':
        break;
      // 新しい版: 作り直すまで資格を失効する。状態は変えない。
      case 'refresh_required':
        return fail(409, 'conflict');
      // 取り直せない: 保留。状態を変えない。
      case 'unconfirmed':
        return fail(503, 'dependency_unavailable');
      // 終端の候補の取得範囲外・削除（遷移なし）。根拠は無いので読み直させる。
      case 'gone':
        return fail(409, 'conflict');
    }
    if (fetched.source === undefined || typeof fetched.unread !== 'boolean')
      return fail(503, 'dependency_unavailable');
    let excerpt: string | null = null;
    if (row.excerpt !== null) {
      const dataKey = await loadKey();
      if (dataKey === null) return fail(503, 'dependency_unavailable');
      const opened = openText(
        dataKey,
        row.candidate_id,
        'candidate_excerpt',
        row.excerpt,
      );
      if (
        !opened.ok ||
        opened.text === '' ||
        codePoints(opened.text) > EXCERPT_MAX_CODE_POINTS
      )
        return fail(503, 'dependency_unavailable');
      excerpt = opened.text;
    }
    const body: CandidateEvidence = {
      candidate_id: row.candidate_id,
      request_entity_id: row.request_entity_id,
      request_revision: revisionText(row.request_revision),
      source: {
        source_id: fetched.source.source_id,
        source_revision: fetched.source.source_revision,
        quote: fetched.source.quote,
        start: fetched.source.start,
        end: fetched.source.end,
      },
      unread: fetched.unread,
      excerpt,
    };
    return { status: 200, body };
  };

  const changeCandidateState: ApiRouteHandler = async (request) => {
    const body: JsonObject = request.body ?? {};
    const fail = failWith(stringOf(body['request_id']));
    const event = stringOf(body['event']);
    const expectedState = stringOf(body['expected_state']);
    const snoozeUntil = body['snooze_until'];
    // 形は経路の検査が JSON Schema で済ませている。直接呼ばれても時計・観測の遷移を通さない。
    if (!USER_EVENTS.has(event) || !STATES.has(expectedState))
      return fail(422, 'invalid_input');
    const zone = options.zone();
    if (zone === null) return fail(503, 'dependency_unavailable');
    const now = options.now();
    if (event === 'snooze') {
      if (typeof snoozeUntil !== 'string') return fail(422, 'invalid_input');
      const check = checkSnoozeUntil(now, snoozeUntil);
      if (!check.ok)
        // 中枢の時計が読めないのは本人の入力の誤りではない。
        return check.reason === 'now_invalid'
          ? fail(503, 'dependency_unavailable')
          : fail(422, 'invalid_input');
    } else if (snoozeUntil !== null) return fail(422, 'invalid_input');
    const candidateId = request.params['candidate_id'] ?? '';
    const moved: CandidateOpResult = await store.candidate({
      kind: 'candidate.transition',
      input: {
        candidate_id: candidateId,
        event: event as CandidateEvent,
        expected_state: expectedState as CandidateState,
        zone,
        snooze_until: event === 'snooze' ? (snoozeUntil as string) : null,
        now,
      },
    });
    if (!moved.ok) {
      // 成否不明（COMMIT の失敗）は、成功にも競合にも見せない。
      if (moved.outcome === 'unknown')
        return fail(503, 'dependency_unavailable');
      const reasons = moved.reasons;
      if (
        reasons.includes('candidate_not_found') ||
        reasons.includes('candidate_id_invalid')
      )
        return fail(422, 'invalid_input');
      if (reasons.includes('snooze_now_invalid'))
        return fail(503, 'dependency_unavailable');
      if (reasons.some((reason) => reason.startsWith('snooze_')))
        return fail(422, 'invalid_input');
      // 古い画面からの操作・終端・許されない遷移は、状態が変わったものとして読み直させる。
      if (
        reasons.length > 0 &&
        reasons.every((reason) => CONFLICT_REASONS.has(reason))
      )
        return fail(409, 'conflict');
      return fail(503, 'dependency_unavailable');
    }
    // 書けた。読み直して今の形を返す。読めなければ保留（画面は読み直す）。
    const read = await readCandidate(candidateId);
    if (read.kind !== 'found') return fail(503, 'dependency_unavailable');
    const dataKey = await loadKey();
    if (dataKey === null) return fail(503, 'dependency_unavailable');
    const snapshot = candidateSnapshot(
      read.value.candidate as CandidateRow,
      dataKey,
    );
    if (snapshot === null) return fail(503, 'dependency_unavailable');
    return { status: 200, body: snapshot };
  };

  return {
    handlers: { listCandidates, getCandidateEvidence, changeCandidateState },
  };
}
