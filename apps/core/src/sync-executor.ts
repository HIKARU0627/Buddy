// 同期の走査の実行器（設計 11 §1・§1A、設計 04 同期方式の選定、B08-05、ADR 0136）。
//
// 呼ばれたら 1 回だけ走る。開始（排他）→ ページごとの取得と staging（次の継続位置を同じ保存に記録）→
// 検証 → 公開（compare-and-swap）までを、connector のページ読み取りと storage の sync 操作でつなぐ。
// 排他・公開の規則の正本は domain の sync.ts で、保存の transaction は storage が持つ。ここは手順と失敗の扱いだけを持つ。
// - 周期の起動（60 秒のポーリング・起動時の再開・担当世代の更新）は B08-06 のゲート。ここはタイマーを持たない。
// - 途中失敗では公開せず、走査は継続位置まで保存した状態で残す。固定した窓と query_fingerprint が一致すれば、
//   次の呼出しが保存済みの継続位置から同じ走査を再開する（11 §1A）。再開できない条件（範囲の版・担当世代・
//   指紋の不一致）の走査には触らず、新しい要求は pending に積まれる。
// - 履歴の起点の失効（404）は旧走査を abandoned にして全量へ切り替える（11 §1A）。
// - トークンは接続ごとの出所（tokenSourceFor）を注入で受ける。口が無い接続は走査しない。実 OAuth の保存・更新と、
//   接続の作成時に account_id と取得集合を用意するのは B03-04 で、ここは呼び出し側から渡された値だけを使う。
// - 取得範囲は接続の保存済みの選択だけを使う（domain の窓の規則）。範囲を広げる既定値は作らない。
// - 走査は外部の読み取りなので、保存期限の掃除のゲートを通す（ADR 0053・0058）。掃除が済むまで始めず、
//   取得から公開までの間は貸し出しを持って掃除の本体と直列にする。ゲートの製品配線（core.ts から
//   RetentionSweeper を渡す）は、周期の起動と合わせて B08-06 で行う。
// - 継続位置（page_cursor）は保存層にとって不透明な文字列で、複数コンテナを順に走査する走査では
//   「コンテナの位置＋ページトークン」を JSON で持つ。履歴（history.list）は単一の流れなのでトークンそのもの。

import { createHash, randomUUID } from 'node:crypto';
import { calendarWindow, mailWindow } from '@buddy/domain';
import type { FetchScope, StartupGateDecision } from '@buddy/domain';
import {
  GoogleApiError,
  GoogleHistoryExpiredError,
  createGoogleReadConnector,
} from '@buddy/connectors';
import type {
  GoogleAccessTokenSource,
  GoogleCalendarEvent,
  GoogleReadConnector,
} from '@buddy/connectors';
import type {
  ConnectionRecord,
  DbWorkerClient,
  SyncBatchRecord,
  SyncScopeRecord,
  SyncStagedItem,
} from '@buddy/storage';

export type SyncResourceKind = 'mail' | 'calendar';
export type SyncScanKind = 'incremental' | 'full';

export interface SyncExecutorOptions {
  readonly store: Pick<DbWorkerClient, 'connectionTargets' | 'sync'>;
  // 接続ごとのアクセストークンの出所。null を返す・省略した接続は走査しない（token_unavailable）。
  readonly tokenSourceFor?: (
    connection: ConnectionRecord,
  ) => GoogleAccessTokenSource | null;
  // connector の作り方（試験で差し替える）。省略時は Google の読み取り connector。
  readonly createConnector?: (
    tokenSource: GoogleAccessTokenSource,
  ) => GoogleReadConnector;
  readonly now?: () => Date;
  readonly newScanId?: () => string;
  // 保存期限の掃除のゲート（ADR 0053・0058）。省略時は通さない（試験・模擬用）。
  // 製品では B08-06 が RetentionSweeper の ready／gate／lease を渡す。
  readonly retention?: {
    readonly ready: () => Promise<void>;
    readonly gate: () => StartupGateDecision;
    // ゲートの確認から公開の終わりまでを掃除の本体と直列にする貸し出し。取れないときは null。
    readonly lease: () => (() => void) | null;
  };
}

