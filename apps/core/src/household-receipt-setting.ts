// レシートの写真の読み取りの入・切の保存（ADR 0179。ADR 0177 の U364 の暫定の判断を変えた）。
//
// 入・切は家計簿の設定の行（household_settings、マイグレーション 0022）に保存し、中枢を起動し直しても変わらない。行が
// なければ切。版は利用通知の取り込みの入・切（ADR 0163）と共通の settings_revision で、保存層が同じ transaction で照合する。
// 中枢に読み取りの口（provider と profile）がないときに unavailable とするのは household-receipt.ts で、ここは保存した値だけを
// 扱う。

import type { DbWorkerClient } from '@buddy/storage';

export type ReceiptReadingSetting = 'on' | 'off';

export interface ReceiptSettingStored {
  readonly receipt_reading: ReceiptReadingSetting;
  // 家計簿の設定の版（行がなければ 0）。
  readonly settings_revision: string;
}

export type ReceiptSettingWrite =
  | { readonly kind: 'written'; readonly stored: ReceiptSettingStored }
  // 版が今と違う（表示が古い・同じ要求の再送）。409 にする。
  | { readonly kind: 'conflict' }
  // 形の誤り。422 にする。
  | { readonly kind: 'invalid' }
  // 保存の失敗・成否不明。503 にし、自動では送り直さない。
  | { readonly kind: 'unknown' };

/** 入・切を読み書きする口。本番は receiptSettingStoreOf（DB）、試験は memoryReceiptSettingStore。 */
export interface ReceiptSettingStore {
  // 保存した入・切と版。読めなければ null（入とみなさない）。
  read(): Promise<ReceiptSettingStored | null>;
  // 入にするときは版を照合して保存する。切にするときは、版が違っても保存する（安全な向き）。同じ値でも版を進める。
  write(
    expectedRevision: string,
    value: ReceiptReadingSetting,
  ): Promise<ReceiptSettingWrite>;
}

// 設定の版の形（行がなければ 0。保存層と同じ）。
export const RECEIPT_SETTING_REVISION = /^(0|[1-9][0-9]{0,15})$/u;

/** 家計簿の設定の行に保存する口。 */
export function receiptSettingStoreOf(
  client: Pick<DbWorkerClient, 'household'>,
  now: () => number,
): ReceiptSettingStore {
  return {
    async read() {
      try {
        const got = await client.household({
          kind: 'household.settings_get',
        });
        return got.ok
          ? {
              receipt_reading: got.value.receipt_reading,
              settings_revision: got.value.settings_revision,
            }
          : null;
      } catch {
        return null;
      }
    },
    async write(expectedRevision, value) {
      try {
        const set = await client.household({
          kind: 'household.receipt_setting_set',
          expected_revision: expectedRevision,
          receipt_reading: value,
          now: new Date(now()).toISOString(),
        });
        if (set.ok)
          return {
            kind: 'written',
            stored: {
              receipt_reading: set.value.receipt_reading,
              settings_revision: set.value.settings_revision,
            },
          };
        if (set.outcome === 'unknown') return { kind: 'unknown' };
        if (
          set.reasons.length > 0 &&
          set.reasons.every((reason) => reason === 'revision_mismatch')
        )
          return { kind: 'conflict' };
        if (
          set.reasons.length > 0 &&
          set.reasons.every(
            (reason) =>
              reason === 'expected_revision_invalid' ||
              reason === 'receipt_reading_invalid',
          )
        )
          return { kind: 'invalid' };
        return { kind: 'unknown' };
      } catch {
        return { kind: 'unknown' };
      }
    },
  };
}

/**
 * 中枢のメモリーにだけ持つ口（試験と、保存先を渡さない組み立て）。中枢を起動し直すと切・版 0 に戻る。版の照合（入にするときだけ）は
 * DB の口と同じ。
 */
export function memoryReceiptSettingStore(): ReceiptSettingStore {
  let stored: ReceiptSettingStored = {
    receipt_reading: 'off',
    settings_revision: '0',
  };
  return {
    read: () => Promise.resolve(stored),
    write(expectedRevision, value) {
      if (!RECEIPT_SETTING_REVISION.test(expectedRevision))
        return Promise.resolve({ kind: 'invalid' });
      if (value === 'on' && expectedRevision !== stored.settings_revision)
        return Promise.resolve({ kind: 'conflict' });
      stored = {
        receipt_reading: value,
        settings_revision: String(Number(stored.settings_revision) + 1),
      };
      return Promise.resolve({ kind: 'written', stored });
    },
  };
}
