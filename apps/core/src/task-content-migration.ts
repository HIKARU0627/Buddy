// 起動時のデータ移行: 0010 までの用事の正本を、操作の確定 intent から用事自身の暗号文へ移す（ADR 0040・0051、
// マイグレーション 0011）。
//
// 用事の暗号文は追加認証データ（所有者の表・ID・版・用途。ADR 0017）が操作の暗号文と違うので、SQL では写せない。
// 用事ごとに次の順で行う。どこで止まっても、次の起動で同じ順から続ければ整合する。
// 1. 確定 intent を復号し（保存した content_hash と照合する）、用事の内容（題名・期限・本文）だけを取り出す。
// 2. 用事を所有者にして暗号化し、まだ結び付けずに書く（task.stage_content）。
// 3. 書いた暗号文を DB から読み戻して復号し、1 の内容と一致することを確かめる。
// 4. 一致したら用事に結び付ける（task.link_content）。合わなければ書いた暗号文を消し（task.discard_staged）、この用事は
//    移さないまま残す（次の起動でやり直す）。
// 移していない用事がある操作だけが J5 の本文の削除と 90 日の削除から残り、ほかの操作の削除は進む（0011 の trigger が
// 操作ごとの最後の保証）。移せない用事があっても Core の起動は止めない（用事と本文は残るので、失うものはない）。

import {
  openOperationIntent,
  openTaskContent,
  sameTaskContent,
  sealTaskContent,
  taskContentFromIntent,
} from '@buddy/storage';
import type {
  DataKeyMaterial,
  DbWorkerClient,
  RetentionOp,
  RetentionOpKind,
  RetentionOpOutcome,
  TaskContent,
  TaskMigrationItem,
  TaskStagedBlob,
} from '@buddy/storage';

export interface TaskMigrationStore {
  retention<K extends RetentionOpKind>(
    op: Extract<RetentionOp, { kind: K }>,
  ): Promise<RetentionOpOutcome<K>>;
}

export interface TaskMigrationReport {
  // 今回の起動で移した用事の数。
  readonly migrated: number;
  // 移せなかった用事（理由はコードだけ）。
  readonly failed: readonly {
    readonly task_id: string;
    readonly reason: string;
  }[];
  // 移行の後も暗号文を持たない用事の数（その用事の操作だけが J5 の削除から残る）。
  readonly pending: number;
}

export class TaskMigrationError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`用事の暗号文の移行を続けられません（${reason}）。`);
    this.name = 'TaskMigrationError';
    this.reason = reason;
  }
}

const BATCH = 50;

function envelope(blob: TaskStagedBlob) {
  return {
    formatVersion: blob.formatVersion,
    keyId: blob.keyId,
    nonce: blob.nonce,
    ciphertext: blob.ciphertext,
    tag: blob.tag,
  };
}

// 確定 intent から用事の内容を取り出す。取り出せなければ理由を返す。
function intentContent(
  key: DataKeyMaterial,
  item: TaskMigrationItem,
): TaskContent | string {
  if (item.intent === null || item.content_hash === null)
    return 'intent_missing';
  const opened = openOperationIntent(
    key,
    { operationId: item.operation_id, contentVersion: item.content_version },
    item.intent,
    item.content_hash,
  );
  if (!opened.ok) return opened.reason;
  let parsed: unknown;
  try {
    parsed = JSON.parse(opened.canonical);
  } catch {
    return 'intent_not_canonical';
  }
  return taskContentFromIntent(parsed) ?? 'task_content_invalid';
}

// 書き込み済みの暗号文（読み戻した値）が、取り出した内容と一致するか。
function stagedMatches(
  key: DataKeyMaterial,
  taskId: string,
  staged: TaskStagedBlob,
  content: TaskContent,
): boolean {
  const opened = openTaskContent(key, taskId, envelope(staged));
  return opened.ok && sameTaskContent(opened.content, content);
}

