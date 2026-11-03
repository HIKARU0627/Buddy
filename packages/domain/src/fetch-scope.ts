// 取得範囲（本人が選んだカレンダー・フォルダー／ラベル・期間・添付の種類とサイズ）の検査（設計 04 取得する対象、
// 設計 11 §1・§1A、J13・J16、D5、ADR 0086）。
//
// 純粋な規則だけを置く。保存・通信・時計の読み取りを混ぜず、時刻は引数で受け取る。
// - 上限（過去 90 日など）は設計の初期値で、設定は上限より狭くだけできる。広げる既定値は作らない。
// - 新しく見つかったカレンダー・フォルダーを選択へ自動で足さない。足せるのは本人の選択（更新要求）だけ。
// - OAuth の権限が広くても、ここで選択外を閉じる。権限や provider の応答で選択を広げない。
// - 選択の変更は許可版と取得範囲の版を上げ、古い版での取得要求と走査の公開は拒否する。

// 添付の種類。J16 の初期値は PDF とテキスト系（txt・md・csv）。画像・Office 文書・圧縮ファイルは次段階で対象外。
export const ATTACHMENT_KINDS = ['pdf', 'text'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

// 設計の初期値であり、設定できる最大値。値を増やす変更は設計判断（ADR）にし、この表だけを書き換えない。
// 添付の 10MB は 10,000,000 バイトとする（MiB ではなく狭い方。範囲を広げる既定値を作らない）。
export const FETCH_SCOPE_LIMITS = {
  mailLookbackDays: 90,
  calendarPastDays: 30,
  calendarFutureDays: 90,
  attachmentMaxBytes: 10_000_000,
} as const;

// Gmail の受信トレイのラベル ID。Outlook の受信トレイは B09-05 で扱う。
export const GOOGLE_INBOX_CONTAINER_ID = 'INBOX';

// 取得範囲（契約の ConnectionTargets と、狭める設定）。配列は集合として扱い、保存時は正規化（整列・重複なし）する。
export interface FetchScope {
  readonly calendarIds: readonly string[];
  readonly mailContainerIds: readonly string[];
  readonly attachmentKinds: readonly AttachmentKind[];
  readonly mailLookbackDays: number;
  readonly calendarPastDays: number;
  readonly calendarFutureDays: number;
  readonly attachmentMaxBytes: number;
}

// 接続時の初期値（J13・J16）。受信トレイは選択済み、カレンダーは本人が選ぶまで空、期間と添付は設計の上限と同じ。
// 受信トレイの ID が分からない provider は空にし、広げずに本人の選択を待つ。
export function initialFetchScope(inboxContainerId: string | null): FetchScope {
  return {
    calendarIds: [],
    mailContainerIds: inboxContainerId === null ? [] : [inboxContainerId],
    attachmentKinds: [...ATTACHMENT_KINDS],
    mailLookbackDays: FETCH_SCOPE_LIMITS.mailLookbackDays,
    calendarPastDays: FETCH_SCOPE_LIMITS.calendarPastDays,
    calendarFutureDays: FETCH_SCOPE_LIMITS.calendarFutureDays,
    attachmentMaxBytes: FETCH_SCOPE_LIMITS.attachmentMaxBytes,
  };
}

export type FetchScopeIssue =
  | 'mail_lookback_out_of_range'
  | 'calendar_past_out_of_range'
  | 'calendar_future_out_of_range'
  | 'attachment_max_bytes_out_of_range'
  | 'attachment_kind_unknown'
  | 'duplicate_attachment_kind'
  | 'calendar_id_invalid'
  | 'duplicate_calendar_id'
  | 'mail_container_id_invalid'
  | 'duplicate_mail_container_id';

const isInt = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max;

function idIssues(
  ids: readonly unknown[],
  invalid: FetchScopeIssue,
  duplicate: FetchScopeIssue,
): FetchScopeIssue[] {
  const issues: FetchScopeIssue[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || id.trim() !== id) {
      if (!issues.includes(invalid)) issues.push(invalid);
      continue;
    }
    if (seen.has(id) && !issues.includes(duplicate)) issues.push(duplicate);
    seen.add(id);
  }
  return issues;
}

