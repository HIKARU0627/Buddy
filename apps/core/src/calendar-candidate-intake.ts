// 予定の重複からの気づき（候補）の取り込み（B11-04、ADR 0194、設計 04 気づきの作成／予定重複、設計 11 §4・§5B）。
//
// 同期が予定の取得集合を公開した後に呼ぶ（sync-scheduler の onPublished）。手順:
// 1. 保存境界・タイムゾーン・データ鍵・接続の今の取得対象を、予定を読む前に確かめる。記録しない会話の間は何も読まず、何も
//    作らない（次の公開でやり直す）。
// 2. 接続の今の取得対象（選んだカレンダー）を、いまから「同期が最後に全量を照合した窓の終わり」と取得の窓の終わりの早い方まで
//    Google Calendar から読み直す（許可範囲から取り直す。同期が保存していない範囲を読まない）。本人の持ち物（accessRole が
//    owner）のカレンダーだけを使う（U550）。読んだ予定の題・参加者・本文は保存しない。使うのは時刻・状態・本人の出欠・
//    空き時間の別・識別子だけ。
// 3. domain の findScheduleOverlaps で重複を求め、まだ始まっていない重複だけを候補の下書きにして保存する（識別子が同じ候補は
//    状態によらず作らない。再同期・再接続で二重に作らない）。公開の世代が 1（初めての公開）のときは初回取り込みの印を付ける。
// 4. 活動中の予定の重複の候補のうち、由来の元情報がこの接続の口座・取得集合にあり、由来の予定をすべて重複の判定に使えたもので、
//    もう重複していないものを resolved にする（予定が取り消されたら source_out_of_scope、時刻の変更・辞退・空き時間への変更
//    などは overlap_resolved）。それ以外の候補には触らない（U545）。
// 下書きを送る前ごとと、遷移を書く前ごとに保存境界を照合し（api-turns.ts の precommit と同じ形）、区切りが変わったら残りを
// 書かない。承認・実行・effect_kind はここで決めない。外部へは読み取りだけで、変更を送らない。本文・題・時刻はログに出さない。

import { createHash, randomUUID } from 'node:crypto';
import {
  calendarWindow,
  findScheduleOverlaps,
  notificationKey,
} from '@buddy/domain';
import type {
  CalendarOccurrence,
  CalendarOccurrenceTime,
  CandidateEvent,
  ScheduleOverlap,
  StartupGateDecision,
} from '@buddy/domain';
import type {
  GoogleCalendarEvent,
  GoogleCalendarEventTime,
  GoogleCalendarReader,
} from '@buddy/connectors';
import type {
  CandidateListCursor,
  CandidateOpValues,
  CandidateRow,
  ConnectionRecord,
  DataKeyMaterial,
  DbWorkerClient,
} from '@buddy/storage';
import {
  persistCandidateDrafts,
  scheduleOverlapDrafts,
} from './candidate-intake.js';
import { LIVE_CANDIDATE_STATES } from './candidate-maintenance.js';
import { toFetchScope } from './sync-executor.js';

export interface CalendarCandidateIntakeTarget {
  readonly connection_id: string;
  // 取得集合の口座（source_items の account_id）と取得集合。解消を判断してよい候補を、この 2 つの元情報から作られたものに限る。
  readonly account_id: string;
  readonly scope_id: string;
  // 公開の後の取得集合の世代（10 進の文字列）。'1' は初めての公開で、そのときの候補を初回取り込みにする（U543）。
  readonly published_generation: string;
}

// 公開の知らせのうち、取り込みが使うもの（sync-scheduler の SyncPublishedNotice と同じ項目）。
export interface CalendarPublishedNotice {
  readonly diff_count: number;
  readonly kind: 'incremental' | 'full';
  readonly window_end: string;
}

export type CalendarCandidateIntakeReason =
  | 'already_running'
  | 'retention_closed'
  | 'private_conversation'
  | 'zone_unavailable'
  | 'key_unavailable'
  | 'connection_unavailable'
  | 'reader_unavailable'
  | 'window_empty'
  | 'read_failed'
  | 'too_many_events'
  | 'overlap_invalid'
  | 'storage_boundary_changed';

