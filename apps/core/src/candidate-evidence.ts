// 気づき（候補）の根拠を許可範囲から取り直す（Issue #271 の残り (1)、ADR 0201。設計 11 §4・§5B、ADR 0073・0116・0130）。
//
// 根拠の経路（api-candidates.ts の fetchEvidence）と、一覧の前の保守（candidate-maintenance.ts の checkEvidence）が使う。
// 取り直す先は、候補を作ったときに控えた由来の位置（マイグレーション 0026、candidate.get の locations）だけで、ほかの
// カレンダー・口座・接続を探さない。
// 1. 記録しない会話の間は何も読まない（取り直せない＝未確認。U680）。由来の位置を控えていない候補（0026 より前・調査の
//    完了・位置の無い取り込み）も読まず未確認にする（推測で取り直し先を作らない）。
// 2. 許可範囲: 控えた接続が今もあり（無い・切断済みは取得範囲外）、有効で取得対象が完全で、今の口座・取得集合が控えた
//    ものと同じこと（口座の付け替え・取得集合の作り直しは取得範囲外）。予定は控えたカレンダーが今も選ばれていて、時刻付きの
//    予定は取得の窓と重なること。メールは今も選んだラベルにあり、受信が取得の窓の中にあること。外れたら取得範囲外
//    （out_of_scope）。読めない・鍵やトークンが無い・接続が要再認証などは未確認（temporarily_unavailable）。
// 3. 予定の重複: 控えた予定を events.get で 1 件ずつ読み直し、消えた（404・410）・取り消された予定は removed。今の時刻・
//    状態・出欠で重複を求め直し、候補の識別子と同じ重複が今もあれば有効（available）、無ければ重複の解消
//    （overlap_resolved）。有効なときの根拠の引用は予定の題（題の無い予定は入れない）。
// 4. メール: messages.get で読み直し、消えた（404）は removed、版（同期と同じ historyId）が候補を作ったときと違えば revised、
//    同じなら有効。引用は、控えた位置を取り直した本文から切り出す（本文の作り方 mailText が渡されたときだけ。渡されない・
//    位置が本文の外なら引用を入れない。U683）。
// 掃除のゲート（ADR 0053）が閉じている間は読まず未確認にする（U688）。
// 取り直した題・本文・引用は応答に載せて返すだけで、保存・記録・ログに出さない。Outlook（Microsoft Graph）は 1 通を ID で
// 読む口が connector に無いので取り直さず未確認にする（U682）。外部へは読み取りだけで、変更を送らない。
import { createHash } from 'node:crypto';
import type { SourceRef } from '@buddy/contracts';
import {
  calendarWindow,
  checkCalendarEvent,
  checkMailMessage,
  codePointLength,
  findScheduleOverlaps,
  notificationKey,
} from '@buddy/domain';
import type {
  CalendarOccurrence,
  EvidenceObservation,
  StartupGateDecision,
} from '@buddy/domain';
import { GoogleApiError } from '@buddy/connectors';
import type {
  GoogleCalendarEvent,
  GoogleCalendarReader,
  GoogleGmailMessage,
  GoogleGmailReader,
} from '@buddy/connectors';
import type {
  CandidateOpValues,
  CandidateOriginInput,
  CandidateOriginLocationInput,
  CandidateRow,
  ConnectionRecord,
  DbWorkerClient,
} from '@buddy/storage';
import type { CandidateEvidenceFetch } from './api-candidates.js';
import { calendarOccurrenceOf } from './calendar-candidate-intake.js';
import type { CandidateCheck } from './candidate-maintenance.js';
import {
  eventRevision,
  messageRevision,
  toFetchScope,
} from './sync-executor.js';

// 接続の今の口座と取得集合（core の同期の対象と同じ出所。oauth.ts の targetsFor）。
export interface EvidenceTarget {
  readonly account_id: string;
  readonly scope_id: string;
  readonly resource: 'mail' | 'calendar';
}

