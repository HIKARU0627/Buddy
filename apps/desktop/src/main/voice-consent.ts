// 外部への送信の同意の端末側の記録と、OS の確認ダイアログの文言（本人の判断 2026-10-23、ADR 0038・0050）。
// Electron に依存しない（node:test で試験する）。
// - 同意は、初めて「続ける」を押したときに main の OS の確認ダイアログで 1 回だけ取る。画面・LLM は同意を作れない。
// - 正本は中枢（ADR 0038）。中枢へ同意を送る経路は未実装（ADR 0050 の U90）なので、端末は userData の
//   voice-consent.json に、最後に取った同意の状態だけを記録する。この記録は「確認ダイアログを出すか」と表示にだけ使い、
//   外部へ送ってよいかの判定には使わない（中枢の Live の受付が同意を検査する。admitLiveStart）。
// - 取り消しは確認なしでいつでもできる。文面の版（policy_version）が変わったら取り直す。
// - 読めない・形が違う記録は「同意がない」として扱う（同意したことにしない）。
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

export const VOICE_CONSENT_FILE = 'voice-consent.json';
// 同意の文面の版。文面（voiceConsentText）を変えたら上げる。
export const VOICE_CONSENT_POLICY_VERSION = '1';

export interface LocalVoiceConsent {
  readonly kind: 'voice_live_audio';
  readonly provider: 'openai_live';
  readonly policy_version: string;
  readonly state: 'granted' | 'revoked';
  readonly method: 'os_dialog_main';
  readonly confirmed_at: string;
  readonly revoked_at: string | null;
}

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const KEYS = [
  'kind',
  'provider',
  'policy_version',
  'state',
  'method',
  'confirmed_at',
  'revoked_at',
].sort();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// 保存した記録の形を検査する。余分な項目・知らない値・時刻の順の誤りは null（同意がない）。
export function consentRecordFrom(raw: unknown): LocalVoiceConsent | null {
  if (!isRecord(raw)) return null;
  if (JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(KEYS))
    return null;
  const confirmed = raw['confirmed_at'];
  const revoked = raw['revoked_at'];
  if (
    raw['kind'] !== 'voice_live_audio' ||
    raw['provider'] !== 'openai_live' ||
    raw['method'] !== 'os_dialog_main' ||
    typeof raw['policy_version'] !== 'string' ||
    !/^(?:0|[1-9][0-9]{0,8})$/u.test(raw['policy_version']) ||
    (raw['state'] !== 'granted' && raw['state'] !== 'revoked') ||
    typeof confirmed !== 'string' ||
    !UTC.test(confirmed) ||
    !(revoked === null || (typeof revoked === 'string' && UTC.test(revoked)))
  )
    return null;
  if ((raw['state'] === 'revoked') !== (revoked !== null)) return null;
  if (
    typeof revoked === 'string' &&
    Date.parse(revoked) < Date.parse(confirmed)
  )
    return null;
  return raw as unknown as LocalVoiceConsent;
}

// 今の文面の版で同意しているか。
export function localConsentStatus(
  record: LocalVoiceConsent | null,
): 'granted' | 'required' {
  return record !== null &&
    record.state === 'granted' &&
    record.policy_version === VOICE_CONSENT_POLICY_VERSION
    ? 'granted'
    : 'required';
}

export interface VoiceConsentStoreOptions {
  // 保存した記録を読む（なければ null。読めなければ例外）。
  readonly load: () => unknown;
  readonly save: (record: LocalVoiceConsent) => void;
  // 保存した記録を消す（取り消しを保存できなかったとき。記録がなければ「同意がない」なので安全側）。
  readonly remove?: () => void;
  // UTC の RFC 3339。
  readonly now: () => string;
  readonly log?: (code: string) => void;
}

export class VoiceConsentStore {
  readonly #options: VoiceConsentStoreOptions;
  #record: LocalVoiceConsent | null;
  // 取り消しを保存も消去もできなかった（次の起動で同意が戻るおそれがある）。画面で知らせ、取り消しをやり直させる。
  #revokeUnsaved = false;

