// 用事の正本の暗号文（設計 03 本人が確定保存したメモ・用事、ADR 0030・0040・0051、マイグレーション 0011）。
//
// 用事（tasks）は自分の暗号文（purpose = task_content、owner_table = tasks、owner_id = task_id、版 0）に
// 題名・期限・本文を持つ。操作の確定 intent（operation_versions の暗号文）は J5 のとおり完了から 7 日で消えるので、
// 用事の正本をそこに置かない。平文の形はこのファイルだけが決める（ワイヤ契約ではない。DB の中の暗号文の中身）。
// 暗号化・復号は Core main が行い、DB worker は暗号文だけを受け取る（ADR 0018）。

import { randomUUID } from 'node:crypto';
import type { SealedBlobInput } from './operation-commands.js';
import { openBlob, sealBlob } from './sealed-blob.js';
import type {
  DataKeyMaterial,
  OpenFailureReason,
  SealFailureReason,
  SealedBlobOwner,
  SealedEnvelope,
} from './sealed-blob.js';

/** 平文の形の版。項目を変えるときに上げる。 */
export const TASK_CONTENT_SCHEMA = 'buddy.task_content.v1';

/** 用事の内容（確定 intent の action の title・due・body と同じ意味）。 */
export interface TaskContent {
  readonly title: string;
  // 期限（DateOrDateTime の文字列）。なければ null。
  readonly due: string | null;
  readonly body: string | null;
}

export function taskContentOwner(taskId: string): SealedBlobOwner {
  return {
    ownerTable: 'tasks',
    ownerId: taskId,
    ownerVersion: 0,
    purpose: 'task_content',
  };
}

// 孤立したサロゲートを含まないか（UTF-8 へ往復して変わらないか）。ワイヤの TaskOperationIntent は JSON Schema の
// minLength だけで、Ajv 単体は孤立したサロゲートを通す。しかしワイヤの入力は parseStrictJson（RFC 8785 の正規化の
// 前）が孤立したサロゲートを拒否し（scripts/contracts.test.mjs「raw JSON refuses lone surrogate value」）、
// 平文を UTF-8 の暗号文にすると Buffer が U+FFFD に置き換えて内容が変わる。だから task-content も同じ境界
// （孤立したサロゲートを拒否）に合わせる。
function wellFormed(value: string): boolean {
  return Buffer.from(value, 'utf8').toString('utf8') === value;
}

function isText(value: unknown, allowNull: boolean): boolean {
  if (value === null) return allowNull;
  return typeof value === 'string' && value.length > 0 && wellFormed(value);
}

/** 用事の内容の形（題名は 1 文字以上、期限・本文は 1 文字以上か null）。 */
export function isTaskContent(value: unknown): value is TaskContent {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'body,due,title') return false;
  const content = value as Record<string, unknown>;
  return (
    isText(content['title'], false) &&
    isText(content['due'], true) &&
    isText(content['body'], true)
  );
}

// 平文。項目の順を固定した JSON（同じ内容は同じバイト列になる）。
function taskContentJson(content: TaskContent): string {
  return JSON.stringify({
    schema: TASK_CONTENT_SCHEMA,
    title: content.title,
    due: content.due,
    body: content.body,
  });
}

/**
 * task.create の確定 intent から用事の内容を取り出す。action.kind が task.create でない・形が違えば null。
 * 確定 intent の形の検査（OperationIntent の Schema）は呼び出し側が済ませている前提で、ここでは必要な 3 項目だけを見る。
 */
export function taskContentFromIntent(intent: unknown): TaskContent | null {
  if (intent === null || typeof intent !== 'object') return null;
  const action = (intent as Record<string, unknown>)['action'];
  if (action === null || typeof action !== 'object') return null;
  const fields = action as Record<string, unknown>;
  if (fields['kind'] !== 'task.create') return null;
  const content = {
    title: fields['title'],
    due: fields['due'],
    body: fields['body'],
  };
  return isTaskContent(content) ? content : null;
}

export type SealTaskContentResult =
  | { readonly ok: true; readonly content: SealedBlobInput }
  | {
      readonly ok: false;
      readonly reason: SealFailureReason | 'content_invalid';
    };

/** 用事の内容を、その用事を所有者にして暗号化する。 */
export function sealTaskContent(
  dataKey: DataKeyMaterial,
  taskId: string,
  content: TaskContent,
  blobId: string = randomUUID(),
): SealTaskContentResult {
  if (!isTaskContent(content)) return { ok: false, reason: 'content_invalid' };
  const sealed = sealBlob(
    dataKey,
    Buffer.from(taskContentJson(content), 'utf8'),
    taskContentOwner(taskId),
  );
  if (!sealed.ok) return { ok: false, reason: sealed.reason };
  const envelope = sealed.envelope;
  return {
    ok: true,
    content: {
      blob_id: blobId,
      format_version: envelope.formatVersion,
      key_id: envelope.keyId,
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
      tag: envelope.tag,
    },
  };
}

export type OpenTaskContentResult =
  | { readonly ok: true; readonly content: TaskContent }
  | {
      readonly ok: false;
      readonly reason: OpenFailureReason | 'content_invalid';
    };

/** 用事の暗号文を復号し、平文の形を確かめる。別の用事・別の用途の暗号文は認証で失敗する。 */
export function openTaskContent(
  dataKey: DataKeyMaterial,
  taskId: string,
  envelope: SealedEnvelope,
): OpenTaskContentResult {
  const opened = openBlob(dataKey, envelope, taskContentOwner(taskId));
  if (!opened.ok) return opened;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(opened.plaintext),
    );
  } catch {
    return { ok: false, reason: 'content_invalid' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return { ok: false, reason: 'content_invalid' };
  const { schema, ...rest } = parsed as Record<string, unknown>;
  if (schema !== TASK_CONTENT_SCHEMA || !isTaskContent(rest))
    return { ok: false, reason: 'content_invalid' };
  return { ok: true, content: rest };
}

/** 2 つの用事の内容が同じか（読み戻しの照合）。 */
export function sameTaskContent(a: TaskContent, b: TaskContent): boolean {
  return a.title === b.title && a.due === b.due && a.body === b.body;
}
