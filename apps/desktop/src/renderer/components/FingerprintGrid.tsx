// 中枢の証明書の指紋（SHA-256・64 桁）を、4 桁ずつ 4 組 × 4 行の固定の格子で出す（ADR 0024・0026）。
// 幅が変わっても位置が変わらず、CLI（buddy-core first-device start の人向けの行）と中枢の画面と同じ形で見比べられる。
import { fingerprintGroups } from '../format.js';

export const FINGERPRINT_HEADING = '中枢の証明書の指紋（SHA-256・64 桁）';

export function FingerprintGrid({
  fingerprint,
  id,
}: {
  readonly fingerprint: string;
  // 見出しの id（aria-labelledby で結ぶ）。
  readonly id: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p id={id} className="text-sm font-medium">
        {FINGERPRINT_HEADING}
      </p>
      <ol
        aria-labelledby={id}
        className="grid w-fit grid-cols-4 gap-x-4 gap-y-1 rounded-md border border-border px-4 py-3 font-mono text-lg tabular-nums select-all"
      >
        {fingerprintGroups(fingerprint).map((group, index) => (
          <li key={index} className="whitespace-nowrap">
            {group}
          </li>
        ))}
      </ol>
    </div>
  );
}