async function checked<K extends RetentionOpKind>(
  outcome: Promise<RetentionOpOutcome<K>>,
): Promise<RetentionOpOutcome<K>> {
  const result = await outcome;
  // 成否不明（書いたか分からない）・worker が使えないときは、続けずに起動の失敗として返す。
  if (!result.ok && result.outcome === 'unknown')
    throw new TaskMigrationError(result.reasons[0] ?? 'commit_failed');
  if (
    !result.ok &&
    result.reasons.some((reason) =>
      ['worker_closed', 'worker_unavailable', 'worker_halted'].includes(reason),
    )
  )
    throw new TaskMigrationError(result.reasons[0] ?? 'worker_unavailable');
  return result;
}

async function readStaged(
  store: TaskMigrationStore,
  taskId: string,
  after: string | null,
): Promise<TaskStagedBlob | null> {
  // 用事 1 件を読み直す（task_id の直前を after にして 1 件だけ読む）。
  const result = await checked(
    store.retention({ kind: 'task.migration_next', limit: 1, after }),
  );
  if (!result.ok) return null;
  const item = result.value.items[0];
  return item?.task_id === taskId ? item.staged : null;
}

async function migrateOne(
  store: TaskMigrationStore,
  key: DataKeyMaterial,
  item: TaskMigrationItem,
  previous: string | null,
  now: number,
): Promise<string | null> {
  const content = intentContent(key, item);
  if (typeof content === 'string') return content;
  let staged = item.staged;
  // 前回の起動で書いて結び付ける前に止まった暗号文。合わなければ消して書き直す。
  if (staged !== null && !stagedMatches(key, item.task_id, staged, content)) {
    const discarded = await checked(
      store.retention({
        kind: 'task.discard_staged',
        task_id: item.task_id,
        blob_id: staged.blob_id,
      }),
    );
    if (!discarded.ok) return discarded.reasons[0] ?? 'discard_failed';
    staged = null;
  }
  if (staged === null) {
    const sealed = sealTaskContent(key, item.task_id, content);
    if (!sealed.ok) return sealed.reason;
    const written = await checked(
      store.retention({
        kind: 'task.stage_content',
        task_id: item.task_id,
        content: sealed.content,
        now,
      }),
    );
    if (!written.ok) return written.reasons[0] ?? 'stage_failed';
    // 読み戻して復号し、取り出した内容と一致することを確かめる。
    staged = await readStaged(store, item.task_id, previous);
    if (staged === null || staged.blob_id !== sealed.content.blob_id)
      return 'readback_missing';
    if (!stagedMatches(key, item.task_id, staged, content)) {
      await checked(
        store.retention({
          kind: 'task.discard_staged',
          task_id: item.task_id,
          blob_id: staged.blob_id,
        }),
      );
      return 'readback_mismatch';
    }
  }
  const linked = await checked(
    store.retention({
      kind: 'task.link_content',
      task_id: item.task_id,
      blob_id: staged.blob_id,
    }),
  );
  return linked.ok ? null : (linked.reasons[0] ?? 'link_failed');
}

/** 暗号文を持たない用事をすべて移す。移せなかった用事は理由と一緒に返し、残りは続ける。 */
export async function migrateTaskContents(
  store: TaskMigrationStore,
  key: DataKeyMaterial,
  now: () => number = Date.now,
): Promise<TaskMigrationReport> {
  let migrated = 0;
  const failed: { task_id: string; reason: string }[] = [];
  let after: string | null = null;
  for (;;) {
    const batch: RetentionOpOutcome<'task.migration_next'> = await checked(
      store.retention({ kind: 'task.migration_next', limit: BATCH, after }),
    );
    if (!batch.ok)
      throw new TaskMigrationError(batch.reasons[0] ?? 'migration_read_failed');
    const items: readonly TaskMigrationItem[] = batch.value.items;
    for (const item of items) {
      const reason = await migrateOne(store, key, item, after, now());
      if (reason === null) migrated += 1;
      else failed.push({ task_id: item.task_id, reason });
      // 移せた用事は一覧から外れ、移せなかった用事は残る。どちらも task_id の順で次へ進む。
      after = item.task_id;
    }
    if (items.length < BATCH) break;
  }
  const gate = await checked(store.retention({ kind: 'retention.gate' }));
  if (!gate.ok)
    throw new TaskMigrationError(gate.reasons[0] ?? 'gate_read_failed');
  return { migrated, failed, pending: gate.value.tasks_pending };
}

export type TaskMigrationClient = Pick<DbWorkerClient, 'retention'>;