export interface CandidateEvidenceSourceOptions {
  readonly store: Pick<DbWorkerClient, 'candidate' | 'connectionTargets'>;
  readonly targetsFor: (
    connection: ConnectionRecord,
  ) => readonly EvidenceTarget[] | Promise<readonly EvidenceTarget[]>;
  // 接続の読み取りの口。null なら読まない（トークンが無いなど）。
  readonly calendarFor: (
    connection: ConnectionRecord,
  ) => Pick<GoogleCalendarReader, 'getEvent'> | null;
  readonly gmailFor: (
    connection: ConnectionRecord,
  ) => Pick<GoogleGmailReader, 'getMessage'> | null;
  // 本人のタイムゾーン（IANA）。読めなければ予定の重複を求め直せないので未確認。
  readonly zone: () => string | null;
  // 保存境界の保持者。記録しない会話の間は読まない。
  readonly storage: { privateConversation(): boolean };
  // 抽出の入力と同じ作り方の、件名・本文の文字列。無ければメールの引用を入れない（U683）。
  readonly mailText?: (
    message: GoogleGmailMessage,
    part: 'subject' | 'body',
  ) => string | null;
  readonly now?: () => Date;
  // 保存期限の掃除のゲート（ADR 0053）。掃除が済むまで元情報を読まず、読む間は貸し出しを持つ（U688）。閉じていれば
  // 未確認。省略時は通さない（試験用）。製品では core.ts が渡す。
  readonly retention?: {
    readonly ready: () => Promise<void>;
    readonly gate: () => StartupGateDecision;
    readonly lease: () => (() => void) | null;
  };
}

export interface CandidateEvidenceSource {
  // 根拠の経路: 取り直した根拠（有効なら引用付き）。
  fetchEvidence(
    candidate: CandidateRow,
    origins: readonly CandidateOriginInput[],
    locations: readonly CandidateOriginLocationInput[],
  ): Promise<CandidateEvidenceFetch>;
  // 保守: 取り直した観測だけ（引用は作らない。メールは本文を読まない）。
  checkEvidence(candidate: CandidateRow): Promise<CandidateCheck>;
}

const SHA256 = (material: string): string =>
  createHash('sha256').update(material, 'utf8').digest('hex');

const UNCONFIRMED: CandidateEvidenceFetch = {
  observation: 'temporarily_unavailable',
};

type Gate =
  | { readonly ok: true; readonly connection: ConnectionRecord }
  | { readonly ok: false; readonly observation: EvidenceObservation };

// 消えた（404・410）か。
const gone = (error: unknown): boolean =>
  error instanceof GoogleApiError &&
  (error.status === 404 || error.status === 410);

// コードポイント単位で [start, end) を切り出す。範囲が文字列の外なら null。
function slicePoints(text: string, start: number, end: number): string | null {
  const points = [...text];
  if (end > points.length || start < 0 || end <= start) return null;
  return points.slice(start, end).join('');
}

