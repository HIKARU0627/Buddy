// 予算の実行時の設定ファイルの読み込み（本人の判断 2026-10-23、ADR 0034・0037）。
//
// - 置き場所はリポジトリの外の Core のデータディレクトリ（budget-runtime.json）。本人が書き、Core は起動時に一度だけ読む。
//   編集の画面はキャンバス UI の置き場所が決まった後（本人の判断）。個人の金額をリポジトリに入れない。
// - 普通のファイル（シンボリックリンクではない）で、大きさの上限以内で、本人以外が書けない（POSIX）ときだけ読む。
// - 厳格な JSON（重複キー・不正な Unicode を拒否）→ 契約の JSON Schema（BudgetRuntimeConfig）→ 意味検査
//   （domain の budgetRuntimeConfigErrors。契約の検査と同じ理由コード）→ タイムゾーンの正規化の順に確かめる。
// - タイムゾーンは Intl の resolvedOptions().timeZone で正規化し、記録にはその名前を使う。Etc/* は拒否、旧別名は
//   正規の名前にして警告を返す。null は中枢の OS の設定。
// - どれかに通らなければ有料の処理を無効にする（理由コードだけを返し、ファイルの中身・金額を返さない）。

import { lstat, readFile } from 'node:fs/promises';
import {
  budgetRuntimeConfigErrors,
  normalizeTimeZone,
  toBudgetSettings,
} from '@buddy/domain';
import type { BudgetRuntimeConfigInput, BudgetSettings } from '@buddy/domain';
import type { ApiContract } from './api-contract.js';
import { StrictJsonError, parseStrictJson } from './strict-json.js';

export const BUDGET_CONFIG_FILE = 'budget-runtime.json';
export const MAX_BUDGET_CONFIG_BYTES = 256 * 1024;

export type LoadedBudgetConfig =
  | {
      readonly ok: true;
      readonly config: BudgetRuntimeConfigInput;
      readonly settings: BudgetSettings;
      // 予算月の境目に使う、正規化したタイムゾーン（設定の値、null なら OS の設定）。
      readonly timeZone: string;
      // 警告（time_zone_normalized: 渡した名前を正規の名前にした）。読み込みは成功している。
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly reasons: readonly string[] };

export interface LoadBudgetConfigOptions {
  readonly path: string;
  readonly contract: ApiContract;
  // 設定の time_zone が null のときに使う中枢の OS のタイムゾーン（試験で差し替える）。
  readonly osTimeZone?: () => string;
  readonly platform?: NodeJS.Platform;
}

const fail = (...reasons: string[]): LoadedBudgetConfig => ({
  ok: false,
  reasons,
});

export function defaultOsTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// 形と意味の検査に通った値の正規化（タイムゾーンを除く）。ファイルの読み取りから切り離して試験する。
export function checkBudgetConfigText(
  text: string,
  contract: ApiContract,
  osTimeZone: () => string = defaultOsTimeZone,
): LoadedBudgetConfig {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(text, 32);
  } catch (error) {
    return fail(
      error instanceof StrictJsonError && error.code === 'duplicate_key'
        ? 'config_duplicate_key'
        : 'config_invalid_json',
    );
  }
  // 原型のないオブジェクトを普通の値にする（DB worker へ渡すため）。
  const value = JSON.parse(JSON.stringify(parsed)) as unknown;
  if (!contract.valid('BudgetRuntimeConfig', value))
    return fail('config_schema_invalid');
  const config = value as BudgetRuntimeConfigInput;
  const semantic = budgetRuntimeConfigErrors(config);
  if (semantic.length > 0)
    return fail(
      ...[...new Set(semantic)].map((reason) => `config_semantic:${reason}`),
    );
  let requested: string;
  try {
    requested = config.time_zone ?? osTimeZone();
  } catch {
    return fail('time_zone_unavailable');
  }
  const zone = normalizeTimeZone(requested);
  if (!zone.ok) return fail(`time_zone_rejected:${zone.reason}`);
  return {
    ok: true,
    config,
    settings: toBudgetSettings(config.budget),
    timeZone: zone.timeZone,
    warnings: zone.normalized ? ['time_zone_normalized'] : [],
  };
}

// 設定ファイルを読む。読めない・不正なら ok: false（有料の処理を無効にする）。
export async function loadBudgetConfig(
  options: LoadBudgetConfigOptions,
): Promise<LoadedBudgetConfig> {
  const platform = options.platform ?? process.platform;
  let stat;
  try {
    stat = await lstat(options.path);
  } catch (error) {
    return fail(
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'config_missing'
        : 'config_unreadable',
    );
  }
  if (!stat.isFile()) return fail('config_not_regular_file');
  if (stat.size > MAX_BUDGET_CONFIG_BYTES) return fail('config_too_large');
  // 本人以外が書ける設定は、予算の上限を他人が変えられるので使わない（POSIX のみ）。
  if (platform !== 'win32' && (stat.mode & 0o022) !== 0)
    return fail('config_writable_by_others');
  let text: string;
  try {
    const bytes = await readFile(options.path);
    if (bytes.byteLength > MAX_BUDGET_CONFIG_BYTES)
      return fail('config_too_large');
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('config_unreadable');
  }
  return checkBudgetConfigText(
    text,
    options.contract,
    options.osTimeZone ?? defaultOsTimeZone,
  );
}