// 取得範囲そのものの検査。上限を超える期間・サイズ、未知の種類、空や重複の ID を拒否する。
// 上限より狭い値（0 日の未来、1 バイトなど）は本人の設定として受け付ける。
export function validateFetchScope(scope: FetchScope): FetchScopeIssue[] {
  const issues: FetchScopeIssue[] = [];
  if (!isInt(scope.mailLookbackDays, 1, FETCH_SCOPE_LIMITS.mailLookbackDays))
    issues.push('mail_lookback_out_of_range');
  if (!isInt(scope.calendarPastDays, 0, FETCH_SCOPE_LIMITS.calendarPastDays))
    issues.push('calendar_past_out_of_range');
  if (
    !isInt(scope.calendarFutureDays, 0, FETCH_SCOPE_LIMITS.calendarFutureDays)
  )
    issues.push('calendar_future_out_of_range');
  if (
    !isInt(scope.attachmentMaxBytes, 1, FETCH_SCOPE_LIMITS.attachmentMaxBytes)
  )
    issues.push('attachment_max_bytes_out_of_range');
  const kinds = new Set<string>();
  for (const kind of scope.attachmentKinds) {
    if (!(ATTACHMENT_KINDS as readonly string[]).includes(kind)) {
      if (!issues.includes('attachment_kind_unknown'))
        issues.push('attachment_kind_unknown');
    } else if (kinds.has(kind)) {
      if (!issues.includes('duplicate_attachment_kind'))
        issues.push('duplicate_attachment_kind');
    }
    kinds.add(kind);
  }
  issues.push(
    ...idIssues(
      scope.calendarIds,
      'calendar_id_invalid',
      'duplicate_calendar_id',
    ),
    ...idIssues(
      scope.mailContainerIds,
      'mail_container_id_invalid',
      'duplicate_mail_container_id',
    ),
  );
  return issues;
}

// 保存する形（整列・重複なし）。同じ選択は同じ形になるので、変更の有無を並び順に依らず判定できる。
export function normalizeFetchScope(scope: FetchScope): FetchScope {
  const sorted = (values: readonly string[]): string[] =>
    [...new Set(values)].sort();
  // 項目を明示して作る。余計な項目を保存へ持ち込まず、キーの順にも依らない。
  return {
    calendarIds: sorted(scope.calendarIds),
    mailContainerIds: sorted(scope.mailContainerIds),
    attachmentKinds: ATTACHMENT_KINDS.filter((kind) =>
      scope.attachmentKinds.includes(kind),
    ),
    mailLookbackDays: scope.mailLookbackDays,
    calendarPastDays: scope.calendarPastDays,
    calendarFutureDays: scope.calendarFutureDays,
    attachmentMaxBytes: scope.attachmentMaxBytes,
  };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

// 同じ選択か。並び順・重複・オブジェクトのキーの順に依らない。
export function sameFetchScope(a: FetchScope, b: FetchScope): boolean {
  const x = normalizeFetchScope(a);
  const y = normalizeFetchScope(b);
  return (
    sameList(x.calendarIds, y.calendarIds) &&
    sameList(x.mailContainerIds, y.mailContainerIds) &&
    sameList(x.attachmentKinds, y.attachmentKinds) &&
    x.mailLookbackDays === y.mailLookbackDays &&
    x.calendarPastDays === y.calendarPastDays &&
    x.calendarFutureDays === y.calendarFutureDays &&
    x.attachmentMaxBytes === y.attachmentMaxBytes
  );
}

// ---- 期間 ----

const DAY_MS = 86_400_000;
// 契約の UtcTime と同じ形（小数部は桁数の制限なし。秒は 00〜59 でうるう秒は拒否）。
const UTC_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):([0-5]\d)(?:\.(\d+))?Z$/;

