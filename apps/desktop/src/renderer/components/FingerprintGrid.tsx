// 中枢の証明書の指紋（SHA-256・64 桁）を、4 桁ずつ 4 組 × 4 行の固定の格子で出す（ADR 0024・0025・0026）。
// 幅が変わっても位置が変わらず、CLI（buddy-core first-device start の人向けの行）と中枢の画面と同じ形で見比べられる。
// 端末の画面（登録する側）では最後の組を伏せる（maskLast）。本人は最後の 4 桁を中枢の画面から読んで入力する
// （自分の画面から写して進めないため。UI レビュー 2 回目 R1-H1）。中枢の画面では最後の組に下線を引き、入力させる 4 桁を示す。
import { fingerprintGroups } from '../format.js';

export const FINGERPRINT_HEADING = '中枢の証明書の指紋（SHA-256・64 桁）';
export const MASKED_GROUP = '····';
export const MASKED_LABEL = '最後の 4 桁は伏せています（中枢の画面で読みます）';

export function FingerprintGrid({
  fingerprint,
  id,
  maskLast = false,
  note,
}: {
  readonly fingerprint: string;
  // 見出しの id（aria-labelledby で結ぶ）。
  readonly id: string;
  // 最後の組を伏せる（端末の画面）。false なら最後の組に下線を引く（中枢の画面）。
  readonly maskLast?: boolean;
  // 見出しの下の補足（最後の 4 桁の扱い）。
  readonly note?: string;
}) {
  const groups = fingerprintGroups(fingerprint);
  const last = groups.length - 1;
  return (
    <div className="flex flex-col gap-2">
      <p id={id} className="text-sm font-medium">
        {FINGERPRINT_HEADING}
      </p>
      {note === undefined ? null : <p className="text-xs text-muted">{note}</p>}
      <ol
        aria-labelledby={id}
        className="grid w-fit grid-cols-4 gap-x-4 gap-y-1 rounded-md border border-border px-4 py-3 font-mono text-lg tabular-nums"
      >
        {groups.map((group, index) =>
          index !== last ? (
            <li key={index} className="whitespace-nowrap">
              {group}
            </li>
          ) : maskLast ? (
            <li
              key={index}
              aria-label={MASKED_LABEL}
              className="whitespace-nowrap text-muted select-none"
            >
              {MASKED_GROUP}
            </li>
          ) : (
            <li
              key={index}
              aria-label={`最後の 4 桁 ${group}`}
              className="whitespace-nowrap font-semibold underline decoration-2 underline-offset-4"
            >
              {group}
            </li>
          ),
        )}
      </ol>
    </div>
  );
}
