// 本人のタイムゾーン（IANA）の出所（本人の決定 2026-11-21、ADR 0131）。
//
// - 出所は中枢の端末（OS）のタイムゾーン。予算の設定（budget-config.ts の defaultOsTimeZone）と同じく
//   Intl.DateTimeFormat().resolvedOptions().timeZone で読む。
// - 起動時に固定せず、要求ごとに読み直す（OS の設定の変更をそのまま反映する）。
// - 検証は domain の normalizeTimeZone（Etc/* は拒否、旧別名は正規の名前にする）。
// - 読めない・不正なときは null を返し、UTC などで黙って代替しない（呼び出し側は 503 で閉じる）。
// - 明示の設定による上書きは将来の余地として、今回は作らない。

import { normalizeTimeZone } from '@buddy/domain';

// 端末（OS）のタイムゾーンを読む。読み取りで例外が出たときは undefined。
export function readDeviceTimeZone(): string | undefined {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

// 呼ぶたびに read() を評価し、正規化した IANA の名前を返す。読めない・不正なら null（代替しない）。
export function deviceTimeZone(
  read: () => string | undefined = readDeviceTimeZone,
): string | null {
  let raw: string | undefined;
  try {
    raw = read();
  } catch {
    return null;
  }
  if (raw === undefined) return null;
  const zone = normalizeTimeZone(raw);
  return zone.ok ? zone.timeZone : null;
}
