// 家計簿の請求予定の Core の手順（ADR 0176）。
//
// - recordHouseholdBill: 請求のお知らせから読んだ請求予定を 1 件作る。出所の鍵（domain の householdBillSourceKeyMaterial の
//   SHA-256）で同じメールから二つ目を作らない。同じ月に同じ会社・同じ引き落とし日・同じ金額の請求予定があれば、別の
//   メール（確定のお知らせと引き落とし前のお知らせなど）でも作らない（same_bill）。中身は請求予定を所有者にして暗号化する。
// - readHouseholdBills: 1 か月（引き落とし日の月）の請求予定を読み、復号して並べる。復号できない請求予定は数だけ返す。
//   消す操作のために、請求予定の ID と内容版も返す（ADR 0179）。
// - deleteHouseholdBill: 本人が請求予定を消す（ADR 0179）。内容版を照合し、行は残して月と中身を消す（保存層）。同じメールから
//   作り直さない。別のメールが同じ請求を知らせても、消した請求予定の中身はもう読めないので、同じ請求かは比べられない
//   （新しい請求予定として作る）。
// 請求予定は家計の記録（household_entries）に入れないので、月の集計・予算・定期の支出の計算には入らない（二重の計上を
// しない）。承認・実行経路・effect_kind は関わらない（メールを読むだけで、外部を変えない）。

import {
  householdBillContentErrors,
  householdBillSourceKeyMaterial,
  householdMonthOf,
  householdSameBill,
  summarizeHouseholdBills,
} from '@buddy/domain';
import type {
  HouseholdBillContent,
  HouseholdBillSourceParts,
  HouseholdMonthBills,
} from '@buddy/domain';
import { openHouseholdBill, sealHouseholdBill } from '@buddy/storage';
import type { DataKeyMaterial, HouseholdBillRecord } from '@buddy/storage';
import type { HouseholdPorts } from './household-ledger.js';

type Failure = {
  readonly outcome: 'rejected' | 'unknown';
  readonly reasons: readonly string[];
};

export type RecordedHouseholdBill =
  | { readonly outcome: 'created'; readonly bill_id: string }
  // duplicate は同じメールから作り済み、same_bill は別のメールから同じ請求を作り済み。
  | { readonly outcome: 'duplicate' | 'same_bill' }
  | Failure;

// 請求予定 1 件（中身と、消す操作の照合に使う ID と内容版）。
export interface HouseholdBillView extends HouseholdBillContent {
  readonly bill_id: string;
  readonly content_revision: string;
}

export type HouseholdBillDeletion =
  | {
      readonly outcome: 'deleted';
      readonly bill_id: string;
      readonly content_revision: string;
    }
  | Failure;

export interface HouseholdBillsRead {
  readonly outcome: 'ok';
  readonly bills: HouseholdMonthBills<HouseholdBillView>;
  // 復号できなかった請求予定の数（並べず、合計に入れていない）。
  readonly unreadable: number;
  // 一度に読む上限で切ったか。
  readonly truncated: boolean;
}

function openRecord(
  dataKey: DataKeyMaterial,
  record: HouseholdBillRecord,
): HouseholdBillContent | null {
  if (record.content === null) return null;
  const opened = openHouseholdBill(dataKey, record.bill_id, {
    formatVersion: record.content.format_version,
    keyId: record.content.key_id,
    nonce: record.content.nonce,
    ciphertext: record.content.ciphertext,
    tag: record.content.tag,
  });
  if (!opened.ok) return null;
  // 月の列と引き落とし日が食い違う請求予定は読めないものとして扱う（別の月に出さない）。
  if (householdMonthOf(opened.content.due_on) !== record.month) return null;
  return opened.content;
}

async function listMonth(
  ports: Pick<HouseholdPorts, 'client' | 'dataKey'>,
  month: string,
): Promise<
  | {
      readonly ok: true;
      readonly bills: readonly HouseholdBillView[];
      readonly unreadable: number;
      readonly truncated: boolean;
    }
  | ({ readonly ok: false } & Failure)
> {
  const listed = await ports.client.household({
    kind: 'household.bill_list',
    month,
  });
  if (!listed.ok)
    return { ok: false, outcome: listed.outcome, reasons: listed.reasons };
  const bills: HouseholdBillView[] = [];
  let unreadable = 0;
  for (const record of listed.value.bills) {
    const content = openRecord(ports.dataKey, record);
    if (content === null) unreadable += 1;
    else
      bills.push({
        bill_id: record.bill_id,
        content_revision: record.content_revision,
        issuer: content.issuer,
        amount_yen: content.amount_yen,
        due_on: content.due_on,
      });
  }
  return { ok: true, bills, unreadable, truncated: listed.value.truncated };
}

export async function recordHouseholdBill(
  ports: HouseholdPorts,
  source: HouseholdBillSourceParts,
  content: HouseholdBillContent,
): Promise<RecordedHouseholdBill> {
  const material = householdBillSourceKeyMaterial(source);
  if (material === null)
    return { outcome: 'rejected', reasons: ['source_invalid'] };
  const errors = householdBillContentErrors(content);
  if (errors.length > 0) return { outcome: 'rejected', reasons: errors };
  const month = householdMonthOf(content.due_on);
  if (month === null)
    return { outcome: 'rejected', reasons: ['due_on_invalid'] };
  // 同じ請求を知らせる別のメールから二つ目を作らない。読めない請求予定があっても、読めた分だけで比べる。
  const current = await listMonth(ports, month);
  if (!current.ok)
    return { outcome: current.outcome, reasons: current.reasons };
  if (current.bills.some((bill) => householdSameBill(bill, content)))
    return { outcome: 'same_bill' };
  const billId = ports.newId();
  const sealed = sealHouseholdBill(
    ports.dataKey,
    billId,
    content,
    ports.newId(),
  );
  if (!sealed.ok) return { outcome: 'rejected', reasons: [sealed.reason] };
  const result = await ports.client.household({
    kind: 'household.bill_record',
    bill_id: billId,
    source_key: ports.sha256Hex(material),
    month,
    content: sealed.content,
    now: ports.now(),
  });
  if (!result.ok) return { outcome: result.outcome, reasons: result.reasons };
  if (result.value.outcome === 'duplicate') return { outcome: 'duplicate' };
  return { outcome: 'created', bill_id: result.value.bill_id };
}

/** 1 か月（引き落とし日の月）の請求予定を読み、引き落とし日の順に並べて合計する。 */
export async function readHouseholdBills(
  ports: Pick<HouseholdPorts, 'client' | 'dataKey'>,
  month: string,
): Promise<HouseholdBillsRead | Failure> {
  const listed = await listMonth(ports, month);
  if (!listed.ok) return { outcome: listed.outcome, reasons: listed.reasons };
  return {
    outcome: 'ok',
    bills: summarizeHouseholdBills(listed.bills, month),
    unreadable: listed.unreadable,
    truncated: listed.truncated,
  };
}

/** 請求予定を消す（ADR 0179）。照合と書込みは保存層が同じ transaction で行う。 */
export async function deleteHouseholdBill(
  ports: Pick<HouseholdPorts, 'client' | 'now'>,
  billId: string,
  expectedRevision: string,
): Promise<HouseholdBillDeletion> {
  const deleted = await ports.client.household({
    kind: 'household.bill_delete',
    bill_id: billId,
    expected_revision: expectedRevision,
    now: ports.now(),
  });
  if (!deleted.ok)
    return { outcome: deleted.outcome, reasons: deleted.reasons };
  return {
    outcome: 'deleted',
    bill_id: deleted.value.bill_id,
    content_revision: deleted.value.content_revision,
  };
}
