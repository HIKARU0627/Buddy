// 復元の復旧キーの入力（ADR 0056 の U128。本人の決定 2026-10-31）。
//
// 復旧キーは端末の標準入力（TTY）からだけ読む。パイプ・ファイル・環境変数・引数からは読まない（履歴・ログ・
// プロセスの一覧に残る経路を作らない）。入力は画面に出さない（端末の生モードで 1 文字ずつ読み、改行で確定する）。
// 復旧キーそのものは Core・制御チャネル・ログ・DB へ渡さない（CLI のプロセスの中だけで使う）。
// 打ち間違いは復旧キーの確認値（backup-keys.json）で先に見つける。ここでは Crockford base32 の形だけを確かめる。

import { decodeRecoveryCode } from '@buddy/domain';

export type RecoveryKeyInputFailure =
  // 標準入力が TTY でない（パイプ・リダイレクト）。
  | 'not_a_tty'
  // 何も入力されずに閉じた。
  | 'input_closed'
  | 'input_empty'
  | 'input_too_long'
  // Ctrl-C で中断した。
  | 'interrupted'
  // Crockford base32（52 文字）として読めない。
  | 'invalid_code';

export type RecoveryKeyInput =
  | { readonly ok: true; readonly key: Buffer }
  | { readonly ok: false; readonly reason: RecoveryKeyInputFailure };

export interface RecoveryKeyPrompt {
  // 画面（標準エラー）に出す案内。
  readonly write: (text: string) => void;
}

// 端末の入力の最小の口（試験は偽の TTY を渡す）。
export interface TtyInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(mode: boolean): void;
  setEncoding(encoding: BufferEncoding): void;
  resume(): void;
  pause(): void;
  on(event: 'data' | 'end', listener: (value: string) => void): unknown;
  removeListener(
    event: 'data' | 'end',
    listener: (value: string) => void,
  ): unknown;
}

const MAX_INPUT_CHARS = 200;

// 復旧キーを 1 行だけ読む。TTY でなければ読まずに not_a_tty を返す（呼び出し側は復元を始めない）。
export async function readRecoveryKeyFromTty(
  tty: TtyInput,
  prompt: RecoveryKeyPrompt,
): Promise<RecoveryKeyInput> {
  if (tty.isTTY !== true) return { ok: false, reason: 'not_a_tty' };
  prompt.write(
    '復旧キーを入力してください（52 文字。4 文字ずつの区切りは省略できます。入力は画面に出ません）。\n',
  );
  tty.setEncoding('utf8');
  const raw = tty.isRaw === true;
  if (tty.setRawMode !== undefined) tty.setRawMode(true);
  try {
    const line = await new Promise<
      | { readonly ok: true; readonly text: string }
      | { readonly ok: false; readonly reason: 'interrupted' | 'closed' }
    >((resolve) => {
      let text = '';
      let done = false;
      const finish = (
        value:
          | { readonly ok: true; readonly text: string }
          | { readonly ok: false; readonly reason: 'interrupted' | 'closed' },
      ) => {
        if (done) return;
        done = true;
        tty.removeListener('data', onData);
        tty.removeListener('end', onEnd);
        resolve(value);
      };
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char === '\u0003') {
            // Ctrl-C。改行を出してから中断する。
            prompt.write('\n');
            finish({ ok: false, reason: 'interrupted' });
            return;
          }
          if (char === '\r' || char === '\n') {
            prompt.write('\n');
            finish({ ok: true, text });
            return;
          }
          if (char === '\u007f' || char === '\b') {
            text = [...text].slice(0, -1).join('');
            continue;
          }
          // 制御文字（矢印キーのエスケープなど）は無視する。
          if (char < ' ') continue;
          if (text.length >= MAX_INPUT_CHARS) {
            prompt.write('\n入力が長すぎます。\n');
            finish({ ok: false, reason: 'closed' });
            return;
          }
          text += char;
        }
      };
      const onEnd = () => finish({ ok: false, reason: 'closed' });
      tty.on('data', onData);
      tty.on('end', onEnd);
      tty.resume();
    });
    if (!line.ok)
      return line.reason === 'interrupted'
        ? { ok: false, reason: 'interrupted' }
        : { ok: false, reason: 'input_closed' };
    if (line.text.trim().length === 0)
      return { ok: false, reason: 'input_empty' };
    if (line.text.length > MAX_INPUT_CHARS)
      return { ok: false, reason: 'input_too_long' };
    const key = decodeRecoveryCode(line.text);
    if (key === null) return { ok: false, reason: 'invalid_code' };
    return { ok: true, key: Buffer.from(key) };
  } finally {
    if (tty.setRawMode !== undefined) tty.setRawMode(raw);
    tty.pause();
  }
}

// 標準エラーへの案内。復旧キーの値は決して書かない。
export const stderrPrompt: RecoveryKeyPrompt = {
  write: (text) => process.stderr.write(text),
};