export interface SyncScanRequest {
  readonly connection_id: string;
  // source_items のキー（provider のアカウント識別子）。接続の作成（B03-04）が持つ値を呼び出し側が渡す。
  readonly account_id: string;
  readonly scope_id: string;
  readonly resource: SyncResourceKind;
  readonly kind: SyncScanKind;
}

export type SyncScanOutcome =
  | {
      readonly status: 'published';
      readonly scan_id: string;
      readonly diff_count: number;
      readonly resumed: boolean;
      readonly scope: SyncScopeRecord;
      // 公開した走査の種類と、取得の窓の終わり（予定の重複の取り込みが、同期が保存した範囲の外を読まないために使う。ADR 0194）。
      readonly kind: SyncScanKind;
      readonly window_end: string;
    }
  | { readonly status: 'queued'; readonly scope: SyncScopeRecord }
  | {
      readonly status: 'held';
      readonly reason: 'clock_regression';
      readonly scope: SyncScopeRecord;
    }
  | {
      readonly status: 'failed';
      // 理由はコードだけ（種別・状態コード・保存層の理由）。トークン・本文・URL は入れない。
      readonly reason: string;
      readonly scan_id: string | null;
    }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface SyncExecutor {
  runScan(request: SyncScanRequest): Promise<SyncScanOutcome>;
}

const FIVE_MINUTES_MS = 5 * 60_000;

const unavailable = (reason: string): SyncScanOutcome => ({
  status: 'unavailable',
  reason,
});
const failed = (reason: string, scanId: string | null): SyncScanOutcome => ({
  status: 'failed',
  reason,
  scan_id: scanId,
});

// 接続の保存済みの取得対象（ワイヤの形）を domain の FetchScope にする（storage の写しと同じ）。
export function toFetchScope(record: ConnectionRecord): FetchScope {
  return {
    calendarIds: record.targets.calendar_ids,
    mailContainerIds: record.targets.mail_container_ids,
    attachmentKinds: record.targets.attachment_kinds,
    mailLookbackDays: record.targets.mail_lookback_days,
    calendarPastDays: record.targets.calendar_past_days,
    calendarFutureDays: record.targets.calendar_future_days,
    attachmentMaxBytes: record.targets.attachment_max_bytes,
  };
}

// 走査の固定条件の指紋。窓・範囲の版・起点が変われば別の走査として扱い、再開の照合にも使う。
function queryFingerprint(parts: {
  readonly resource: SyncResourceKind;
  readonly kind: SyncScanKind;
  readonly scopeRevision: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly base: string;
  readonly fetchScope: FetchScope;
}): string {
  const canonical = [
    'google',
    parts.resource,
    parts.kind,
    parts.scopeRevision,
    parts.windowStart,
    parts.windowEnd,
    parts.base,
    parts.fetchScope.calendarIds.join(','),
    parts.fetchScope.mailContainerIds.join(','),
  ].join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// 予定の版。etag → updated の順で使い、どちらも無ければ ID から決まる固定値にする（存在の差分だけは追える）。
export function eventRevision(event: GoogleCalendarEvent): string {
  return event.etag ?? event.updated ?? `no-revision:${event.id}`;
}

// メールの版。messages.get の historyId（そのメールの最後の変更の履歴 ID）を使う。
export function messageRevision(message: {
  readonly id: string;
  readonly historyId?: string;
}): string {
  return message.historyId ?? `no-revision:${message.id}`;
}

// 複数コンテナの走査の継続位置（コンテナの位置＋そのページトークン）。
interface ContainerCursor {
  readonly container: number;
  readonly token: string | null;
}

function encodeCursor(cursor: ContainerCursor): string {
  return JSON.stringify(cursor);
}

function decodeCursor(raw: string | null): ContainerCursor {
  if (raw === null) return { container: 0, token: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Number.isSafeInteger((parsed as ContainerCursor).container) &&
      ((parsed as ContainerCursor).token === null ||
        typeof (parsed as ContainerCursor).token === 'string')
    )
      return parsed as ContainerCursor;
  } catch {
    // 形の違う継続位置は先頭から読み直す（固定窓の中なので安全）。
  }
  return { container: 0, token: null };
}

