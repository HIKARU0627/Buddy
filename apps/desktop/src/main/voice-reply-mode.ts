// 端末ごとの返し方（声で返す・文字で返す。設計 10 §6A「切り替え」、質問 107、B05-05、ADR 0052）の記録。
// Electron に依存しない（node:test で試験する）。
// - 返し方は端末ごとの設定で、呼びかけ語は共通。端末（main）が持ち、中枢には持たせない（文字で返す端末は Live の経路を呼ばない）。
// - 記録がなければ「声で返す」（最初の既定）。ただし、記録があるのに読めない・形が違うときは「文字で返す」にする
//   （本人が文字を選んでいたかもしれないので、外へ音声を送らない側へ倒す。同意は別に OS の確認ダイアログで取る）。
// - 保存に失敗しても、この起動の間は選んだ値で動く（次の起動で戻るおそれがあるので記録する）。
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const VOICE_REPLY_MODE_FILE = 'voice-reply-mode.json';

export type ReplyModeValue = 'voice' | 'text';

// 保存した記録の形（{"reply_mode":"voice"|"text"} だけ）。余分な項目・知らない値は null。
export function replyModeRecordFrom(raw: unknown): ReplyModeValue | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return null;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'reply_mode') return null;
  const value = record['reply_mode'];
  return value === 'voice' || value === 'text' ? value : null;
}

export interface VoiceReplyModeStoreOptions {
  // 保存した記録を読む（なければ null。読めなければ例外）。
  readonly load: () => unknown;
  readonly save: (mode: ReplyModeValue) => void;
  readonly log?: (code: string) => void;
}

export class VoiceReplyModeStore {
  readonly #options: VoiceReplyModeStoreOptions;
  #mode: ReplyModeValue;

  constructor(options: VoiceReplyModeStoreOptions) {
    this.#options = options;
    let raw: unknown = null;
    let unreadable = false;
    try {
      raw = options.load();
    } catch {
      unreadable = true;
      options.log?.('voice_reply_mode_unreadable');
    }
    if (unreadable) this.#mode = 'text';
    else if (raw === null) this.#mode = 'voice';
    else {
      const parsed = replyModeRecordFrom(raw);
      if (parsed === null) options.log?.('voice_reply_mode_invalid');
      this.#mode = parsed ?? 'text';
    }
  }

  get mode(): ReplyModeValue {
    return this.#mode;
  }

  set(mode: ReplyModeValue): void {
    this.#mode = mode;
    try {
      this.#options.save(mode);
    } catch {
      this.#options.log?.('voice_reply_mode_save_failed');
    }
  }
}

// 保存しない（試験・音声を使わない組み立て）。
export function memoryReplyModeStore(
  initial: ReplyModeValue = 'voice',
): VoiceReplyModeStore {
  return new VoiceReplyModeStore({
    load: () => ({ reply_mode: initial }),
    save: () => undefined,
  });
}

export function loadVoiceReplyModeFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text) as unknown;
}

// 一時ファイルに書いて fsync し、rename で置き換える（voice-consent と同じ手順）。
export function saveVoiceReplyModeFile(
  path: string,
  mode: ReplyModeValue,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify({ reply_mode: mode })}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
