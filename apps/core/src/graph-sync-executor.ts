// 同期の走査の実行器（Outlook／Microsoft Graph。設計 11 §1・§1A、設計 04 同期方式の選定、B09-04、ADR 0138）。
//
// B08-05 の Google 用実行器（sync-executor.ts）と同じ形で、開始（排他）→ ページごとの取得と staging →
// 検証 → 公開（compare-and-swap）を、Graph connector のページ読み取りと storage の sync 操作でつなぐ。
// 排他・公開の規則の正本は domain の sync.ts で、保存層は provider 'microsoft' をそのまま受ける。ここは手順と
// 失敗の扱いだけを持つ。周期の起動は B08-06 の scheduler が provider で振り分ける実行器
// （provider-sync-executor.ts）越しに呼ぶ。ここはタイマーを持たない。
// - 増分は選択フォルダーごとに lastModifiedDateTime ge（前回成功時刻＝committed_watermark の 5 分前）で読む
//   （設計 11 §1 の Outlook の行）。Graph の delta は使わない（設計 04・ADR 0134）。
// - 全量は選択フォルダーごとに receivedDateTime ge 窓の開始で全ページを列挙する。不在の削除・移動の検知は
//   保存層の公開（全量のときだけ staging に無い公開済み行を消す）が担う。フォルダー単位の全量間隔
//   （受信トレイ 15 分・その他 6 時間）は、公開と不在判定が scope 単位でフォルダー別の照合状態が無いため
//   ここでは扱わない（ADR 0138 の残件）。
// - 版（source_revision）は lastModifiedDateTime。フォルダー移動・カテゴリ変更・既読の変更で進むため、
//   移動も版の差分として表れる。基本キーは immutable_id で、所属フォルダーはキーに含めない（設計 04・QA23）。
// - provider cursor は持たない（delta を使わないので、起点は時刻型 watermark だけ）。公開では null を渡す。
// - トークンは接続ごとの出所（tokenSourceFor）を注入で受ける。口が無い接続は走査しない。実 OAuth の保存・更新と、
//   接続の作成時に account_id と取得集合を用意するのは B03-04 で、ここは呼び出し側から渡された値だけを使う。
// - 走査は外部の読み取りなので、保存期限の掃除のゲートを通す（ADR 0053・0058。Google 用実行器と同じ）。

import { createHash, randomUUID } from 'node:crypto';
import { mailWindow } from '@buddy/domain';
import type { FetchScope, StartupGateDecision } from '@buddy/domain';
import { createGraphMailConnector } from '@buddy/connectors';
import type {
  GraphMailConnector,
  GraphMailMessage,
  GraphReadFailure,
} from '@buddy/connectors';
import type {
  ConnectionRecord,
  DbWorkerClient,
  SyncBatchRecord,
  SyncStagedItem,
} from '@buddy/storage';
import type {
  SyncExecutor,
  SyncScanKind,
  SyncScanOutcome,
  SyncScanRequest,
} from './sync-executor.js';

// 委任トークンの取得関数（Graph connector の accessToken と同じ形）。connector は値を保持・記録しない。
export type GraphAccessTokenSource = () => Promise<string>;

