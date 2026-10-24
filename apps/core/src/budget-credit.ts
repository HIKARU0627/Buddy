// 付帯クレジットの残高の観測の読み込み（設計 05 クレジットの追補、09 MA03〜MA06、B07-07、ADR 0042）。
//
// - 残高を取得する公式の手段が決まるまで、非公開の API を推測して使わない（原本）。残高・有効期限・共有かどうかは、
//   本人がリポジトリの外のデータディレクトリ（budget-credit-observations.json）に書く。Core は受付・精算・状態欄の
//   たびに読む（本人が書き換えた観測がすぐ効く。Core の再起動は要らない）。
// - ファイルの扱いは予算の設定ファイル（budget-config.ts）と同じ: 普通のファイル（シンボリックリンクではない）・
//   大きさの上限以内・POSIX では本人以外が書けない（他人が残高を書き換えて保留を外せないため）。
// - 厳格な JSON（重複キー・不正な Unicode を拒否）→ 契約の JSON Schema（BudgetCreditObservations）→ 意味検査
//   （domain の creditObservationsErrors。契約の検査と同じ理由コード）の順に確かめる。
// - 読めない・不正・ファイルがないときは「観測なし」と同じ（クレジットを充てる profile は保留）。理由のコードだけを
//   返し、ファイルの中身・残高を返さない。書き込み中の半端なファイルを読んでも保留に倒れるだけなので、本人は
//   一時ファイルへ書いてから置き換える（rename）のがよい。

import { lstat, readFile } from 'node:fs/promises';
import { creditObservationsErrors } from '@buddy/domain';
import type {
  BudgetCreditObservationsInput,
  CreditObservationInput,
} from '@buddy/domain';
import type { ApiContract } from './api-contract.js';
import { StrictJsonError, parseStrictJson } from './strict-json.js';

export const BUDGET_CREDIT_FILE = 'budget-credit-observations.json';
export const MAX_BUDGET_CREDIT_BYTES = 256 * 1024;

export type LoadedCreditObservations =
  | {
      readonly ok: true;
      readonly observations: readonly CreditObservationInput[];
    }
  | {
      readonly ok: false;
      readonly reasons: readonly string[];
      // ファイルがない（本人がまだ書いていない）。読めない・不正とは区別する。
      readonly missing: boolean;
    };

// 受付・精算・状態欄が観測を読む口。ファイル以外（試験の合成の値）に差し替えられる。
export interface CreditObservationSource {
  read(): Promise<LoadedCreditObservations>;
}

const fail = (
  reasons: readonly string[],
  missing = false,
): LoadedCreditObservations => ({ ok: false, reasons, missing });

// 文字列の検査（ファイルの読み取りから切り離して試験する）。
export function checkCreditObservationsText(
  text: string,
  contract: ApiContract,
): LoadedCreditObservations {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(text, 32);
  } catch (error) {
    return fail([
      error instanceof StrictJsonError && error.code === 'duplicate_key'
        ? 'credit_duplicate_key'
        : 'credit_invalid_json',
    ]);
  }
  // 原型のないオブジェクトを普通の値にする（DB worker へ渡す前の形をそろえる）。
  const value = JSON.parse(JSON.stringify(parsed)) as unknown;
  if (!contract.valid('BudgetCreditObservations', value))
    return fail(['credit_schema_invalid']);
  const observations = value as BudgetCreditObservationsInput;
  const semantic = creditObservationsErrors(observations);
  if (semantic.length > 0)
    return fail(
      [...new Set(semantic)].map((code) => `credit_semantic:${code}`),
    );
  return { ok: true, observations: observations.observations };
}

export interface LoadCreditObservationsOptions {
  readonly path: string;
  readonly contract: ApiContract;
  readonly platform?: NodeJS.Platform;
}

export async function loadCreditObservations(
  options: LoadCreditObservationsOptions,
): Promise<LoadedCreditObservations> {
  const platform = options.platform ?? process.platform;
  let stat;
  try {
    stat = await lstat(options.path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? fail(['credit_missing'], true)
      : fail(['credit_unreadable']);
  }
  if (!stat.isFile()) return fail(['credit_not_regular_file']);
  if (stat.size > MAX_BUDGET_CREDIT_BYTES) return fail(['credit_too_large']);
  // 本人以外が書ける観測は、残高を他人が書き換えて保留を外せるので使わない（POSIX のみ）。
  if (platform !== 'win32' && (stat.mode & 0o022) !== 0)
    return fail(['credit_writable_by_others']);
  let text: string;
  try {
    const bytes = await readFile(options.path);
    if (bytes.byteLength > MAX_BUDGET_CREDIT_BYTES)
      return fail(['credit_too_large']);
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail(['credit_unreadable']);
  }
  return checkCreditObservationsText(text, options.contract);
}

// データディレクトリのファイルから読む口。
export function fileCreditSource(
  options: LoadCreditObservationsOptions,
): CreditObservationSource {
  return { read: () => loadCreditObservations(options) };
}
