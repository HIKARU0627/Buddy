// 画面の時刻・期限・指紋の書き方（ADR 0024 の約束）。React と DOM に依存しない純粋な関数で、node:test で試験する。
// 時刻は端末の地域時間で出し、今日の分は時刻だけ、それ以外は月日を付ける。数字は画面で tabular-nums にする。

const pad = (value: number) => String(value).padStart(2, '0');

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// 「16:15:55」（今日）・「10/20 16:15:55」（今日でない）。seconds が false なら秒を落とし、date が true なら今日でも月日を付ける。
export function clockOf(
  utc: string,
  now: number,
  options: { readonly seconds?: boolean; readonly date?: boolean } = {},
): string {
  const date = new Date(utc);
  if (Number.isNaN(date.getTime())) return utc;
  const time =
    options.seconds === false
      ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
      : `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return sameDay(date, new Date(now)) && options.date !== true
    ? time
    : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

// 「4 秒後」「2 分後」（過ぎていれば「まもなく」）。
export function afterOf(utc: string, now: number): string {
  const ms = new Date(utc).getTime() - now;
  if (Number.isNaN(ms) || ms <= 0) return 'まもなく';
  const seconds = Math.ceil(ms / 1000);
  return seconds < 60 ? `${seconds} 秒後` : `${Math.ceil(seconds / 60)} 分後`;
}

// 「残り 4 分」「残り 30 秒」「期限切れ」。
export function remainingOf(utc: string, now: number): string {
  const ms = new Date(utc).getTime() - now;
  if (Number.isNaN(ms) || ms <= 0) return '期限切れ';
  const seconds = Math.ceil(ms / 1000);
  return seconds < 60
    ? `残り ${seconds} 秒`
    : `残り ${Math.ceil(seconds / 60)} 分`;
}

// 指紋（64 桁の 16 進）を 4 桁ずつの 16 組にする（4 組ずつ 4 行に並べる）。CLI の人向けの出力と同じ区切り。
export function fingerprintGroups(fingerprint: string): string[] {
  return fingerprint.match(/.{1,4}/gu) ?? [];
}

// 8 桁のコード・確認コードを 4 桁ずつに区切る。
export function splitInFour(value: string): string {
  return (value.match(/.{1,4}/gu) ?? []).join(' ');
}