// UTC の時刻（契約の UtcTime）だけを受け付ける。タイムゾーン付きや日付だけの値は拒否する。
// 存在しない日付・時刻（2 月 31 日、24 時、13 月）は Date が補正してしまうので、成分を往復で確かめて拒否する。
// 小数部はミリ秒までで切り捨てる。
function parseUtc(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = UTC_TIME.exec(value);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  const millis = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3));
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const back = new Date(ms);
  if (
    Number.isNaN(ms) ||
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day ||
    back.getUTCHours() !== hour ||
    back.getUTCMinutes() !== minute ||
    back.getUTCSeconds() !== second
  )
    return null;
  return ms;
}

export interface TimeWindow {
  readonly start: string;
  readonly end: string;
}

// 24 時間 × 日数で数える（夏時間やタイムゾーンに依らない）。範囲外の設定は呼び出し側が先に拒否する。
function windowAround(
  nowMs: number,
  pastDays: number,
  futureDays: number,
): TimeWindow {
  return {
    start: new Date(nowMs - pastDays * DAY_MS).toISOString(),
    end: new Date(nowMs + futureDays * DAY_MS).toISOString(),
  };
}

// メールの窓: [now − lookback, now]。受信が now より後のものは取らない。
export function mailWindow(scope: FetchScope, now: string): TimeWindow | null {
  const nowMs = parseUtc(now);
  if (nowMs === null) return null;
  return windowAround(nowMs, scope.mailLookbackDays, 0);
}

// カレンダーの窓: [now − 過去, now + 未来]（events.list の timeMin／timeMax）。
export function calendarWindow(
  scope: FetchScope,
  now: string,
): TimeWindow | null {
  const nowMs = parseUtc(now);
  if (nowMs === null) return null;
  return windowAround(nowMs, scope.calendarPastDays, scope.calendarFutureDays);
}

// ---- 取得してよいかの検査（拒否の理由は固定の語。値・件名・本文は載せない） ----

export type FetchRejection =
  | 'scope_invalid'
  | 'time_invalid'
  | 'calendar_not_selected'
  | 'container_not_selected'
  | 'before_window'
  | 'after_window'
  | 'attachment_kind_unsupported'
  | 'attachment_kind_mismatch'
  | 'attachment_kind_not_selected'
  | 'attachment_size_unknown'
  | 'attachment_too_large';

export type FetchCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: FetchRejection };

const ok: FetchCheck = { ok: true };
const reject = (reason: FetchRejection): FetchCheck => ({ ok: false, reason });

