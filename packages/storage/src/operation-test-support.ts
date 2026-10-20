// 操作の保存と DB worker の試験で使う合成の命令と DB（試験専用。index.ts から export しない）。
// 内容 hash は契約 fixture（h01.json・content-hash-cases.json）に手で書いた値を使い、実装で計算しない。
// 暗号文は乱数の合成値で、実際の暗号化（B02-02）ではない。

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWriteConnection } from './connection.js';
import type { SqliteDatabase } from './connection.js';
import { applyMigrations, initStoreGeneration } from './migrations.js';
import type {
  ApproveOperationCommand,
  CancelOperationCommand,
  CreateOperationCommand,
  DeviceRequestRef,
  DispatchIntentCommand,
  PrepareOperationCommand,
  RecordResultCommand,
  RecoverAfterRestartCommand,
  ResultState,
  SealedBlobInput,
} from './operation-commands.js';
import type { StoreContext } from './operation-store.js';

function readJson(path: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'),
  );
}

const h01 = readJson('packages/contracts/fixtures/h01.json') as {
  expected_sha256: string;
};
const hashCases = readJson(
  'packages/contracts/fixtures/content-hash-cases.json',
) as { cases: { id: string; expected_sha256: string }[] };

// H01 の確定 intent の hash と、許可版だけを変えた intent の hash（別の値）。
export const CONTENT_HASH = h01.expected_sha256;
export const OTHER_CONTENT_HASH =
  hashCases.cases.find((entry) => entry.id === 'permission-revision-2')
    ?.expected_sha256 ?? '';

export interface OperationTransitionCase {
  readonly id: string;
  readonly path: readonly string[];
  readonly approvals: number;
  readonly external_writes: number;
  readonly duplicate_approve?: string;
  readonly cancel_response?: string;
}

export const TRANSITION_CASES = (
  readJson('packages/contracts/fixtures/operation-transitions.json') as {
    cases: OperationTransitionCase[];
  }
).cases;

export const STORE_GENERATION = '00000000-0000-4000-8000-0000000000aa';
export const CONNECTION_ID = 'c-1';
export const RECEIPT_TTL = 604_800_000;

// 一時ディレクトリを作り、終わったら消す。接続を閉じ忘れると Windows では消せずに失敗する。
export async function withTempDir<T>(
  run: (dir: string) => Promise<T> | T,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-store-'));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function databasePath(dir: string): string {
  return join(dir, 'data', 'buddy.sqlite');
}

// 端末二つと書込み可の接続（許可の版 1）を置く。
export const SEED = [
  "INSERT INTO devices VALUES ('dev-1', '合成の端末1', 'windows', 0, X'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1000, NULL, NULL)",
  "INSERT INTO devices VALUES ('dev-2', '合成の端末2', 'macos', 0, X'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1000, NULL, NULL)",
  "INSERT INTO connections VALUES ('c-1', 'google', NULL, 'keystore:c-1', 'active', 'read_write', '[]', '{}', 1, 1)",
];