export interface GraphSyncExecutorOptions {
  readonly store: Pick<DbWorkerClient, 'connectionTargets' | 'sync'>;
  // 接続ごとのアクセストークンの出所。null を返す・省略した接続は走査しない（token_unavailable）。
  readonly tokenSourceFor?: (
    connection: ConnectionRecord,
  ) => GraphAccessTokenSource | null;
  // connector の作り方（試験で差し替える）。省略時は Graph の読み取り connector。
  readonly createConnector?: (
    accessToken: GraphAccessTokenSource,
  ) => GraphMailConnector;
  readonly now?: () => Date;
  readonly newScanId?: () => string;
  // 保存期限の掃除のゲート（ADR 0053・0058）。省略時は通さない（試験・模擬用）。
  // 製品では core.ts が RetentionSweeper の ready／gate／lease を渡す。
  readonly retention?: {
    readonly ready: () => Promise<void>;
    readonly gate: () => StartupGateDecision;
    // ゲートの確認から公開の終わりまでを掃除の本体と直列にする貸し出し。取れないときは null。
    readonly lease: () => (() => void) | null;
  };
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

// 接続の保存済みの取得対象（ワイヤの形）を domain の FetchScope にする（Google 用実行器と同じ変換）。
function toFetchScope(record: ConnectionRecord): FetchScope {
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

// 走査の固定条件の指紋。窓・範囲の版・起点（watermark）が変われば別の走査として扱い、再開の照合にも使う。
function queryFingerprint(parts: {
  readonly kind: SyncScanKind;
  readonly scopeRevision: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly base: string;
  readonly fetchScope: FetchScope;
}): string {
  const canonical = [
    'microsoft',
    'mail',
    parts.kind,
    parts.scopeRevision,
    parts.windowStart,
    parts.windowEnd,
    parts.base,
    parts.fetchScope.mailContainerIds.join(','),
  ].join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// メールの版。lastModifiedDateTime を使い、無ければ ID から決まる固定値にする（存在の差分だけは追える）。
function messageRevision(message: GraphMailMessage): string {
  return message.last_modified_at ?? `no-revision:${message.immutable_id}`;
}

// 複数フォルダーの走査の継続位置（フォルダーの位置＋そのページの nextLink）。
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
  readonly connector: GraphMailConnector;
  readonly store: GraphSyncExecutorOptions['store'];
  readonly fetchScope: FetchScope;
  readonly windowStart: string;
  readonly windowEnd: string;
}

type StageOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

// connector の失敗（結果型）を、理由コードだけの文字列にする。状態・本文・トークンは入れない。
function graphFailureReason(failure: GraphReadFailure): string {
  switch (failure.kind) {
    case 'rejected':
      return `graph_rejected:${failure.reason}`;
    case 'authentication_expired':
      return 'graph_authentication_expired';
    case 'rate_limited':
      return 'graph_rate_limited';
    case 'unavailable':
      return `graph_unavailable:${failure.reason}`;
  }
}

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

// 選択フォルダーを順に、各フォルダーは nextLink が無くなるまでページ単位で読んで仮置きする。
// 増分（incremental）は modifiedSince の条件、全量（full）は receivedSince＝窓の開始の条件で読む。
async function stageMail(
  ctx: ScanContext,
  scanId: string,
  mode:
    | { readonly kind: 'incremental'; readonly modifiedSince: string }
    | { readonly kind: 'full' },
  resumeCursor: string | null,
): Promise<StageOutcome> {
  const start = decodeCursor(resumeCursor);
  let pageNo = 0;
  const folders = ctx.fetchScope.mailContainerIds;
  for (let index = start.container; index < folders.length; index += 1) {
    const folderId = folders[index] as string;
    let cursor: string | null = index === start.container ? start.token : null;
    for (;;) {
      const result = await ctx.connector.listMessagesPage(
        folderId,
        cursor !== null
          ? { cursor }
          : mode.kind === 'incremental'
            ? { modifiedSince: mode.modifiedSince }
            : { receivedSince: ctx.windowStart },
      );
      if (result.kind !== 'ok')
        return { ok: false, reason: graphFailureReason(result) };
      const page = result.value;
      const staged: SyncStagedItem[] = [];
      for (const message of page.messages) {
        const receivedMs =
          message.received_at === null ? null : Date.parse(message.received_at);
        if (mode.kind === 'full') {
          // 窓の後に届いたメールは今回の固定窓に入れない（次の増分が拾う）。受信時刻が読めないものは入れる。
          if (
            receivedMs !== null &&
            Number.isFinite(receivedMs) &&
            receivedMs > Date.parse(ctx.windowEnd)
          )
            continue;
          staged.push({
            remote_id: message.immutable_id,
            source_revision: messageRevision(message),
            change: 'upsert',
          });
        } else {
          // 増分で届いた古いメール（既読・カテゴリの変更など）は、受信が窓の外なら範囲外として仮置きする。
          const inScope =
            receivedMs === null ||
            !Number.isFinite(receivedMs) ||
            inWindow(ctx, receivedMs);
          staged.push({
            remote_id: message.immutable_id,
            source_revision: messageRevision(message),
            change: inScope ? 'upsert' : 'out_of_scope',
          });
        }
      }
      const lastPage = page.next_cursor === null;
      const nextCursor: ContainerCursor = lastPage
        ? { container: index + 1, token: null }
        : { container: index, token: page.next_cursor as string };
      const reason = await stagePage(
        ctx,
        scanId,
        pageNo,
        staged,
        index === folders.length - 1 && lastPage
          ? null
          : encodeCursor(nextCursor),
      );
      if (reason !== null) return { ok: false, reason };
      pageNo += 1;
      if (lastPage) break;
      cursor = page.next_cursor;
    }
  }
  return { ok: true };
}

export function createGraphSyncExecutor(
  options: GraphSyncExecutorOptions,
): SyncExecutor {
  const now = options.now ?? (() => new Date());
  const newScanId = options.newScanId ?? (() => randomUUID());
  const createConnector =
    options.createConnector ??
    ((accessToken: GraphAccessTokenSource) =>
      createGraphMailConnector({ accessToken }));
  const { store } = options;

  async function runScan(request: SyncScanRequest): Promise<SyncScanOutcome> {
    // 掃除が済むまで外部の読み取りを始めない（ADR 0053。Google 用実行器と同じ）。
    let release: (() => void) | null = null;
    if (options.retention !== undefined) {
      for (let attempt = 0; release === null && attempt < 3; attempt += 1) {
        await options.retention.ready();
        const gate = options.retention.gate();
        if (!gate.search || !gate.auto_use)
          return unavailable('retention_gate_closed');
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
    if (connection.provider !== 'microsoft')
      return unavailable('provider_unsupported');
    if (connection.status !== 'active')
      return unavailable('connection_not_active');
    if (connection.targets_state !== 'complete')
      return unavailable('targets_incomplete');
    // Graph の読み取り connector はメールだけを持つ（予定の読み取りは B09 の範囲外）。
    if (request.resource !== 'mail') return unavailable('resource_unsupported');
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
        kind: active.kind,
        scopeRevision: active.scope_revision,
        windowStart: active.window_start,
        windowEnd: active.window_end,
        base: active.kind === 'full' ? '' : (active.base_watermark ?? ''),
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
      const window = mailWindow(fetchScope, startedAt);
      if (window === null) return unavailable('window_invalid');
      kind = wantedKind;
      // 増分の起点（前回成功時刻）が無ければ全量から始める（初回・起点が無いとき）。
      const base = kind === 'full' ? '' : (scope.committed_watermark ?? '');
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
      fetchScope,
      windowStart,
      windowEnd,
    };

    try {
      let staged: StageOutcome;
      if (kind === 'incremental') {
        const base = batch.base_watermark ?? scope.committed_watermark;
        if (base === null) return failed('watermark_missing', scanId);
        staged = await stageMail(
          ctx,
          scanId,
          {
            kind: 'incremental',
            modifiedSince: new Date(
              Date.parse(base) - FIVE_MINUTES_MS,
            ).toISOString(),
          },
          resumeCursor,
        );
      } else {
        staged = await stageMail(ctx, scanId, { kind: 'full' }, resumeCursor);
      }
      if (!staged.ok) return failed(staged.reason, scanId);
    } catch {
      // connector が結果型で返さない例外（引数の誤り・ページ数の上限）は、内容を載せず失敗にする。
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
      provider: 'microsoft',
      account_id: request.account_id,
      // Graph は provider cursor を持たない（delta を使わない）。起点は watermark だけが進む。
      provider_cursor: null,
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