  constructor(options: VoiceConsentStoreOptions) {
    this.#options = options;
    let raw: unknown = null;
    try {
      raw = options.load();
    } catch {
      options.log?.('voice_consent_unreadable');
    }
    this.#record = raw === null ? null : consentRecordFrom(raw);
    if (raw !== null && this.#record === null)
      options.log?.('voice_consent_invalid');
  }

  get status(): 'granted' | 'required' {
    return localConsentStatus(this.#record);
  }

  get record(): LocalVoiceConsent | null {
    return this.#record;
  }

  get revokeUnsaved(): boolean {
    return this.#revokeUnsaved;
  }

  // OS の確認ダイアログで同意した後だけ呼ぶ。保存に失敗しても、この起動の間は同意として扱う（次の起動で取り直す）。
  grant(): void {
    const now = this.#options.now();
    this.#record = {
      kind: 'voice_live_audio',
      provider: 'openai_live',
      policy_version: VOICE_CONSENT_POLICY_VERSION,
      state: 'granted',
      method: 'os_dialog_main',
      confirmed_at: now,
      revoked_at: null,
    };
    this.#revokeUnsaved = false;
    this.#persist();
  }

  // 取り消す。記録がなくても取り消した記録を残す（この起動の間はいつでも取り消したまま）。
  // 取り消した時刻は、同意した時刻より前にしない（時計が戻っても記録の形が壊れず、保存できる）。
  // 保存に失敗したら記録のファイルを消す（記録がない＝同意がない）。それにも失敗したら revokeUnsaved で知らせる。
  revoke(): void {
    const now = this.#options.now();
    const previous = this.#record;
    const confirmed = previous?.confirmed_at ?? now;
    this.#record = {
      kind: 'voice_live_audio',
      provider: 'openai_live',
      policy_version: previous?.policy_version ?? VOICE_CONSENT_POLICY_VERSION,
      state: 'revoked',
      method: 'os_dialog_main',
      confirmed_at: confirmed,
      revoked_at: Date.parse(now) < Date.parse(confirmed) ? confirmed : now,
    };
    if (this.#persist()) {
      this.#revokeUnsaved = false;
      return;
    }
    try {
      if (this.#options.remove === undefined) throw new Error('no_remove');
      this.#options.remove();
      this.#revokeUnsaved = false;
    } catch {
      this.#options.log?.('voice_consent_revoke_unsaved');
      this.#revokeUnsaved = true;
    }
  }

  #persist(): boolean {
    if (this.#record === null) return true;
    try {
      this.#options.save(this.#record);
      return true;
    } catch {
      this.#options.log?.('voice_consent_save_failed');
      return false;
    }
  }
}

// 保存した記録を読む。ファイルがなければ null。読めない・JSON でなければ例外（呼び出し側は同意がないとして扱う）。
export function loadVoiceConsentFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text) as unknown;
}

// 保存した記録を消す。ファイルがなければ何もしない（消せなければ例外）。
export function removeVoiceConsentFile(path: string): void {
  rmSync(path, { force: true });
}

// 一時ファイルに書いて fsync し、rename で置き換える（device-io-store と同じ手順）。
export function saveVoiceConsentFile(
  path: string,
  record: LocalVoiceConsent,
): void {
  if (consentRecordFrom(record) === null)
    throw new Error('voice_consent_record_invalid');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
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

export interface ConsentDialogText {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  // 0 番は「やめる」（既定・取り消し）、1 番が同意。
  readonly buttons: readonly [string, string];
}

// OS の確認ダイアログの文言。送り先の会社名は、本人が何に同意するかを判断するために出す（画面の状態表示には出さない）。
export function voiceConsentText(): ConsentDialogText {
  return {
    title: '音声を外部へ送ることへの同意',
    message: '会話中の声を、OpenAI の音声サービスへ送ります。',
    detail: [
      '声で話す会話（声で返す）を使う間だけ、この端末のマイクの音声を OpenAI へ送ります。',
      '会話中は、画面の端の印と効果音でいつも知らせます。',
      '同意は、状態のパネルからいつでも取り消せます。取り消すと、会話中の音声はすぐに閉じます。',
      '文字で返す使い方（端末の中で文字にする）は、音声を外へ送りません。',
    ].join('\n'),
    buttons: ['やめる', '同意して続ける'],
  };
}