// 続く理由（取得集合か設定が変わるまで、作り直しても同じ）。この理由で終わった取得集合は、次の差分のある公開まで回さない
// （毎分の読み直しにしない。U547）。ほかの理由（記録しない会話・鍵・タイムゾーン・読み取りの失敗・区切りの変化・掃除）は
// 次の公開でやり直す。
const LASTING_REASONS: ReadonlySet<CalendarCandidateIntakeReason> = new Set([
  'connection_unavailable',
  'reader_unavailable',
  'window_empty',
  'too_many_events',
  'overlap_invalid',
]);

export interface CalendarCandidateIntakeSummary {
  readonly outcome: 'done' | 'skipped';
  readonly reason: CalendarCandidateIntakeReason | null;
  // 新しく作った候補・同じ識別子がすでにあった候補・保存で拒否された／成否不明の下書きの数。
  readonly created: number;
  readonly duplicate: number;
  readonly rejected: number;
  readonly unknown: number;
  // もう重複していないので resolved にした候補の ID。
  readonly resolved: readonly string[];
  // 次の公開で差分が無くてもやり直すか（保存の成否不明、または由来の予定がまだ同期に無い拒否があった）。
  readonly retry: boolean;
}

export interface CalendarCandidateIntakeOptions {
  readonly store: Pick<DbWorkerClient, 'candidate' | 'connectionTargets'>;
  // 接続の Calendar の読み取り。null なら読まない（トークンが無いなど）。
  readonly calendarFor: (
    connection: ConnectionRecord,
  ) => Pick<GoogleCalendarReader, 'listEventsPage'> | null;
  // データ鍵（使うたびに読む）。null なら作らない。
  readonly dataKey: () => Promise<DataKeyMaterial | null>;
  // 本人のタイムゾーン（IANA。ADR 0131 の端末（OS））。読めないときは代用せず、その回は読まない。
  readonly zone: () => string | null;
  // 保存境界の保持者（storage-gate.ts）。記録しない会話の間は作らない。区切りの ID と世代で、読み取りの間に区切りが
  // 変わっていないかを確かめる（api-turns.ts の originCurrent と同じ照合）。
  readonly storage: {
    privateConversation(): boolean;
    origin(): {
      readonly segment_id: string;
      readonly segment_generation: string;
    };
  };
  readonly now?: () => Date;
  readonly newId?: () => string;
  // 1 つのカレンダーで読む頁の上限（1 頁 250 件）。超えたら一部だけで判断せず、その回は作らない。
  readonly maxPagesPerCalendar?: number;
  // 保存期限の掃除のゲート（ADR 0053・0058）。省略時は通さない（試験用）。製品では core.ts が渡す。
  readonly retention?: {
    readonly ready: () => Promise<void>;
    readonly gate: () => StartupGateDecision;
    readonly lease: () => (() => void) | null;
  };
}

export interface CalendarCandidateIntake {
  run(
    target: CalendarCandidateIntakeTarget,
  ): Promise<CalendarCandidateIntakeSummary>;
  // 公開を知らせる。全量の照合の窓の終わりを控え、回すかを返す。差分があったとき、またはこの取得集合でまだ終わっていない
  // （起動の後・前の回がやり直しで終わった・走っている間に公開が来た）ときだけ回す。全量の照合の窓をまだ知らない取得集合は
  // 回さない（同期が保存した範囲が分からない）。
  notePublished(scopeId: string, published: CalendarPublishedNotice): boolean;
}

const DEFAULT_MAX_PAGES = 40;
const SHA256 = (material: string): string =>
  createHash('sha256').update(material, 'utf8').digest('hex');

// RFC 3339（タイムゾーンのずれ付き）だけを読み、UTC の ISO 8601 にする。読めなければ null。
const RFC3339 =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/u;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;