export interface CalendarEventRef {
  readonly calendarId: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

// 予定の取得可否。選択したカレンダーで、窓と重なる予定だけ。端は Google の timeMin／timeMax と同じく
// 「終了が窓の始まりより後」かつ「開始が窓の終わりより前」で、ちょうど端に接するだけの予定は取らない。
export function checkCalendarEvent(
  scope: FetchScope,
  event: CalendarEventRef,
  now: string,
): FetchCheck {
  if (validateFetchScope(scope).length > 0) return reject('scope_invalid');
  if (!scope.calendarIds.includes(event.calendarId))
    return reject('calendar_not_selected');
  const window = calendarWindow(scope, now);
  const start = parseUtc(event.startsAt);
  const end = parseUtc(event.endsAt);
  if (window === null || start === null || end === null || end < start)
    return reject('time_invalid');
  if (end <= Date.parse(window.start)) return reject('before_window');
  if (start >= Date.parse(window.end)) return reject('after_window');
  return ok;
}

export interface MailMessageRef {
  // Gmail のラベル、Outlook のフォルダー。1 通が複数に属してもよい（どれか 1 つが選択済みなら取る）。
  readonly containerIds: readonly string[];
  readonly receivedAt: string;
}

// メールの取得可否。選択したフォルダー／ラベルに属し、受信が [now − lookback, now] の中（両端を含む）。
export function checkMailMessage(
  scope: FetchScope,
  message: MailMessageRef,
  now: string,
): FetchCheck {
  if (validateFetchScope(scope).length > 0) return reject('scope_invalid');
  if (!message.containerIds.some((id) => scope.mailContainerIds.includes(id)))
    return reject('container_not_selected');
  const window = mailWindow(scope, now);
  const received = parseUtc(message.receivedAt);
  if (window === null || received === null) return reject('time_invalid');
  if (received < Date.parse(window.start)) return reject('before_window');
  if (received > Date.parse(window.end)) return reject('after_window');
  return ok;
}

// 拡張子と MIME から添付の種類を決める。どちらかが対象外、または食い違うときは種類を決めない（取らない側に倒す）。
const KIND_BY_MIME: Readonly<Record<string, AttachmentKind>> = {
  'application/pdf': 'pdf',
  'text/plain': 'text',
  'text/markdown': 'text',
  'text/csv': 'text',
};
const KIND_BY_EXTENSION: Readonly<Record<string, AttachmentKind>> = {
  pdf: 'pdf',
  txt: 'text',
  md: 'text',
  csv: 'text',
};
// 種類を決められない一般的な MIME。拡張子だけで決める。
const GENERIC_MIME = new Set([
  'application/octet-stream',
  'binary/octet-stream',
]);

export type AttachmentClassification =
  | { readonly kind: AttachmentKind }
  | { readonly kind: null; readonly reason: 'unsupported' | 'mismatch' };

export function classifyAttachment(input: {
  readonly mimeType: string;
  readonly filename: string;
}): AttachmentClassification {
  const mime = input.mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  const dot = input.filename.lastIndexOf('.');
  const extension =
    dot >= 0
      ? input.filename
          .slice(dot + 1)
          .trim()
          .toLowerCase()
      : '';
  const byMime = Object.hasOwn(KIND_BY_MIME, mime)
    ? KIND_BY_MIME[mime]
    : undefined;
  const byExtension = Object.hasOwn(KIND_BY_EXTENSION, extension)
    ? KIND_BY_EXTENSION[extension]
    : undefined;
  // 拡張子が付いているのに対象外なら、MIME が対象でも取らない（実行ファイルを PDF と偽る型など）。
  if (extension !== '' && byExtension === undefined)
    return { kind: null, reason: 'unsupported' };
  if (byMime !== undefined && byExtension !== undefined)
    return byMime === byExtension
      ? { kind: byMime }
      : { kind: null, reason: 'mismatch' };
  if (byMime !== undefined) return { kind: byMime };
  if (byExtension !== undefined && GENERIC_MIME.has(mime))
    return { kind: byExtension };
  return { kind: null, reason: 'unsupported' };
}

export interface AttachmentRef {
  readonly mimeType: string;
  readonly filename: string;
  // provider が申告するサイズ。分からない（null）添付は取らない。
  readonly sizeBytes: number | null;
}

// 添付の取得可否。選んだ種類で、1 件が上限以下。上限ちょうどは取り、1 バイトでも超えれば取らない。
export function checkAttachment(
  scope: FetchScope,
  attachment: AttachmentRef,
): FetchCheck {
  if (validateFetchScope(scope).length > 0) return reject('scope_invalid');
  const classified = classifyAttachment(attachment);
  if (classified.kind === null)
    return reject(
      classified.reason === 'mismatch'
        ? 'attachment_kind_mismatch'
        : 'attachment_kind_unsupported',
    );
  if (!scope.attachmentKinds.includes(classified.kind))
    return reject('attachment_kind_not_selected');
  const size = attachment.sizeBytes;
  if (size === null || !Number.isSafeInteger(size) || size < 0)
    return reject('attachment_size_unknown');
  if (size > scope.attachmentMaxBytes) return reject('attachment_too_large');
  return ok;
}

// ---- 自動で足さない ----

export interface DiscoveredTargets {
  readonly calendarIds: readonly string[];
  readonly mailContainerIds: readonly string[];
}

export interface DiscoveryResult {
  // 入力の scope をそのまま返す（見つかったものを足さない）。
  readonly scope: FetchScope;
  // 選ばれていない、新しく見つかったもの。画面に「選べる候補」として出すだけで、取得しない。
  readonly unselected: DiscoveredTargets;
  // 選択済みだが provider の一覧に無くなったもの。選択から外さず、本人に知らせる材料にする。
  readonly missing: DiscoveredTargets;
}

export function reconcileDiscoveredTargets(
  scope: FetchScope,
  discovered: DiscoveredTargets,
): DiscoveryResult {
  const diff = (a: readonly string[], b: readonly string[]): string[] =>
    [...new Set(a)].filter((id) => !b.includes(id)).sort();
  return {
    scope,
    unselected: {
      calendarIds: diff(discovered.calendarIds, scope.calendarIds),
      mailContainerIds: diff(
        discovered.mailContainerIds,
        scope.mailContainerIds,
      ),
    },
    missing: {
      calendarIds: diff(scope.calendarIds, discovered.calendarIds),
      mailContainerIds: diff(
        scope.mailContainerIds,
        discovered.mailContainerIds,
      ),
    },
  };
}

// ---- 版 ----

export interface FetchScopeState {
  readonly scope: FetchScope;
  // 契約の PermissionRevision と ScopeRevision（10 進の文字列）。
  readonly permissionRevision: string;
  readonly scopeRevision: string;
}

const REVISION = /^(0|[1-9][0-9]*)$/;
const bump = (revision: string): string => (BigInt(revision) + 1n).toString();

export type ScopeUpdateRejection =
  | { readonly reason: 'invalid_scope'; readonly issues: FetchScopeIssue[] }
  | { readonly reason: 'revision_invalid' }
  | { readonly reason: 'permission_revision_mismatch' };

export type ScopeUpdateResult =
  | {
      readonly ok: true;
      // 変更が無ければ版を上げず、保存済みの状態をそのまま返す（同じ要求の再送で版が進まない）。
      readonly changed: boolean;
      readonly state: FetchScopeState;
    }
  | ({ readonly ok: false } & ScopeUpdateRejection);

// 本人の選択の変更。期待する許可版が現在と違えば拒否する。変更があれば許可版と取得範囲の版を 1 つずつ上げ、
// 旧範囲の走査は scanCurrentReasons（sync.ts）が scope_revision の不一致で無効にする。
export function applyFetchScopeUpdate(
  current: FetchScopeState,
  request: {
    readonly expectedPermissionRevision: string;
    readonly next: FetchScope;
  },
): ScopeUpdateResult {
  if (
    !REVISION.test(current.permissionRevision) ||
    !REVISION.test(current.scopeRevision) ||
    !REVISION.test(request.expectedPermissionRevision)
  )
    return { ok: false, reason: 'revision_invalid' };
  if (request.expectedPermissionRevision !== current.permissionRevision)
    return { ok: false, reason: 'permission_revision_mismatch' };
  const issues = validateFetchScope(request.next);
  if (issues.length > 0) return { ok: false, reason: 'invalid_scope', issues };
  if (sameFetchScope(current.scope, request.next))
    return { ok: true, changed: false, state: current };
  return {
    ok: true,
    changed: true,
    state: {
      scope: normalizeFetchScope(request.next),
      permissionRevision: bump(current.permissionRevision),
      scopeRevision: bump(current.scopeRevision),
    },
  };
}

export type FetchRequestStale =
  'revision_invalid' | 'scope_revision_stale' | 'permission_revision_stale';

// 取得要求が今の版で作られたか。選択が変わった後の古い版での要求は取得しない。
export function fetchRequestStale(
  current: Pick<FetchScopeState, 'permissionRevision' | 'scopeRevision'>,
  request: {
    readonly permissionRevision: string;
    readonly scopeRevision: string;
  },
): FetchRequestStale | null {
  if (
    !REVISION.test(request.permissionRevision) ||
    !REVISION.test(request.scopeRevision) ||
    !REVISION.test(current.permissionRevision) ||
    !REVISION.test(current.scopeRevision)
  )
    return 'revision_invalid';
  if (request.scopeRevision !== current.scopeRevision)
    return 'scope_revision_stale';
  if (request.permissionRevision !== current.permissionRevision)
    return 'permission_revision_stale';
  return null;
}
