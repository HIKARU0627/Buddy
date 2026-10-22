// 127.0.0.1 の模擬 provider（HTTP）。Core とは別に、状態と受信記録を自分のディレクトリへ保持する。
// 要求の回数（受信記録の件数）と状態の変更の回数は別に数える。重複した要求も消さず、冪等にもしない。
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { acquireDirLock, type DirLock } from './dir-lock.js';
import { FaultInjector, type FaultContext } from '../fault-injector.js';
import {
  SYNTHETIC_CLOCK,
  WRITE_SCOPES,
  seedState,
  type AppliedChange,
  type MockDraft,
  type MockReceipt,
  type ProviderState,
} from './data.js';

const STATE_FILE = 'provider.json';
const MAX_BODY_BYTES = 64 * 1024;

export interface MockProviderOptions {
  /** 状態と受信記録を置くディレクトリ。同じディレクトリで作り直すと、前の状態と記録を引き継ぐ。 */
  readonly dir: string;
  readonly now?: () => string;
  readonly injector?: FaultInjector;
  readonly port?: number;
}

/** 試験装置だけが使う、真の結果を見る・状態を直接動かすための窓口。Core のアダプターへは渡さない。 */
export interface MockProviderTruth {
  /** 要求の回数（書込みの経路に届いた件数。重複・拒否・不正も含む）。 */
  requestCount(): number;
  /** 状態の変更の回数（実際に適用した件数）。 */
  stateChangeCount(): number;
  receipts(): readonly MockReceipt[];
  snapshot(): ProviderState;
  /** 保留中（response_timeout_then_late_apply）の件数。 */
  heldCount(): number;
  /** 保留中の要求を、受信順に遅れて適用する。適用した件数を返す。 */
  releaseLateApplies(): number;
  /** 試験の状況づくり。変更の回数には数えない。 */
  setSourceRevision(remoteId: string, revision: string): void;
  setPermission(permission: {
    readonly permission_revision?: string;
    readonly scopes?: readonly string[];
  }): void;
}

export interface MockProvider {
  readonly url: string;
  readonly truth: MockProviderTruth;
  close(): Promise<void>;
}

interface Plan {
  /** 適用前に決まる結果（拒否・不正）。 */
  readonly reject?: { readonly status: number; readonly body: unknown };
  readonly apply?: () => {
    readonly status: number;
    readonly body: unknown;
    readonly change: AppliedChange;
  };
}

interface Held {
  readonly receipt: MockReceipt;
  readonly apply: NonNullable<Plan['apply']>;
  readonly res: ServerResponse;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.length > 0)
  );
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

export async function createMockProvider(
  options: MockProviderOptions,
): Promise<MockProvider> {
  mkdirSync(options.dir, { recursive: true });
  const file = join(options.dir, STATE_FILE);
  const lock = await acquireDirLock(options.dir);
  try {
    return await startProvider(options, file, lock);
  } catch (error) {
    await lock.release();
    throw error;
  }
}

