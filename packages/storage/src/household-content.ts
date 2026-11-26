// 家計の記録の暗号文（ADR 0158、マイグレーション 0016）。
//
// 記録（household_entries）は自分の暗号文（purpose = household_entry、owner_table = household_entries、
// owner_id = entry_id、版 = 内容版）に金額・日付・分類・店名などを持つ。平文の形はこのファイルだけが決める
// （ワイヤ契約ではない。DB の中の暗号文の中身）。中身の意味の検査は domain の householdContentErrors が正本。
// 暗号化・復号は Core main が行い、DB worker は暗号文だけを受け取る（ADR 0018）。

import { randomUUID } from 'node:crypto';
import {
  householdBillContentErrors,
  householdBudgetErrors,
  householdContentErrors,
  sortHouseholdBudget,
} from '@buddy/domain';
import type {
  HouseholdBillContent,
  HouseholdBudgetItem,
  HouseholdEntryContent,
} from '@buddy/domain';
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
export const HOUSEHOLD_CONTENT_SCHEMA = 'buddy.household_entry.v1';

export function householdContentOwner(
  entryId: string,
  revision: number,
): SealedBlobOwner {
  return {
    ownerTable: 'household_entries',
    ownerId: entryId,
    ownerVersion: revision,
    purpose: 'household_entry',
  };
}

// 平文。項目の順を固定した JSON。
function householdContentJson(content: HouseholdEntryContent): string {
  return JSON.stringify({
    schema: HOUSEHOLD_CONTENT_SCHEMA,
    direction: content.direction,
    amount_yen: content.amount_yen,
    occurred_on: content.occurred_on,
    occurred_time: content.occurred_time,
    category: content.category,
    merchant: content.merchant,
    memo: content.memo,
    payment: content.payment,
  });
}

export type SealHouseholdContentResult =
  | { readonly ok: true; readonly content: SealedBlobInput }
  | {
      readonly ok: false;
      readonly reason: SealFailureReason | 'content_invalid';
    };

