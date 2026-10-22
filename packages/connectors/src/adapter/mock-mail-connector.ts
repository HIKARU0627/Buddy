// Core 側の模擬 provider のアダプター。
// 読み取り（対象・許可・予定・下書きの lookup）は状態を変えない。書込みは 1 回だけ送り、自動で再送しない。
// 結果が分からない（応答なし・5xx・形の違う応答）ときは unknown を返し、再送するかは呼び出し側（Core の状態機械）が決める。
// 真の結果を見る API（@buddy/connectors/testing の truth）は、このファイルから読み込まない。
import { callOnce, type HttpOutcome } from './http.js';
import {
  MOCK_CONNECTOR_CAPABILITY,
  type MinimalConnectorCapability,
} from './capability.js';

const DEFAULT_TIMEOUT_MS = 5_000;

export interface MailTarget {
  readonly remote_id: string;
  readonly source_revision: string;
  readonly mailbox: string;
  readonly labels: readonly string[];
  // 承認画面で対象のメールを見分けるための表示用（読めなければ null）。
  readonly subject: string | null;
  readonly sender: string | null;
  readonly received_at: string | null;
}

export interface PermissionState {
  readonly account_id: string;
  // 口座の表示名（承認画面で口座を見分けるための表示用。読めなければ null）。
  readonly account_label: string | null;
  readonly permission_revision: string;
  readonly scopes: readonly string[];
}

export interface CalendarEvent {
  readonly event_id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
}

export interface RemoteDraft {
  readonly draft_id: string;
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly step_id: string | null;
  readonly status: 'draft' | 'sent';
}

/** 目印で探した下書き（結果不明の照合に使う。読み取りだけ）。 */
export interface MarkedDraft {
  readonly draft_id: string;
  readonly marker: string;
  readonly in_reply_to: string | null;
  readonly status: 'draft' | 'sent';
}

/** 書込みの識別。受信記録に残り、結果が分からないときの正確な照合の手がかりになる。 */
export interface WriteIdentity {
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly step_id?: string;
}

export type WriteOutcome<T> =
  /** 相手が適用して応答した。 */
  | { readonly kind: 'applied'; readonly status: number; readonly value: T }
  /** 相手が適用せずに拒否した（4xx）。 */
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly code: string;
    }
  /** 接続できず、要求は送られていない。 */
  | { readonly kind: 'not_sent' }
  /** 適用されたか分からない。自動で再送しない。 */
  | {
      readonly kind: 'unknown';
      readonly reason:
        'timeout' | 'connection_lost' | 'server_error' | 'invalid_response';
    };

export interface MockMailConnectorOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  /** 試験用: 中止されたら、時間切れとして扱う（時計に依存せず、時間切れを起こす地点を試験が決める）。 */
  readonly timeoutSignal?: AbortSignal;
}

export interface MockMailConnector {
  readonly capability: MinimalConnectorCapability;
  readPermission(accountId: string): Promise<PermissionState | null>;
  readTarget(remoteId: string): Promise<MailTarget | null>;
  listEvents(): Promise<readonly CalendarEvent[]>;
  /** 正確な対象の lookup。operation_id（と step_id）で作られた下書きを探す。読み取りだけ。 */
  lookupDrafts(query: {
    readonly operation_id: string;
    readonly step_id?: string;
  }): Promise<readonly RemoteDraft[]>;
  /** 操作の目印で下書きを探す（照合の lookup、by_operation_marker）。読み取りだけ。 */
  findDraftsByMarker(marker: string): Promise<readonly MarkedDraft[]>;
  changeLabels(
    identity: WriteIdentity,
    change: {
      readonly remote_id: string;
      readonly add: readonly string[];
      readonly remove: readonly string[];
    },
  ): Promise<WriteOutcome<MailTarget>>;
  createDraft(
    identity: WriteIdentity,
    draft: {
      readonly to: readonly string[];
      readonly subject: string;
      readonly body: string;
      // 返信の下書き（B04-07）: CC・返信元・操作の目印。省略すると送らない。
      readonly cc?: readonly string[];
      readonly in_reply_to?: string;
      readonly marker?: string;
    },
  ): Promise<WriteOutcome<{ readonly draft_id: string }>>;
  sendDraft(
    identity: WriteIdentity,
    draftId: string,
  ): Promise<WriteOutcome<{ readonly draft_id: string }>>;
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : null;
}