// 書込み接続を開き、0001 を適用して合成のデータを置く。
export function openSeededDatabase(path: string): SqliteDatabase {
  const db = openWriteConnection(path, { platform: 'macos' });
  try {
    applyMigrations(db);
    initStoreGeneration(db, STORE_GENERATION);
    for (const sql of SEED) db.exec(sql);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export function storeContext(now = 1_000_000): StoreContext {
  return { now, platform: 'macos', storeGeneration: STORE_GENERATION };
}

export function sealedIntent(): SealedBlobInput {
  return {
    blob_id: randomUUID(),
    format_version: 1,
    key_id: 'k-test',
    nonce: randomBytes(12),
    ciphertext: randomBytes(24),
    tag: randomBytes(16),
  };
}

interface BaseOptions {
  readonly command_id?: string;
  readonly request?: DeviceRequestRef | null;
  readonly request_revision?: string | null;
  readonly permission_revision?: string;
  readonly forgetting_generation?: string;
  readonly connection_id?: string | null;
}

function base(
  operationId: string,
  expected: string,
  options: BaseOptions,
): {
  command_id: string;
  operation_id: string;
  expected_state_revision: string;
  request_revision: string | null;
  permission_revision: string;
  forgetting_generation: string;
  connection_id: string | null;
  request: DeviceRequestRef | null;
} {
  return {
    command_id: options.command_id ?? randomUUID(),
    operation_id: operationId,
    expected_state_revision: expected,
    request_revision: options.request_revision ?? null,
    permission_revision: options.permission_revision ?? '1',
    forgetting_generation: options.forgetting_generation ?? '0',
    connection_id:
      options.connection_id === undefined
        ? CONNECTION_ID
        : options.connection_id,
    request: options.request ?? null,
  };
}

export function createCommand(
  operationId: string,
  options: BaseOptions & {
    readonly auto?: boolean;
    readonly effect_route?: 'local_command' | 'remote_mutation';
    readonly workflow_id?: string | null;
    readonly intent?: SealedBlobInput;
  } = {},
): CreateOperationCommand {
  return {
    ...base(operationId, '0', options),
    kind: 'operation.create',
    workflow_id: options.workflow_id ?? null,
    operation_kind: 'mail.labels.change',
    effect_route: options.effect_route ?? 'remote_mutation',
    content_hash: CONTENT_HASH,
    intent: options.intent ?? sealedIntent(),
    auto_approval:
      options.auto === true
        ? {
            approval_id: randomUUID(),
            policy_version: '3',
            current_policy_version: '3',
          }
        : null,
  };
}

export function approveCommand(
  operationId: string,
  expected: string,
  options: BaseOptions & {
    readonly device_id?: string;
    readonly content_hash?: string;
    readonly content_version?: string;
  } = {},
): ApproveOperationCommand {
  return {
    ...base(operationId, expected, options),
    kind: 'operation.approve',
    approval_id: randomUUID(),
    route: 'screen',
    content_version: options.content_version ?? '1',
    content_hash: options.content_hash ?? CONTENT_HASH,
    device_id: options.device_id ?? 'dev-1',
    preview_id: 'pv-1',
    preview_valid: true,
    policy_version: null,
    current_policy_version: '3',
  };
}

export function prepareCommand(
  operationId: string,
  expected: string,
  options: BaseOptions & { readonly attempt_id?: string } = {},
): PrepareOperationCommand {
  return {
    ...base(operationId, expected, options),
    kind: 'operation.prepare',
    attempt_id: options.attempt_id ?? randomUUID(),
  };
}

export function dispatchCommand(
  operationId: string,
  expected: string,
  attemptId: string,
  options: BaseOptions & { readonly reservation_id?: string | null } = {},
): DispatchIntentCommand {
  return {
    ...base(operationId, expected, options),
    kind: 'operation.dispatch_intent',
    attempt_id: attemptId,
    reservation_id: options.reservation_id ?? null,
  };
}

export function resultCommand(
  operationId: string,
  expected: string,
  attemptId: string,
  to: ResultState,
  options: BaseOptions & { readonly external_id?: string | null } = {},
): RecordResultCommand {
  return {
    ...base(operationId, expected, options),
    kind: 'operation.record_result',
    attempt_id: attemptId,
    to,
    external_id: options.external_id ?? null,
  };
}

export function cancelCommand(
  operationId: string,
  expected: string,
  options: BaseOptions = {},
): CancelOperationCommand {
  return { ...base(operationId, expected, options), kind: 'operation.cancel' };
}

// 起動時の回復（ADR 0019）。Core と同じく、依頼・許可・忘却の版は照合しない値を入れる。
export function recoverCommand(
  operationId: string,
  expected: string,
  attemptId: string,
  options: BaseOptions = {},
): RecoverAfterRestartCommand {
  return {
    ...base(operationId, expected, { connection_id: null, ...options }),
    kind: 'operation.recover_after_restart',
    attempt_id: attemptId,
  };
}

export interface ReceiptRowView {
  readonly command_scope_id: string;
  readonly request_id: string;
  readonly command_id: string;
  readonly target_id: string;
  readonly status: string;
  readonly committed_state_revision: number | null;
  readonly created_at: number;
  readonly delete_at: number;
}

export function receiptRows(db: SqliteDatabase): ReceiptRowView[] {
  return db
    .prepare(
      'SELECT command_scope_id, request_id, command_id, target_id, status, committed_state_revision, created_at, delete_at FROM command_receipts ORDER BY created_at, rowid',
    )
    .all() as ReceiptRowView[];
}

export interface EventRowView {
  readonly store_generation: string;
  readonly sequence: number;
  readonly target_id: string;
  readonly state_revision: number;
  readonly event_type: string;
  readonly occurred_at: number;
  readonly delete_at: number;
}

export function eventRows(db: SqliteDatabase): EventRowView[] {
  return db
    .prepare(
      'SELECT store_generation, sequence, target_id, state_revision, event_type, occurred_at, delete_at FROM event_outbox ORDER BY sequence',
    )
    .all() as EventRowView[];
}

export function operationState(
  db: SqliteDatabase,
  operationId: string,
): { state: string; state_revision: number } | undefined {
  return db
    .prepare(
      'SELECT state, state_revision FROM operations WHERE operation_id = ?',
    )
    .get(operationId) as { state: string; state_revision: number } | undefined;
}

export function effectiveApprovals(
  db: SqliteDatabase,
  operationId: string,
): number {
  return (
    db
      .prepare(
        "SELECT count(*) AS n FROM approvals WHERE operation_id = ? AND status IN ('valid', 'consumed')",
      )
      .get(operationId) as { n: number }
  ).n;
}