interface ScanContext {
  readonly connector: GoogleReadConnector;
  readonly store: SyncExecutorOptions['store'];
  readonly request: SyncScanRequest;
  readonly fetchScope: FetchScope;
  readonly windowStart: string;
  readonly windowEnd: string;
}

type StageOutcome =
  | { readonly ok: true; readonly providerCursor: string | null }
  | { readonly ok: false; readonly reason: string };

// ページを staging へ保存する。保存層の拒否（古い走査・範囲変更など）は理由コードのまま失敗にする。
async function stagePage(
  ctx: ScanContext,
  scanId: string,
  pageNo: number,
  items: readonly SyncStagedItem[],
  nextPageCursor: string | null,
): Promise<string | null> {
  const result = await ctx.store.sync({
    kind: 'sync.stage_page',
    scan_id: scanId,
    page_no: pageNo,
    items: [...items],
    next_page_cursor: nextPageCursor,
  });
  return result.ok ? null : result.reasons.join('+');
}

const inWindow = (ctx: ScanContext, atMs: number): boolean =>
  atMs >= Date.parse(ctx.windowStart) && atMs <= Date.parse(ctx.windowEnd);

// Gmail の増分（history.list）。追加・ラベルの増減は messages.get（minimal）で版と範囲を確認してから仮置きする。
// 継続位置は history のページトークンそのもの。再開時はそこから続きを読む。
async function stageMailIncremental(
  ctx: ScanContext,
  scanId: string,
  baseCursor: string,
  resumeCursor: string | null,
): Promise<StageOutcome> {
  const gmail = ctx.connector.gmail;
  let pageToken: string | undefined = resumeCursor ?? undefined;
  let pageNo = 0;
  // 最終ページの応答の historyId が次の起点。ループは必ず 1 ページ目で代入してから返る。
  let providerCursor: string;
  for (;;) {
    const page = await gmail.listHistoryPage({
      startHistoryId: baseCursor,
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    providerCursor = page.historyId;
    const staged = new Map<string, SyncStagedItem>();
    const deleted = new Set<string>();
    const checkIds = new Set<string>();
    for (const entry of page.items) {
      for (const id of entry.addedMessageIds) checkIds.add(id);
      for (const change of entry.labelsAdded) checkIds.add(change.messageId);
      for (const change of entry.labelsRemoved) checkIds.add(change.messageId);
      for (const id of entry.deletedMessageIds) deleted.add(id);
    }
    for (const id of checkIds) {
      if (deleted.has(id)) continue;
      let message;
      try {
        message = await gmail.getMessage({ id, format: 'minimal' });
      } catch (error) {
        // 履歴に載った直後に消えたメールは、削除として仮置きする。
        if (error instanceof GoogleApiError && error.status === 404) {
          staged.set(id, {
            remote_id: id,
            source_revision: `no-revision:${id}`,
            change: 'delete',
          });
          continue;
        }
        throw error;
      }
      const inScope =
        message.labelIds.some((label) =>
          ctx.fetchScope.mailContainerIds.includes(label),
        ) &&
        (message.internalDate === undefined ||
          inWindow(ctx, Number(message.internalDate)));
      staged.set(id, {
        remote_id: id,
        source_revision: messageRevision(message),
        change: inScope ? 'upsert' : 'out_of_scope',
      });
    }
    for (const id of deleted) {
      staged.set(id, {
        remote_id: id,
        source_revision: `no-revision:${id}`,
        change: 'delete',
      });
    }
    const reason = await stagePage(
      ctx,
      scanId,
      pageNo,
      [...staged.values()],
      page.nextPageToken ?? null,
    );
    if (reason !== null) return { ok: false, reason };
    pageNo += 1;
    if (page.nextPageToken === undefined) return { ok: true, providerCursor };
    pageToken = page.nextPageToken;
  }
}

// Gmail の全量（選択ラベルごとに messages.list を順に）。既に公開済みの ID は保存済みの版で仮置きし、
// 新しい ID だけ messages.get（minimal）で版・受信時刻を確かめる（設計 11 §1: 取得は未取得・変更だけ）。
async function stageMailFull(
  ctx: ScanContext,
  scanId: string,
  baseCursor: string | null,
  resumeCursor: string | null,
): Promise<StageOutcome> {
  const gmail = ctx.connector.gmail;
  const published = await ctx.store.sync({
    kind: 'sync.list_published',
    scope_id: ctx.request.scope_id,
    provider: 'google',
    account_id: ctx.request.account_id,
  });
  if (!published.ok) return { ok: false, reason: published.reasons.join('+') };
  const known = new Map(
    published.value.map((item) => [item.remote_id, item.source_revision]),
  );
  let observedCursor: bigint | null =
    baseCursor === null ? null : BigInt(baseCursor);
  const start = decodeCursor(resumeCursor);
  let pageNo = 0;
  const labels = ctx.fetchScope.mailContainerIds;
  for (let index = start.container; index < labels.length; index += 1) {
    const label = labels[index] as string;
    let pageToken: string | undefined =
      index === start.container ? (start.token ?? undefined) : undefined;
    for (;;) {
      const page = await gmail.listMessageIdsPage({
        labelIds: [label],
        afterEpochSeconds: Math.floor(Date.parse(ctx.windowStart) / 1000),
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      const staged: SyncStagedItem[] = [];
      for (const ref of page.items) {
        const revision = known.get(ref.id);
        if (revision !== undefined) {
          staged.push({
            remote_id: ref.id,
            source_revision: revision,
            change: 'upsert',
          });
          continue;
        }
        let message;
        try {
          message = await gmail.getMessage({ id: ref.id, format: 'minimal' });
        } catch (error) {
          if (error instanceof GoogleApiError && error.status === 404) continue;
          throw error;
        }
        if (message.historyId !== undefined) {
          const value = BigInt(message.historyId);
          if (observedCursor === null || value > observedCursor)
            observedCursor = value;
        }
        // 窓の後に届いたメールは今回の固定窓に入れない（次の増分が拾う）。
        if (
          message.internalDate !== undefined &&
          !inWindow(ctx, Number(message.internalDate))
        )
          continue;
        staged.push({
          remote_id: ref.id,
          source_revision: messageRevision(message),
          change: 'upsert',
        });
      }
      const lastPage = page.nextPageToken === undefined;
      const nextCursor: ContainerCursor = lastPage
        ? { container: index + 1, token: null }
        : { container: index, token: page.nextPageToken as string };
      const reason = await stagePage(
        ctx,
        scanId,
        pageNo,
        staged,
        index === labels.length - 1 && lastPage
          ? null
          : encodeCursor(nextCursor),
      );
      if (reason !== null) return { ok: false, reason };
      pageNo += 1;
      if (lastPage) break;
      pageToken = page.nextPageToken;
    }
  }
  return {
    ok: true,
    providerCursor:
      observedCursor === null ? baseCursor : observedCursor.toString(),
  };
}

// Google Calendar の列挙（全量は updatedMin なし、増分は watermark の 5 分前から）。取消は削除として仮置きする。
async function stageCalendar(
  ctx: ScanContext,
  scanId: string,
  updatedMin: string | undefined,
  resumeCursor: string | null,
): Promise<StageOutcome> {
  const start = decodeCursor(resumeCursor);
  let pageNo = 0;
  const calendars = ctx.fetchScope.calendarIds;
  for (let index = start.container; index < calendars.length; index += 1) {
    const calendarId = calendars[index] as string;
    let pageToken: string | undefined =
      index === start.container ? (start.token ?? undefined) : undefined;
    for (;;) {
      const page = await ctx.connector.calendar.listEventsPage({
        calendarId,
        timeMin: ctx.windowStart,
        timeMax: ctx.windowEnd,
        ...(updatedMin === undefined ? {} : { updatedMin }),
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      const staged: SyncStagedItem[] = page.items.map((event) => ({
        remote_id: event.id,
        source_revision: eventRevision(event),
        change: event.status === 'cancelled' ? 'delete' : 'upsert',
      }));
      const lastPage = page.nextPageToken === undefined;
      const nextCursor: ContainerCursor = lastPage
        ? { container: index + 1, token: null }
        : { container: index, token: page.nextPageToken as string };
      const reason = await stagePage(
        ctx,
        scanId,
        pageNo,
        staged,
        index === calendars.length - 1 && lastPage
          ? null
          : encodeCursor(nextCursor),
      );
      if (reason !== null) return { ok: false, reason };
      pageNo += 1;
      if (lastPage) break;
      pageToken = page.nextPageToken;
    }
  }
  return { ok: true, providerCursor: null };
}

export function createSyncExecutor(options: SyncExecutorOptions): SyncExecutor {
  const now = options.now ?? (() => new Date());
  const newScanId = options.newScanId ?? (() => randomUUID());
  const createConnector =
    options.createConnector ??
    ((tokenSource: GoogleAccessTokenSource) =>
      createGoogleReadConnector({ tokenSource }));
  const { store } = options;

  async function runScan(request: SyncScanRequest): Promise<SyncScanOutcome> {
    // 掃除が済むまで外部の読み取りを始めない（ADR 0053）。ゲートの確認と貸し出しの取得は同じ区間で行い、
    // 取得・staging・公開が終わるまで貸し出しを持つ（貸し出し中に始まった掃除は本体に入らない）。
    let release: (() => void) | null = null;
    if (options.retention !== undefined) {
      for (let attempt = 0; release === null && attempt < 3; attempt += 1) {
        await options.retention.ready();
        const gate = options.retention.gate();
        if (!gate.search || !gate.auto_use)
          return unavailable('retention_gate_closed');
        // 取れないのは、ready の後に別の掃除が始まったとき。その掃除が済むのを待って確かめ直す。
        release = options.retention.lease();
      }
      if (release === null) return unavailable('retention_gate_closed');
    }
    try {
      return await executeScan(request);
    } finally {
      release?.();
    }
  }

  async function executeScan(
    request: SyncScanRequest,
  ): Promise<SyncScanOutcome> {
    const connectionResult = await store.connectionTargets({
      kind: 'connections.get',
      connection_id: request.connection_id,
    });
    if (!connectionResult.ok) return unavailable('store_unavailable');
    const connection = connectionResult.value;
    if (connection === null) return unavailable('connection_not_found');
    if (connection.provider !== 'google')
      return unavailable('provider_unsupported');
    if (connection.status !== 'active')
      return unavailable('connection_not_active');
    if (connection.targets_state !== 'complete')
      return unavailable('targets_incomplete');
    const tokenSource = options.tokenSourceFor?.(connection) ?? null;
    if (tokenSource === null) return unavailable('token_unavailable');

    const snapshotResult = await store.sync({
      kind: 'sync.get_scope',
      scope_id: request.scope_id,
    });
    if (!snapshotResult.ok) return unavailable('store_unavailable');
    const snapshot = snapshotResult.value;
    if (snapshot === null) return unavailable('scope_not_found');
    if (snapshot.scope.connection_id !== request.connection_id)
      return unavailable('scope_mismatch');
    const scope = snapshot.scope;
    const fetchScope = toFetchScope(connection);

    // 全量照合の要求が残っていれば、要求の種類より先に全量を行う（11 §1A の pending）。
    const wantedKind: SyncScanKind = scope.pending_full ? 'full' : request.kind;

    // 実行中の走査があり、固定条件（窓・指紋・種類・担当世代）が一致すれば、その走査を継続位置から再開する。
    const active = snapshot.active_batch;
    let batch: SyncBatchRecord | null = null;
    let resumed = false;
    if (
      active !== null &&
      active.executor_generation === scope.executor_generation &&
      active.kind === wantedKind &&
      (active.status === 'fetching' || active.status === 'staged')
    ) {
      const fingerprint = queryFingerprint({
        resource: request.resource,
        kind: active.kind,
        scopeRevision: active.scope_revision,
        windowStart: active.window_start,
        windowEnd: active.window_end,
        base:
          active.kind === 'full'
            ? ''
            : (active.base_provider_cursor ?? active.base_watermark ?? ''),
        fetchScope,
      });
      if (fingerprint === active.query_fingerprint) {
        batch = active;
        resumed = true;
      }
    }

    let scanId: string;
    let kind: SyncScanKind;
    let windowStart: string;
    let windowEnd: string;
    let resumeCursor: string | null;
    if (batch !== null) {
      scanId = batch.scan_id;
      kind = batch.kind;
      windowStart = batch.window_start;
      windowEnd = batch.window_end;
      resumeCursor = batch.page_cursor;
    } else {
      const startedAt = now().toISOString();
      const window =
        request.resource === 'mail'
          ? mailWindow(fetchScope, startedAt)
          : calendarWindow(fetchScope, startedAt);
      if (window === null) return unavailable('window_invalid');
      kind = wantedKind;
      // 増分の起点が無ければ全量から始める（初回・起点が無いとき）。
      const base =
        kind === 'full'
          ? ''
          : request.resource === 'mail'
            ? (scope.provider_cursor ?? '')
            : (scope.committed_watermark ?? '');
      if (kind === 'incremental' && base === '') kind = 'full';
      windowStart = window.start;
      windowEnd = window.end;
      resumeCursor = null;
      scanId = newScanId();
      const begin = await store.sync({
        kind: 'sync.begin',
        scope_id: request.scope_id,
        scan_id: scanId,
        scan_kind: kind,
        now: startedAt,
        window_start: windowStart,
        window_end: windowEnd,
        query_fingerprint: queryFingerprint({
          resource: request.resource,
          kind,
          scopeRevision: connection.scope_revision,
          windowStart,
          windowEnd,
          base: kind === 'full' ? '' : base,
          fetchScope,
        }),
      });
      if (!begin.ok) return failed(begin.reasons.join('+'), null);
      if (begin.value.outcome === 'held')
        return {
          status: 'held',
          reason: 'clock_regression',
          scope: begin.value.scope,
        };
      if (begin.value.outcome === 'queued' || begin.value.batch === null)
        return { status: 'queued', scope: begin.value.scope };
      batch = begin.value.batch;
    }

    const ctx: ScanContext = {
      connector: createConnector(tokenSource),
      store,
      request,
      fetchScope,
      windowStart,
      windowEnd,
    };

    let providerCursor: string | null = scope.provider_cursor;
    try {
      let staged: StageOutcome;
      if (request.resource === 'mail' && kind === 'incremental') {
        const base = batch.base_provider_cursor ?? scope.provider_cursor;
        if (base === null) return failed('cursor_missing', scanId);
        staged = await stageMailIncremental(ctx, scanId, base, resumeCursor);
        if (staged.ok) providerCursor = staged.providerCursor;
      } else if (request.resource === 'mail') {
        staged = await stageMailFull(
          ctx,
          scanId,
          batch.base_provider_cursor,
          resumeCursor,
        );
        if (staged.ok) providerCursor = staged.providerCursor;
      } else {
        const updatedMin =
          kind === 'incremental'
            ? new Date(
                Date.parse(
                  batch.base_watermark ?? scope.committed_watermark ?? '',
                ) - FIVE_MINUTES_MS,
              ).toISOString()
            : undefined;
        staged = await stageCalendar(ctx, scanId, updatedMin, resumeCursor);
      }
      if (!staged.ok) return failed(staged.reason, scanId);
    } catch (error) {
      if (error instanceof GoogleHistoryExpiredError) {
        // 起点の失効は旧走査を abandoned にして、全量で最初から取り直す（11 §1A）。
        const abandoned = await store.sync({
          kind: 'sync.abandon',
          scan_id: scanId,
        });
        if (!abandoned.ok)
          return failed(
            `history_expired+${abandoned.reasons.join('+')}`,
            scanId,
          );
        if (kind === 'full') return failed('history_expired', scanId);
        return runScan({ ...request, kind: 'full' });
      }
      if (error instanceof GoogleApiError)
        return failed(
          `google_api_error:${error.kind}:${error.status === undefined ? 'none' : String(error.status)}`,
          scanId,
        );
      return failed('fetch_failed', scanId);
    }

    const validated = await store.sync({
      kind: 'sync.validate',
      scan_id: scanId,
    });
    if (!validated.ok) return failed(validated.reasons.join('+'), scanId);
    const published = await store.sync({
      kind: 'sync.publish',
      scan_id: scanId,
      provider: 'google',
      account_id: request.account_id,
      provider_cursor: providerCursor,
      completed_at: now().toISOString(),
    });
    if (!published.ok) return failed(published.reasons.join('+'), scanId);
    return {
      status: 'published',
      scan_id: scanId,
      diff_count: published.value.diff_count,
      resumed,
      scope: published.value.scope,
      kind: published.value.batch.kind,
      window_end: published.value.batch.window_end,
    };
  }

  return { runScan };
}