function utcOf(value: string | undefined): string | null {
  if (value === undefined || !RFC3339.test(value)) return null;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : new Date(millis).toISOString();
}

function occurrenceTime(
  start: GoogleCalendarEventTime | undefined,
  end: GoogleCalendarEventTime | undefined,
): CalendarOccurrenceTime | null {
  if (start?.dateTime !== undefined && end?.dateTime !== undefined) {
    const from = utcOf(start.dateTime);
    const to = utcOf(end.dateTime);
    return from === null || to === null
      ? null
      : { kind: 'timed', start: from, end: to };
  }
  if (
    start?.date !== undefined &&
    end?.date !== undefined &&
    DATE.test(start.date) &&
    DATE.test(end.date)
  )
    return { kind: 'all_day', start_date: start.date, end_date: end.date };
  return null;
}

// 空き時間として扱う予定の種類（勤務場所・誕生日。本人の時間を占めない。U542）。
const FREE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'workingLocation',
  'birthday',
]);

const RESPONSES: Readonly<Record<string, CalendarOccurrence['response']>> = {
  accepted: 'accepted',
  tentative: 'tentative',
  needsAction: 'needs_action',
  declined: 'declined',
};

// Google の予定を domain の予定の回にする。状態・時刻が読めない予定は重複の判定に使わない（null）。
export function calendarOccurrenceOf(
  calendarId: string,
  event: GoogleCalendarEvent,
): CalendarOccurrence | null {
  const status =
    event.status === 'confirmed' ||
    event.status === 'tentative' ||
    event.status === 'cancelled'
      ? event.status
      : null;
  const time = occurrenceTime(event.start, event.end);
  if (status === null || time === null) return null;
  const original = event.originalStartTime;
  const recurrence =
    original === undefined
      ? null
      : (utcOf(original.dateTime) ??
        (original.date !== undefined && DATE.test(original.date)
          ? original.date
          : null));
  return {
    calendar_id: calendarId,
    event_id: event.id,
    ical_uid: event.iCalUID ?? null,
    recurrence_id: recurrence,
    status,
    response:
      event.selfResponseStatus === undefined
        ? 'none'
        : (RESPONSES[event.selfResponseStatus] ?? 'none'),
    busy:
      event.transparency !== 'transparent' &&
      !FREE_EVENT_TYPES.has(event.eventType ?? 'default'),
    time,
  };
}

// まだ始まっていない重複か（時刻付きは開始がいま以降、終日は開始の日付が本人の今日以降）。始まった重複は候補にしない（U541）。
function notStarted(
  overlap: ScheduleOverlap,
  nowMs: number,
  today: string,
): boolean {
  return overlap.period.kind === 'timed'
    ? Date.parse(overlap.period.start) >= nowMs
    : overlap.period.start_date >= today;
}

function localDate(nowMs: number, zone: string): string {
  // en-CA は YYYY-MM-DD の形。
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}