async function startProvider(
  options: MockProviderOptions,
  file: string,
  lock: DirLock,
): Promise<MockProvider> {
  const now = options.now ?? (() => SYNTHETIC_CLOCK);
  const injector = options.injector ?? new FaultInjector();
  const state: ProviderState = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as ProviderState)
    : seedState();
  if (state.schema !== 'buddy.mock-provider.v1')
    throw new Error('模擬 provider の状態ファイルの形式が違います。');

  // 状態と受信記録は 1 つのファイルへまとめて書き、途中で止まっても食い違わないようにする。
  function persist(): void {
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state)}\n`, 'utf8');
    renameSync(temp, file);
  }
  if (!existsSync(file)) persist();

  const held: Held[] = [];

  function send(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      connection: 'close',
    });
    res.end(text);
  }

  function hasScope(scope: string): boolean {
    return state.permission.scopes.includes(scope);
  }

  function labelsPlan(remoteId: string, body: Record<string, unknown>): Plan {
    const mail = state.mails[remoteId];
    if (mail === undefined)
      return { reject: { status: 404, body: { error: 'not_found' } } };
    if (!hasScope(WRITE_SCOPES.labels))
      return { reject: { status: 403, body: { error: 'permission_denied' } } };
    const add = body['add'];
    const remove = body['remove'];
    if (!isStringArray(add) || !isStringArray(remove))
      return { reject: { status: 400, body: { error: 'invalid_request' } } };
    return {
      apply: () => {
        // 既にあるラベルへの追加でも、要求は適用として数える（重複を隠さない）。
        for (const label of add)
          if (!mail.labels.includes(label)) mail.labels.push(label);
        mail.labels = mail.labels.filter((label) => !remove.includes(label));
        return {
          status: 200,
          body: {
            remote_id: mail.remote_id,
            source_revision: mail.source_revision,
            labels: [...mail.labels],
          },
          change: {
            kind: 'mail.labels.change',
            remote_id: mail.remote_id,
            add: [...add],
            remove: [...remove],
            labels_after: [...mail.labels],
          },
        };
      },
    };
  }

  function draftCreatePlan(
    ids: { operation_id: string; attempt_id: string; step_id: string | null },
    body: Record<string, unknown>,
  ): Plan {
    if (!hasScope(WRITE_SCOPES.draftCreate))
      return { reject: { status: 403, body: { error: 'permission_denied' } } };
    const to = body['to'];
    const subject = body['subject'];
    const text = body['body'];
    if (
      !isStringArray(to) ||
      typeof subject !== 'string' ||
      typeof text !== 'string'
    )
      return { reject: { status: 400, body: { error: 'invalid_request' } } };
    return {
      apply: () => {
        const draftId = `draft-${String(state.next_draft).padStart(3, '0')}`;
        state.next_draft += 1;
        const draft: MockDraft = {
          draft_id: draftId,
          operation_id: ids.operation_id,
          attempt_id: ids.attempt_id,
          step_id: ids.step_id,
          to: [...to],
          subject,
          body: text,
          status: 'draft',
          send_count: 0,
        };
        state.drafts[draftId] = draft;
        return {
          status: 201,
          body: { draft_id: draftId, status: 'draft' },
          change: { kind: 'mail.draft.create', draft_id: draftId },
        };
      },
    };
  }

  function draftSendPlan(draftId: string): Plan {
    const draft = state.drafts[draftId];
    if (draft === undefined)
      return { reject: { status: 404, body: { error: 'not_found' } } };
    if (!hasScope(WRITE_SCOPES.draftSend))
      return { reject: { status: 403, body: { error: 'permission_denied' } } };
    return {
      apply: () => {
        // 送信済みの下書きへの重複した送信要求も、適用として数える（サービス側で隠さない）。
        draft.status = 'sent';
        draft.send_count += 1;
        return {
          status: 200,
          body: { draft_id: draftId, status: 'sent' },
          change: { kind: 'mail.draft.send', draft_id: draftId },
        };
      },
    };
  }

  async function handleWrite(
    req: IncomingMessage,
    res: ServerResponse,
    route: string,
    makePlan: (
      ids: { operation_id: string; attempt_id: string; step_id: string | null },
      body: Record<string, unknown>,
    ) => Plan,
  ): Promise<void> {
    const text = await readBody(req);
    let parsed: Record<string, unknown> | null = null;
    if (text !== null) {
      try {
        parsed = asObject(JSON.parse(text));
      } catch {
        parsed = null;
      }
    }
    const field = (name: string): string | null => {
      const value = parsed?.[name];
      return typeof value === 'string' && value.length > 0 ? value : null;
    };
    // 受信記録は、不正な要求も含めて、届いた順に残す。
    const receipt: MockReceipt = {
      receive_order: state.next_receive_order,
      received_at: now(),
      route,
      operation_id: field('operation_id'),
      attempt_id: field('attempt_id'),
      step_id: field('step_id'),
      applied_change: null,
      responded: false,
      response_status: null,
    };
    state.next_receive_order += 1;
    state.receipts.push(receipt);
    persist();

    const respond = (status: number, body: unknown): void => {
      receipt.responded = true;
      receipt.response_status = status;
      persist();
      send(res, status, body);
    };

    if (
      parsed === null ||
      receipt.operation_id === null ||
      receipt.attempt_id === null
    ) {
      respond(400, { error: 'invalid_request' });
      return;
    }
    const plan = makePlan(
      {
        operation_id: receipt.operation_id,
        attempt_id: receipt.attempt_id,
        step_id: receipt.step_id,
      },
      parsed,
    );
    if (plan.reject !== undefined) {
      respond(plan.reject.status, plan.reject.body);
      return;
    }
    const apply = plan.apply;
    if (apply === undefined) throw new Error('plan に apply がありません。');

    const context: FaultContext = {
      operation_id: receipt.operation_id,
      step_id: receipt.step_id,
    };
    if (
      injector.take('response_timeout_then_late_apply', context)?.mode ===
      'hold_then_apply'
    ) {
      // 応答も適用もせずに保留する。後で releaseLateApplies() が適用する。
      held.push({ receipt, apply, res });
      return;
    }
    const applied = apply();
    receipt.applied_change = applied.change;
    state.state_changes += 1;
    if (
      injector.take('after_external_apply_before_response', context)?.mode ===
      'drop_response'
    ) {
      // 適用して記録した後、応答を返さずに接続を切る。
      persist();
      res.socket?.destroy();
      return;
    }
    respond(applied.status, applied.body);
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter((part) => part.length > 0);
    const method = req.method ?? 'GET';
    const run = (task: Promise<void>): void => {
      task.catch(() => {
        if (!res.headersSent) send(res, 500, { error: 'internal_error' });
        else res.socket?.destroy();
      });
    };
    if (method === 'GET') {
      // 読み取りは状態を変えず、要求の回数にも数えない。
      if (
        parts.length === 4 &&
        parts[0] === 'v1' &&
        parts[1] === 'accounts' &&
        parts[3] === 'permission'
      ) {
        if (parts[2] !== state.permission.account_id)
          return send(res, 404, { error: 'not_found' });
        return send(res, 200, state.permission);
      }
      // 排他の持ち主の確認用（pid の再利用と見分ける）。
      if (parts.join('/') === 'v1/instance')
        return send(res, 200, { token: lock.token });
      if (parts.join('/') === 'v1/calendar/events')
        return send(res, 200, { events: state.events });
      if (
        parts.length === 4 &&
        parts[1] === 'mail' &&
        parts[2] === 'messages'
      ) {
        const mail = state.mails[parts[3] ?? ''];
        return mail === undefined
          ? send(res, 404, { error: 'not_found' })
          : send(res, 200, mail);
      }
      if (parts.join('/') === 'v1/mail/drafts') {
        const operationId = url.searchParams.get('operation_id');
        const stepId = url.searchParams.get('step_id');
        const drafts = Object.values(state.drafts).filter(
          (draft) =>
            (operationId === null || draft.operation_id === operationId) &&
            (stepId === null || draft.step_id === stepId),
        );
        return send(res, 200, { drafts });
      }
      return send(res, 404, { error: 'not_found' });
    }
    if (method === 'POST' && parts[0] === 'v1' && parts[1] === 'mail') {
      if (
        parts.length === 5 &&
        parts[2] === 'messages' &&
        parts[4] === 'labels'
      )
        return run(
          handleWrite(req, res, 'mail.labels.change', (_ids, body) =>
            labelsPlan(parts[3] ?? '', body),
          ),
        );
      if (parts.length === 3 && parts[2] === 'drafts')
        return run(handleWrite(req, res, 'mail.draft.create', draftCreatePlan));
      if (parts.length === 5 && parts[2] === 'drafts' && parts[4] === 'send')
        return run(
          handleWrite(req, res, 'mail.draft.send', () =>
            draftSendPlan(parts[3] ?? ''),
          ),
        );
    }
    return send(res, 404, { error: 'not_found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    await lock.setPort(address.port);
  } catch (error) {
    server.close();
    throw error;
  }

  const truth: MockProviderTruth = {
    requestCount: () => state.receipts.length,
    stateChangeCount: () => state.state_changes,
    receipts: () => structuredClone(state.receipts),
    snapshot: () => structuredClone(state),
    heldCount: () => held.length,
    releaseLateApplies() {
      const entries = held.splice(0, held.length);
      for (const entry of entries) {
        const applied = entry.apply();
        entry.receipt.applied_change = applied.change;
        state.state_changes += 1;
        // 遅れた適用では応答を返さない（呼び出し側は待ちを打ち切った後で、接続の状態に依存させない）。
        persist();
        entry.res.socket?.destroy();
      }
      return entries.length;
    },
    setSourceRevision(remoteId, revision) {
      const mail = state.mails[remoteId];
      if (mail === undefined) throw new Error(`知らないメール: ${remoteId}`);
      mail.source_revision = revision;
      persist();
    },
    setPermission(permission) {
      if (permission.permission_revision !== undefined)
        state.permission.permission_revision = permission.permission_revision;
      if (permission.scopes !== undefined)
        state.permission.scopes = [...permission.scopes];
      persist();
    },
  };

  return {
    url: `http://127.0.0.1:${address.port}`,
    truth,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      // 閉じた後に排他を手放す（次の provider が同じディレクトリで始められる）。
      await lock.release();
    },
  };
}