export function createCandidateEvidenceSource(
  options: CandidateEvidenceSourceOptions,
): CandidateEvidenceSource {
  const now = options.now ?? (() => new Date());

  // 控えた接続・口座・取得集合が、今の接続のものと同じか。
  async function gate(location: CandidateOriginLocationInput): Promise<Gate> {
    // Outlook は 1 通・1 件を ID で読む口が無い（U682）。
    if (location.provider !== 'google')
      return { ok: false, observation: 'temporarily_unavailable' };
    const got = await options.store.connectionTargets({
      kind: 'connections.get',
      connection_id: location.connection_id,
    });
    if (!got.ok) return { ok: false, observation: 'temporarily_unavailable' };
    const connection = got.value;
    // 接続が消えた・切断した・別の提供元: 取得範囲外。
    if (
      connection === null ||
      connection.status === 'disconnected' ||
      connection.provider !== location.provider
    )
      return { ok: false, observation: 'out_of_scope' };
    // 要再認証・要対応・取得対象が読めない: 取り直せない（解決しない）。
    if (
      connection.status !== 'active' ||
      connection.targets_state !== 'complete'
    )
      return { ok: false, observation: 'temporarily_unavailable' };
    let targets: readonly EvidenceTarget[];
    try {
      targets = await options.targetsFor(connection);
    } catch {
      return { ok: false, observation: 'temporarily_unavailable' };
    }
    // 口座を読めなかった（封筒が開けない）ときも空になる。区別できないので取り直せないとする。
    if (targets.length === 0)
      return { ok: false, observation: 'temporarily_unavailable' };
    const target = targets.find(
      (candidate) => candidate.resource === location.resource,
    );
    // 資源を読まなくなった・口座の付け替え・取得集合の作り直し: 取得範囲外。
    if (
      target === undefined ||
      target.account_id !== location.account_id ||
      target.scope_id !== location.scope_id
    )
      return { ok: false, observation: 'out_of_scope' };
    if (
      location.resource === 'calendar' &&
      !connection.targets.calendar_ids.includes(location.container_id)
    )
      return { ok: false, observation: 'out_of_scope' };
    return { ok: true, connection };
  }

  type Read<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly observation: EvidenceObservation };

  async function readEvent(
    location: CandidateOriginLocationInput,
    connection: ConnectionRecord,
  ): Promise<Read<GoogleCalendarEvent>> {
    const reader = options.calendarFor(connection);
    if (reader === null)
      return { ok: false, observation: 'temporarily_unavailable' };
    let event: GoogleCalendarEvent;
    try {
      event = await reader.getEvent({
        calendarId: location.container_id,
        eventId: location.source_id,
      });
    } catch (error) {
      return {
        ok: false,
        observation: gone(error) ? 'removed' : 'temporarily_unavailable',
      };
    }
    // 別の予定が返った（ID の食い違い）は読めなかったものとする。
    if (event.id !== location.source_id)
      return { ok: false, observation: 'temporarily_unavailable' };
    if (event.status === 'cancelled')
      return { ok: false, observation: 'removed' };
    return { ok: true, value: event };
  }

  async function overlapEvidence(
    candidate: CandidateRow,
    sourceIds: readonly string[],
    locations: readonly CandidateOriginLocationInput[],
    withQuotes: boolean,
  ): Promise<CandidateEvidenceFetch> {
    const zone = options.zone();
    if (zone === null) return UNCONFIRMED;
    const at = now().toISOString();
    const occurrences: CalendarOccurrence[] = [];
    const events: GoogleCalendarEvent[] = [];
    let window: { readonly start: string; readonly end: string } | null = null;
    for (const sourceId of sourceIds) {
      const location = locations.find((item) => item.source_id === sourceId);
      if (location === undefined || location.resource !== 'calendar')
        return UNCONFIRMED;
      const allowed = await gate(location);
      if (!allowed.ok) return { observation: allowed.observation };
      const scope = toFetchScope(allowed.connection);
      const range = calendarWindow(scope, at);
      if (range === null) return UNCONFIRMED;
      window ??= range;
      const read = await readEvent(location, allowed.connection);
      if (!read.ok) return { observation: read.observation };
      const occurrence = calendarOccurrenceOf(
        location.container_id,
        read.value,
      );
      if (occurrence === null) return UNCONFIRMED;
      // 時刻付きの予定は取得の窓と重なること（窓の外へ動いた・窓を狭めた: 取得範囲外）。
      if (occurrence.time.kind === 'timed') {
        const check = checkCalendarEvent(
          scope,
          {
            calendarId: location.container_id,
            startsAt: occurrence.time.start,
            endsAt: occurrence.time.end,
          },
          at,
        );
        if (!check.ok)
          return {
            observation:
              check.reason === 'before_window' ||
              check.reason === 'after_window' ||
              check.reason === 'calendar_not_selected'
                ? 'out_of_scope'
                : 'temporarily_unavailable',
          };
      }
      occurrences.push(occurrence);
      events.push(read.value);
    }
    if (window === null) return UNCONFIRMED;
    const found = findScheduleOverlaps(occurrences, window, zone);
    if (!found.ok) return UNCONFIRMED;
    const keys = new Set<string>();
    for (const overlap of found.overlaps) {
      const key = notificationKey(
        {
          kind: 'schedule_overlap',
          event_refs: overlap.refs,
          period: overlap.period,
        },
        SHA256,
      );
      if (key !== null) keys.add(key);
    }
    // 時刻・出欠・空き時間の別が変わって、候補の重複がもう無い。
    if (!keys.has(candidate.notification_key))
      return { observation: 'overlap_resolved' };
    const sources: SourceRef[] = [];
    if (withQuotes)
      for (const event of events) {
        const title = event.summary;
        if (title === undefined || title.trim() === '') continue;
        sources.push({
          source_id: event.id,
          source_revision: eventRevision(event),
          quote: title,
          start: 0,
          end: codePointLength(title),
        });
      }
    return { observation: 'available', sources, unread: false };
  }

  async function mailEvidence(
    candidate: CandidateRow,
    sourceIds: readonly string[],
    locations: readonly CandidateOriginLocationInput[],
    withQuotes: boolean,
  ): Promise<CandidateEvidenceFetch> {
    // メールの候補の由来は 1 通。版を作ったときの値と照合する。
    const [sourceId] = sourceIds;
    if (sourceIds.length !== 1 || sourceId === undefined) return UNCONFIRMED;
    if (candidate.source_revision === null) return UNCONFIRMED;
    const location = locations.find((item) => item.source_id === sourceId);
    if (location === undefined || location.resource !== 'mail')
      return UNCONFIRMED;
    const allowed = await gate(location);
    if (!allowed.ok) return { observation: allowed.observation };
    const gmail = options.gmailFor(allowed.connection);
    if (gmail === null) return UNCONFIRMED;
    const quoteWanted =
      withQuotes && location.quote !== null && options.mailText !== undefined;
    let message: GoogleGmailMessage;
    try {
      message = await gmail.getMessage({
        id: sourceId,
        // 引用を作らないときは本文を読まない（ラベル・受信時刻・版だけ）。
        format: quoteWanted ? 'full' : 'minimal',
      });
    } catch (error) {
      return gone(error) ? { observation: 'removed' } : UNCONFIRMED;
    }
    if (message.id !== sourceId) return UNCONFIRMED;
    const received =
      message.internalDate === undefined ||
      !/^[0-9]{1,16}$/u.test(message.internalDate)
        ? null
        : new Date(Number(message.internalDate)).toISOString();
    if (received === null) return UNCONFIRMED;
    const check = checkMailMessage(
      toFetchScope(allowed.connection),
      { containerIds: message.labelIds, receivedAt: received },
      now().toISOString(),
    );
    if (!check.ok)
      return check.reason === 'container_not_selected' ||
        check.reason === 'before_window' ||
        check.reason === 'after_window'
        ? { observation: 'out_of_scope' }
        : UNCONFIRMED;
    const revision = messageRevision(message);
    if (revision !== candidate.source_revision)
      return { observation: 'revised' };
    const sources: SourceRef[] = [];
    if (quoteWanted && location.quote !== null) {
      const text = (
        options.mailText as NonNullable<
          CandidateEvidenceSourceOptions['mailText']
        >
      )(message, location.quote.part);
      const quote =
        text === null
          ? null
          : slicePoints(text, location.quote.start, location.quote.end);
      // 位置が本文の外・空白だけの引用は照合できなかったものとして入れない（推測で埋めない）。
      if (quote !== null && quote.trim() !== '')
        sources.push({
          source_id: sourceId,
          source_revision: revision,
          quote,
          start: location.quote.start,
          end: location.quote.end,
        });
    }
    return {
      observation: 'available',
      sources,
      // 未読の部分は候補を作ったときの抽出の完全性（取り直しで抽出し直さない）。
      unread: candidate.unread_partial,
    };
  }

  async function observe(
    candidate: CandidateRow,
    origins: readonly CandidateOriginInput[],
    locations: readonly CandidateOriginLocationInput[],
    withQuotes: boolean,
  ): Promise<CandidateEvidenceFetch> {
    // 記録しない会話の間は元情報を読まない（U680）。
    if (options.storage.privateConversation()) return UNCONFIRMED;
    const sourceIds = origins
      .filter((origin) => origin.source_kind === 'source_item')
      .map((origin) => origin.source_id);
    // 元情報の由来が無い（調査の完了など）・発言だけの由来は取り直す先が無い。
    if (sourceIds.length === 0 || candidate.candidate_kind === 'research_done')
      return UNCONFIRMED;
    // 掃除が済むまで元情報を読まない（ADR 0053）。読み終えるまで貸し出しを持つ。
    let release: (() => void) | null = null;
    if (options.retention !== undefined) {
      for (let attempt = 0; release === null && attempt < 3; attempt += 1) {
        await options.retention.ready();
        const decision = options.retention.gate();
        if (!decision.search || !decision.auto_use) break;
        release = options.retention.lease();
      }
      if (release === null) return UNCONFIRMED;
    }
    try {
      return candidate.candidate_kind === 'schedule_overlap'
        ? await overlapEvidence(candidate, sourceIds, locations, withQuotes)
        : await mailEvidence(candidate, sourceIds, locations, withQuotes);
    } finally {
      release?.();
    }
  }

  return {
    fetchEvidence: (candidate, origins, locations) =>
      observe(candidate, origins, locations, true),
    async checkEvidence(candidate) {
      if (options.storage.privateConversation())
        return 'temporarily_unavailable';
      const got = await options.store.candidate({
        kind: 'candidate.get',
        candidate_id: candidate.candidate_id,
      });
      if (!got.ok) return 'temporarily_unavailable';
      const value = got.value as CandidateOpValues['candidate.get'];
      if (value.candidate === null) return 'temporarily_unavailable';
      const observed = await observe(
        value.candidate,
        value.origins,
        value.locations,
        false,
      );
      return observed.observation;
    },
  };
}