export function createCalendarCandidateIntake(
  options: CalendarCandidateIntakeOptions,
): CalendarCandidateIntake {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  const maxPages = options.maxPagesPerCalendar ?? DEFAULT_MAX_PAGES;
  const running = new Set<string>();
  // 終わった取得集合（作り終えた、または続く理由で止まった）。次の差分のある公開まで回さない。
  const settled = new Set<string>();
  // 走っている間に公開が来た取得集合。走っている回の終わりで settled にせず、次の公開でもう 1 回回す。
  const rerun = new Set<string>();
  // 取得集合ごとの、最後の全量の照合の窓の終わり（同期が保存した範囲の終わり）。
  const fullWindowEnd = new Map<string, string>();

  const empty = {
    created: 0,
    duplicate: 0,
    rejected: 0,
    unknown: 0,
    resolved: [] as readonly string[],
    retry: true,
  };
  const skipped = (
    reason: CalendarCandidateIntakeReason,
    partial: Partial<typeof empty> = {},
  ): CalendarCandidateIntakeSummary => ({
    outcome: 'skipped',
    reason,
    ...empty,
    ...partial,
  });

  type Read =
    | {
        readonly ok: true;
        readonly occurrences: CalendarOccurrence[];
        // 取り消された予定（時刻が無くても状態で分かる）。
        readonly cancelled: Set<string>;
      }
    | {
        readonly ok: false;
        readonly reason: 'read_failed' | 'too_many_events';
      };

  async function readEvents(
    reader: Pick<GoogleCalendarReader, 'listEventsPage'>,
    calendarIds: readonly string[],
    timeMin: string,
    timeMax: string,
  ): Promise<Read> {
    const occurrences: CalendarOccurrence[] = [];
    const cancelled = new Set<string>();
    for (const calendarId of calendarIds) {
      const own: CalendarOccurrence[] = [];
      const ownCancelled: string[] = [];
      let owner = true;
      let pageToken: string | undefined;
      for (let page = 0; ; page += 1) {
        if (page >= maxPages) return { ok: false, reason: 'too_many_events' };
        let result;
        try {
          result = await reader.listEventsPage({
            calendarId,
            timeMin,
            timeMax,
            ...(pageToken === undefined ? {} : { pageToken }),
          });
        } catch {
          return { ok: false, reason: 'read_failed' };
        }
        // 本人の持ち物でないカレンダー（共有・同僚のカレンダー）の予定は使わない（U550）。
        if (result.accessRole !== 'owner') {
          owner = false;
          break;
        }
        for (const event of result.items) {
          if (event.status === 'cancelled') ownCancelled.push(event.id);
          const occurrence = calendarOccurrenceOf(calendarId, event);
          if (occurrence !== null) own.push(occurrence);
        }
        if (result.nextPageToken === undefined) break;
        pageToken = result.nextPageToken;
      }
      if (!owner) continue;
      occurrences.push(...own);
      for (const id of ownCancelled) cancelled.add(id);
    }
    return { ok: true, occurrences, cancelled };
  }

  // 解消を判断してよい候補か: 由来がすべて元情報で、その行がこの接続の口座・取得集合にあり、どれも今回の重複の判定に使えた
  // 予定であること。返すのは遷移（取り消された予定があれば source_out_of_scope、ほかは overlap_resolved）か null。
  async function staleEvent(
    row: CandidateRow,
    target: CalendarCandidateIntakeTarget,
    seen: ReadonlyMap<string, boolean>,
  ): Promise<CandidateEvent | null> {
    const scoped = await options.store.candidate({
      kind: 'candidate.origin_scopes',
      candidate_id: row.candidate_id,
    });
    if (!scoped.ok) return null;
    const { origins } =
      scoped.value as CandidateOpValues['candidate.origin_scopes'];
    if (
      origins.length === 0 ||
      !origins.every(
        (origin) =>
          origin.source_kind === 'source_item' &&
          seen.has(origin.source_id) &&
          origin.scopes.some(
            (scope) =>
              scope.account_id === target.account_id &&
              scope.scope_id === target.scope_id,
          ),
      )
    )
      return null;
    return origins.some((origin) => seen.get(origin.source_id) === true)
      ? 'source_out_of_scope'
      : 'overlap_resolved';
  }

  // 活動中の予定の重複の候補のうち、識別子が今の重複に無く、解消を判断してよいものを resolved にする。遷移を書く前ごとに
  // 保存境界を照合し、変わっていたら残りを書かない（held を真にして返す）。
  async function resolveStale(
    target: CalendarCandidateIntakeTarget,
    currentKeys: ReadonlySet<string>,
    seen: ReadonlyMap<string, boolean>,
    zone: string,
    at: string,
    precommit: () => boolean,
  ): Promise<{ readonly resolved: string[]; readonly held: boolean }> {
    const resolved: string[] = [];
    let after: CandidateListCursor | undefined;
    for (let page = 0; page < 100; page += 1) {
      const listed = await options.store.candidate({
        kind: 'candidate.list',
        states: LIVE_CANDIDATE_STATES,
        limit: 1000,
        ...(after === undefined ? {} : { after }),
      });
      if (!listed.ok) break;
      const stale = listed.value.candidates.filter(
        (row: CandidateRow) =>
          row.candidate_kind === 'schedule_overlap' &&
          !currentKeys.has(row.notification_key),
      );
      for (const row of stale) {
        const event = await staleEvent(row, target, seen);
        if (event === null) continue;
        if (!precommit()) return { resolved, held: true };
        const moved = await options.store.candidate({
          kind: 'candidate.transition',
          input: {
            candidate_id: row.candidate_id,
            event,
            expected_state: row.state,
            zone,
            snooze_until: null,
            now: at,
          },
        });
        if (moved.ok) resolved.push(row.candidate_id);
      }
      if (!listed.value.truncated || listed.value.next_after === null) break;
      after = listed.value.next_after;
    }
    return { resolved, held: false };
  }

  async function runOnce(
    target: CalendarCandidateIntakeTarget,
  ): Promise<CalendarCandidateIntakeSummary> {
    // 記録しない会話の間は、予定を読まず候補も作らない（次の公開でやり直す。U540）。
    if (options.storage.privateConversation())
      return skipped('private_conversation');
    const origin = options.storage.origin();
    // 今の区切りが読み始めたときと同じで、記録しない会話でないか（下書き・遷移を書く前ごとに照合する）。
    const current = (): boolean => {
      const present = options.storage.origin();
      return (
        !options.storage.privateConversation() &&
        present.segment_id === origin.segment_id &&
        present.segment_generation === origin.segment_generation
      );
    };
    // 読む前に、タイムゾーンとデータ鍵を確かめる（読んだ後で止まらない）。
    const zone = options.zone();
    if (zone === null) return skipped('zone_unavailable');
    const dataKey = await options.dataKey().catch(() => null);
    if (dataKey === null) return skipped('key_unavailable');
    const got = await options.store.connectionTargets({
      kind: 'connections.get',
      connection_id: target.connection_id,
    });
    if (
      !got.ok ||
      got.value === null ||
      got.value.provider !== 'google' ||
      got.value.status !== 'active' ||
      got.value.targets_state !== 'complete'
    )
      return skipped('connection_unavailable');
    const connection = got.value;
    const reader = options.calendarFor(connection);
    if (reader === null) return skipped('reader_unavailable');
    const at = now();
    const nowMs = at.getTime();
    const nowIso = at.toISOString();
    const window = calendarWindow(toFetchScope(connection), nowIso);
    const synced = fullWindowEnd.get(target.scope_id);
    // 窓の終わりは、取得の窓と、同期が最後に全量を照合した窓の早い方（同期が保存していない予定を読まない。U547）。
    const end =
      window === null || synced === undefined
        ? null
        : Date.parse(window.end) <= Date.parse(synced)
          ? window.end
          : synced;
    if (end === null || !(Date.parse(end) > nowMs))
      return skipped('window_empty');
    // いまから窓の終わりまで（選んだカレンダーだけ。窓・カレンダーを広げない）。
    const read = await readEvents(
      reader,
      connection.targets.calendar_ids,
      nowIso,
      end,
    );
    if (!read.ok) return skipped(read.reason);
    const found = findScheduleOverlaps(
      read.occurrences,
      { start: nowIso, end },
      zone,
    );
    if (!found.ok) return skipped('overlap_invalid');
    // 重複の判定に使えた予定（取り消し・辞退・空き時間を含む）。時刻が読めない・写しが食い違う・状態が読めない予定は
    // 一時的に外れただけかもしれないので、解消の根拠にしない（U545）。値は取り消されているか。
    const unusable = new Set(
      found.excluded
        .filter(
          (item) =>
            item.reason === 'time_invalid' || item.reason === 'copies_disagree',
        )
        .map((item) => item.event_id),
    );
    const seen = new Map<string, boolean>();
    for (const occurrence of read.occurrences)
      if (!unusable.has(occurrence.event_id))
        seen.set(
          occurrence.event_id,
          (seen.get(occurrence.event_id) ?? false) ||
            occurrence.status === 'cancelled',
        );
    for (const id of read.cancelled) seen.set(id, true);
    // 今も続く重複（始まったものを含む）の識別子。これに無い活動中の候補だけを解決の対象にする。
    const currentKeys = new Set<string>();
    for (const overlap of found.overlaps) {
      const key = notificationKey(
        {
          kind: 'schedule_overlap',
          event_refs: overlap.refs,
          period: overlap.period,
        },
        SHA256,
      );
      if (key !== null) currentKeys.add(key);
    }
    const today = localDate(nowMs, zone);
    const { drafts } = scheduleOverlapDrafts(
      found.overlaps.filter((overlap) => notStarted(overlap, nowMs, today)),
      {
        zone,
        now: nowIso,
        initial_import: target.published_generation === '1',
        // 由来は同期が保存した予定の remote_id（events.list の singleEvents の回の ID）。
        originOf: (event) => event.event_id,
      },
    );
    // 下書きを送る前ごとに、記録しない会話に入っていないか・区切りが変わっていないかを照合する。
    const results = await persistCandidateDrafts(
      {
        client: options.store,
        dataKey,
        sha256Hex: SHA256,
        newId,
        now: () => now().toISOString(),
        precommit: current,
      },
      drafts,
    );
    const count = (outcome: string): number =>
      results.filter((result) => result.outcome === outcome).length;
    const counts = {
      created: count('created'),
      duplicate: count('duplicate'),
      rejected: count('rejected'),
      unknown: count('unknown'),
    };
    if (count('held') > 0) return skipped('storage_boundary_changed', counts);
    const resolution = await resolveStale(
      target,
      currentKeys,
      seen,
      zone,
      nowIso,
      current,
    );
    if (resolution.held)
      return skipped('storage_boundary_changed', {
        ...counts,
        resolved: resolution.resolved,
      });
    return {
      outcome: 'done',
      reason: null,
      ...counts,
      resolved: resolution.resolved,
      // 由来の予定がまだ同期に無い（公開の前に足された予定）ときは次の公開で作れる。ほかの拒否は作り直しても同じ。
      retry: results.some(
        (result) =>
          result.outcome === 'unknown' ||
          (result.outcome === 'rejected' &&
            result.reasons.includes('origin_not_found')),
      ),
    };
  }

  return {
    notePublished(scopeId, published) {
      if (published.kind === 'full')
        fullWindowEnd.set(scopeId, published.window_end);
      if (!fullWindowEnd.has(scopeId)) return false;
      if (running.has(scopeId)) {
        // 走っている回は、この公開より前の予定を読んでいるかもしれない。終わった後にもう 1 回回す。
        rerun.add(scopeId);
        return false;
      }
      return published.diff_count > 0 || !settled.has(scopeId);
    },
    async run(target) {
      if (running.has(target.scope_id)) {
        rerun.add(target.scope_id);
        return skipped('already_running');
      }
      running.add(target.scope_id);
      rerun.delete(target.scope_id);
      settled.delete(target.scope_id);
      let release: (() => void) | null = null;
      try {
        // 掃除が済むまで予定を読まない（ADR 0053）。読み取り・保存が終わるまで貸し出しを持つ。
        if (options.retention !== undefined) {
          for (let attempt = 0; release === null && attempt < 3; attempt += 1) {
            await options.retention.ready();
            const gate = options.retention.gate();
            if (!gate.search || !gate.auto_use) break;
            release = options.retention.lease();
          }
          if (release === null) return skipped('retention_closed');
        }
        const summary = await runOnce(target);
        // 作り終えた回と続く理由で止まった回は、次の差分のある公開まで回さない。走っている間に公開が来たら回す。
        const finished =
          summary.outcome === 'done'
            ? !summary.retry
            : summary.reason !== null && LASTING_REASONS.has(summary.reason);
        if (finished && !rerun.has(target.scope_id))
          settled.add(target.scope_id);
        return summary;
      } finally {
        release?.();
        running.delete(target.scope_id);
      }
    },
  };
}
