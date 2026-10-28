// 忘却台帳の別ファイルと DB の整合（設計 03 バックアップ・復元、ADR 0040・0054）。
//
// DB（forget_ledger・forget_ledger_items）が正本で、ファイルは DB から作り直せる写し。忘却の transaction の COMMIT の
// 後と、Core の起動時に syncForgetLedger を呼ぶ。COMMIT の後・ファイルを書く前に止まっても、次の起動で DB に合わせて
// 書き直す。ファイルが DB より進んでいる・食い違う・系譜が違う・壊れているときは書き換えず、起動を止める（DB が古い
// 状態へ戻された疑いがあり、そのまま動くと忘れた内容を使い得るため）。

import { syncForgetLedgerFile } from '@buddy/storage';
import type {
  LedgerFileRefusal,
  LedgerFileSyncResult,
  MemoryOp,
  MemoryOpKind,
  MemoryOpOutcome,
} from '@buddy/storage';

export interface ForgetLedgerStore {
  memory<K extends MemoryOpKind>(
    op: Extract<MemoryOp, { kind: K }>,
  ): Promise<MemoryOpOutcome<K>>;
}

export type ForgetLedgerFailure = LedgerFileRefusal | 'ledger_export_failed';

export class ForgetLedgerError extends Error {
  readonly reason: ForgetLedgerFailure;
  readonly reasons: readonly string[];
  constructor(reason: ForgetLedgerFailure, reasons: readonly string[] = []) {
    super(`忘却台帳のファイルと DB をそろえられません（${reason}）。`);
    this.name = 'ForgetLedgerError';
    this.reason = reason;
    this.reasons = reasons;
  }
}

// DB の台帳を読み、ファイルをそろえる。そろえられなければ ForgetLedgerError を投げる。
export async function syncForgetLedger(
  store: ForgetLedgerStore,
  path: string,
  now: Date,
): Promise<Extract<LedgerFileSyncResult, { ok: true }>> {
  const exported = await store.memory({ kind: 'forget.ledger_export' });
  if (!exported.ok)
    throw new ForgetLedgerError('ledger_export_failed', exported.reasons);
  const result = await syncForgetLedgerFile(path, exported.value, now);
  if (!result.ok) throw new ForgetLedgerError(result.reason);
  return result;
}

// 忘却を適用し、COMMIT の後に台帳のファイルをそろえる。適用が拒否されればファイルには触れない。ファイルを書けなかった
// ときも忘却は確定しているので結果は返し、file に失敗の理由を入れる（次の起動の同期で書き直す）。
export async function applyForgetAndSyncLedger(
  store: ForgetLedgerStore,
  op: Extract<MemoryOp, { kind: 'forget.apply' }>,
  path: string,
  now: Date,
): Promise<{
  readonly result: MemoryOpOutcome<'forget.apply'>;
  readonly file: string | null;
}> {
  const result = await store.memory(op);
  if (!result.ok) return { result, file: null };
  try {
    const synced = await syncForgetLedger(store, path, now);
    return { result, file: synced.action };
  } catch (error) {
    return {
      result,
      file:
        error instanceof ForgetLedgerError
          ? error.reason
          : 'ledger_file_write_failed',
    };
  }
}
