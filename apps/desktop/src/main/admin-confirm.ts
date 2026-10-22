// 承認・拒否・失効の前の OS の確認ダイアログの文言（本人の判断 2026-10-22、ADR 0026）。Electron に依存しない純粋な関数で、
// 値は main が中枢から受け取った一覧の値だけを使う。端末名・OS は申請者の自己申告なので、制御文字・書字方向の制御文字を
// 取り除き、長さを切る。確認コードの見比べを求める文を必ず入れる。
import type { AdminConfirmRequest } from './core-link.js';

const PLATFORMS: Readonly<Record<string, string>> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
};

// 制御文字（C0・DEL・C1）、ゼロ幅・書字方向の制御文字を除き、空白をまとめる。
// 表示から除く文字か（C0・DEL・C1 の制御文字、ゼロ幅・行区切り・書字方向の制御文字、BOM）。
function hidden(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  );
}

export function displayText(value: string, max = 60): string {
  const cleaned = [...value]
    .map((char) => (hidden(char.codePointAt(0) ?? 0) ? ' ' : char))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  const chars = [...cleaned];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : cleaned;
}

const clock = (utc: string): string => {
  const date = new Date(utc);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export interface AdminConfirmText {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  // 0 番は「やめる」（既定・取り消し）、1 番が確定。
  readonly buttons: readonly [string, string];
}

export function adminConfirmText(
  request: AdminConfirmRequest,
): AdminConfirmText {
  const name = displayText(request.deviceName) || '（名前なし）';
  const platform =
    PLATFORMS[request.platform] ?? displayText(request.platform, 20);
  const at = clock(request.at);
  const check =
    request.claimCheck === null
      ? null
      : displayText(request.claimCheck, 8).replace(/^(.{4})(.{4})$/u, '$1 $2');
  switch (request.action) {
    case 'approve':
      return {
        title: '申請の承認',
        message: `「${name}」（${platform}・${at} の申請）を承認しますか`,
        detail: `確認コード: ${check ?? '-'}\n\n申請した端末の画面の確認コードと、8 桁すべて同じときだけ承認してください。承認すると、その端末はこの中枢に接続できるようになります。`,
        buttons: ['やめる', '承認する'],
      };
    case 'reject':
      return {
        title: '申請の拒否',
        message: `「${name}」（${platform}・${at} の申請）を拒否しますか`,
        detail: `確認コード: ${check ?? '-'}\n\n拒否した申請は使えなくなります。登録するには、端末側でペアリングを最初からやり直します。`,
        buttons: ['やめる', '拒否する'],
      };
    case 'revoke':
      return {
        title: '端末の失効',
        message: `「${name}」（${platform}・${at} の登録）を失効しますか`,
        detail:
          '失効すると、その端末はすぐに切断され、元に戻せません。もう一度使うには、端末側で登録し直します。他の端末には影響しません。',
        buttons: ['やめる', '失効する'],
      };
  }
}