/** 記録の内容を、その記録のその内容版を所有者にして暗号化する。 */
export function sealHouseholdContent(
  dataKey: DataKeyMaterial,
  entryId: string,
  revision: number,
  content: HouseholdEntryContent,
  blobId: string = randomUUID(),
): SealHouseholdContentResult {
  if (householdContentErrors(content).length > 0)
    return { ok: false, reason: 'content_invalid' };
  const sealed = sealBlob(
    dataKey,
    Buffer.from(householdContentJson(content), 'utf8'),
    householdContentOwner(entryId, revision),
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

export type OpenHouseholdContentResult =
  | { readonly ok: true; readonly content: HouseholdEntryContent }
  | {
      readonly ok: false;
      readonly reason: OpenFailureReason | 'content_invalid';
    };

/** 記録の暗号文を復号し、中身を確かめる。別の記録・別の版・別の用途の暗号文は認証で失敗する。 */
export function openHouseholdContent(
  dataKey: DataKeyMaterial,
  entryId: string,
  revision: number,
  envelope: SealedEnvelope,
): OpenHouseholdContentResult {
  const opened = openBlob(
    dataKey,
    envelope,
    householdContentOwner(entryId, revision),
  );
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
  if (
    schema !== HOUSEHOLD_CONTENT_SCHEMA ||
    householdContentErrors(rest).length > 0
  )
    return { ok: false, reason: 'content_invalid' };
  return { ok: true, content: rest as unknown as HouseholdEntryContent };
}

// --- 分類ごとの予算（ADR 0166、マイグレーション 0019） ---

/** 予算の平文の形の版。 */
export const HOUSEHOLD_BUDGET_SCHEMA = 'buddy.household_budget.v1';

export function householdBudgetOwner(revision: number): SealedBlobOwner {
  return {
    ownerTable: 'household_budgets',
    ownerId: '1',
    ownerVersion: revision,
    purpose: 'household_budget',
  };
}

/** 予算の一覧を、その版を所有者にして暗号化する。分類の表示の順にそろえる。 */
export function sealHouseholdBudget(
  dataKey: DataKeyMaterial,
  revision: number,
  items: readonly HouseholdBudgetItem[],
  blobId: string = randomUUID(),
): SealHouseholdContentResult {
  if (householdBudgetErrors(items).length > 0)
    return { ok: false, reason: 'content_invalid' };
  const plaintext = JSON.stringify({
    schema: HOUSEHOLD_BUDGET_SCHEMA,
    items: sortHouseholdBudget(items).map((item) => ({
      category: item.category,
      budget_yen: item.budget_yen,
    })),
  });
  const sealed = sealBlob(
    dataKey,
    Buffer.from(plaintext, 'utf8'),
    householdBudgetOwner(revision),
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

export type OpenHouseholdBudgetResult =
  | { readonly ok: true; readonly items: readonly HouseholdBudgetItem[] }
  | {
      readonly ok: false;
      readonly reason: OpenFailureReason | 'content_invalid';
    };

/** 予算の暗号文を復号し、中身を確かめる。 */
export function openHouseholdBudget(
  dataKey: DataKeyMaterial,
  revision: number,
  envelope: SealedEnvelope,
): OpenHouseholdBudgetResult {
  const opened = openBlob(dataKey, envelope, householdBudgetOwner(revision));
  if (!opened.ok) return opened;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(opened.plaintext),
    );
  } catch {
    return { ok: false, reason: 'content_invalid' };
  }
  const record = parsed as Record<string, unknown> | null;
  if (
    record === null ||
    typeof record !== 'object' ||
    record['schema'] !== HOUSEHOLD_BUDGET_SCHEMA ||
    !Array.isArray(record['items'])
  )
    return { ok: false, reason: 'content_invalid' };
  const items = (record['items'] as unknown[]).map((item) => {
    const value = (item ?? {}) as Record<string, unknown>;
    return {
      category: value['category'] as string,
      budget_yen: value['budget_yen'] as number,
    };
  });
  if (
    householdBudgetErrors(items).length > 0 ||
    (record['items'] as unknown[]).some(
      (item) =>
        item === null ||
        typeof item !== 'object' ||
        Object.keys(item).sort().join(',') !== 'budget_yen,category',
    )
  )
    return { ok: false, reason: 'content_invalid' };
  return { ok: true, items };
}

// --- 請求予定（ADR 0176、マイグレーション 0021） ---

/** 請求予定の平文の形の版。 */
export const HOUSEHOLD_BILL_SCHEMA = 'buddy.household_bill.v1';

// 請求予定は書いたら変えないので、版はいつも 1。
export function householdBillOwner(billId: string): SealedBlobOwner {
  return {
    ownerTable: 'household_bills',
    ownerId: billId,
    ownerVersion: 1,
    purpose: 'household_bill',
  };
}

/** 請求予定の中身（会社・金額・引き落とし日）を、その請求予定を所有者にして暗号化する。 */
export function sealHouseholdBill(
  dataKey: DataKeyMaterial,
  billId: string,
  content: HouseholdBillContent,
  blobId: string = randomUUID(),
): SealHouseholdContentResult {
  if (householdBillContentErrors(content).length > 0)
    return { ok: false, reason: 'content_invalid' };
  const plaintext = JSON.stringify({
    schema: HOUSEHOLD_BILL_SCHEMA,
    issuer: content.issuer,
    amount_yen: content.amount_yen,
    due_on: content.due_on,
  });
  const sealed = sealBlob(
    dataKey,
    Buffer.from(plaintext, 'utf8'),
    householdBillOwner(billId),
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

export type OpenHouseholdBillResult =
  | { readonly ok: true; readonly content: HouseholdBillContent }
  | {
      readonly ok: false;
      readonly reason: OpenFailureReason | 'content_invalid';
    };

/** 請求予定の暗号文を復号し、中身を確かめる。別の請求予定・別の用途の暗号文は認証で失敗する。 */
export function openHouseholdBill(
  dataKey: DataKeyMaterial,
  billId: string,
  envelope: SealedEnvelope,
): OpenHouseholdBillResult {
  const opened = openBlob(dataKey, envelope, householdBillOwner(billId));
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
  if (
    schema !== HOUSEHOLD_BILL_SCHEMA ||
    householdBillContentErrors(rest).length > 0
  )
    return { ok: false, reason: 'content_invalid' };
  return { ok: true, content: rest as unknown as HouseholdBillContent };
}