function parseTarget(value: unknown): MailTarget | null {
  const o = obj(value);
  const remote_id = str(o?.['remote_id']);
  const source_revision = str(o?.['source_revision']);
  const labels = strings(o?.['labels']);
  if (remote_id === null || source_revision === null || labels === null)
    return null;
  return {
    remote_id,
    source_revision,
    // 一部の応答（書込みの結果）は mailbox を持たない。
    mailbox: str(o?.['mailbox']) ?? '',
    labels,
    subject: str(o?.['subject']),
    sender: str(o?.['from']),
    received_at: str(o?.['received_at']),
  };
}

export function createMockMailConnector(
  options: MockMailConnectorOptions,
): MockMailConnector {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const call = (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<HttpOutcome> =>
    callOnce({
      baseUrl: options.baseUrl,
      method,
      path,
      timeoutMs,
      ...(options.timeoutSignal === undefined
        ? {}
        : { signal: options.timeoutSignal }),
      ...(body === undefined ? {} : { body }),
    });

  /** 読み取り。200 → 値、404 → null、それ以外は例外（読み取りは状態を変えないので呼び出し側が取り直せる）。 */
  async function read<T>(
    path: string,
    parse: (body: unknown) => T | null,
  ): Promise<T | null> {
    const outcome = await call('GET', path);
    if (outcome.kind !== 'response')
      throw new Error(`provider の読み取りに失敗しました: ${outcome.kind}`);
    if (outcome.status === 404) return null;
    const value = outcome.status === 200 ? parse(outcome.body) : null;
    if (value === null)
      throw new Error(
        `provider の応答が不正です（status ${String(outcome.status)}）。`,
      );
    return value;
  }

  async function write<T>(
    path: string,
    body: Record<string, unknown>,
    parse: (body: unknown) => T | null,
  ): Promise<WriteOutcome<T>> {
    // 書込みは 1 回だけ送る。どの結果でも再送しない。
    const outcome = await call('POST', path, body);
    if (outcome.kind === 'not_sent') return { kind: 'not_sent' };
    if (outcome.kind === 'no_response')
      return { kind: 'unknown', reason: outcome.reason };
    if (outcome.status >= 500)
      return { kind: 'unknown', reason: 'server_error' };
    if (outcome.status >= 400)
      return {
        kind: 'rejected',
        status: outcome.status,
        code: str(obj(outcome.body)?.['error']) ?? 'unknown',
      };
    const value = parse(outcome.body);
    if (outcome.status < 200 || outcome.status >= 300 || value === null)
      return { kind: 'unknown', reason: 'invalid_response' };
    return { kind: 'applied', status: outcome.status, value };
  }

  const idBody = (identity: WriteIdentity): Record<string, unknown> => ({
    operation_id: identity.operation_id,
    attempt_id: identity.attempt_id,
    ...(identity.step_id === undefined ? {} : { step_id: identity.step_id }),
  });
  // 下書きの応答は工程ごとに検証する。作成は status 'draft'、送信は status 'sent' と要求した下書きの ID の一致が必須。
  const parseDraft =
    (status: 'draft' | 'sent', expectedId?: string) =>
    (body: unknown): { draft_id: string } | null => {
      const o = obj(body);
      const draft_id = str(o?.['draft_id']);
      if (draft_id === null || str(o?.['status']) !== status) return null;
      if (expectedId !== undefined && draft_id !== expectedId) return null;
      return { draft_id };
    };

  return {
    capability: MOCK_CONNECTOR_CAPABILITY,
    readPermission: (accountId) =>
      read(
        `/v1/accounts/${encodeURIComponent(accountId)}/permission`,
        (body) => {
          const o = obj(body);
          const account_id = str(o?.['account_id']);
          const permission_revision = str(o?.['permission_revision']);
          const scopes = strings(o?.['scopes']);
          return account_id === null ||
            permission_revision === null ||
            scopes === null
            ? null
            : {
                account_id,
                account_label: str(o?.['account_label']),
                permission_revision,
                scopes,
              };
        },
      ),
    readTarget: (remoteId) =>
      read(`/v1/mail/messages/${encodeURIComponent(remoteId)}`, parseTarget),
    async listEvents() {
      const events = await read('/v1/calendar/events', (body) => {
        const list = obj(body)?.['events'];
        if (!Array.isArray(list)) return null;
        const parsed: CalendarEvent[] = [];
        for (const item of list) {
          const o = obj(item);
          const event_id = str(o?.['event_id']);
          const title = str(o?.['title']);
          const start = str(o?.['start']);
          const end = str(o?.['end']);
          if (
            event_id === null ||
            title === null ||
            start === null ||
            end === null
          )
            return null;
          parsed.push({ event_id, title, start, end });
        }
        return parsed;
      });
      return events ?? [];
    },
    async lookupDrafts(query) {
      const params = new URLSearchParams({ operation_id: query.operation_id });
      if (query.step_id !== undefined) params.set('step_id', query.step_id);
      const drafts = await read(
        `/v1/mail/drafts?${params.toString()}`,
        (body) => {
          const list = obj(body)?.['drafts'];
          if (!Array.isArray(list)) return null;
          const parsed: RemoteDraft[] = [];
          for (const item of list) {
            const o = obj(item);
            const draft_id = str(o?.['draft_id']);
            const operation_id = str(o?.['operation_id']);
            const attempt_id = str(o?.['attempt_id']);
            const status = str(o?.['status']);
            if (
              draft_id === null ||
              operation_id === null ||
              attempt_id === null ||
              (status !== 'draft' && status !== 'sent')
            )
              return null;
            parsed.push({
              draft_id,
              operation_id,
              attempt_id,
              step_id: str(o?.['step_id']),
              status,
            });
          }
          return parsed;
        },
      );
      return drafts ?? [];
    },
    async findDraftsByMarker(marker) {
      const params = new URLSearchParams({ marker });
      const drafts = await read(
        `/v1/mail/drafts?${params.toString()}`,
        (body) => {
          const list = obj(body)?.['drafts'];
          if (!Array.isArray(list)) return null;
          const parsed: MarkedDraft[] = [];
          for (const item of list) {
            const o = obj(item);
            const draft_id = str(o?.['draft_id']);
            const found = str(o?.['marker']);
            const status = str(o?.['status']);
            // 探した目印と違う下書きが返れば、応答の形が違うものとして扱う（数え違えない）。
            if (
              draft_id === null ||
              found !== marker ||
              (status !== 'draft' && status !== 'sent')
            )
              return null;
            parsed.push({
              draft_id,
              marker: found,
              in_reply_to: str(o?.['in_reply_to']),
              status,
            });
          }
          return parsed;
        },
      );
      return drafts ?? [];
    },
    changeLabels: (identity, change) =>
      write(
        `/v1/mail/messages/${encodeURIComponent(change.remote_id)}/labels`,
        { ...idBody(identity), add: change.add, remove: change.remove },
        parseTarget,
      ),
    createDraft: (identity, draft) =>
      write(
        '/v1/mail/drafts',
        {
          ...idBody(identity),
          to: draft.to,
          subject: draft.subject,
          body: draft.body,
          ...(draft.cc === undefined ? {} : { cc: draft.cc }),
          ...(draft.in_reply_to === undefined
            ? {}
            : { in_reply_to: draft.in_reply_to }),
          ...(draft.marker === undefined ? {} : { marker: draft.marker }),
        },
        parseDraft('draft'),
      ),
    sendDraft: (identity, draftId) =>
      write(
        `/v1/mail/drafts/${encodeURIComponent(draftId)}/send`,
        idBody(identity),
        parseDraft('sent', draftId),
      ),
  };
}
