// バックアップの鍵の運用の判定（J1、ADR 0040「復旧キーと鍵の包み」・0047、B06-05。B06-01 の Codex の P3）。
// HKDF・AES-GCM の計算は Core（node:crypto）が行う。domain は、導き方の入力（salt・info・長さ・AAD）の組み立てと検査、
// 復旧キーの文字列の読み取り、設定のやり直しで鍵を保つ判定、復元で鍵を入れる順序（稼働中の鍵を壊さない）だけを持つ。
// 鍵の素材そのものは扱わない（ikm は Core が渡す）。決まらないときは、鍵を作らない・入れない・復元しない側へ倒す。

import {
  BACKUP_KEY_PURPOSES,
  isBackupGeneration,
  keyWrapFor,
  keyWrapProblems,
  type BackupKeyPurpose,
  type BackupKeyWrapLike,
} from './backup-plan.js';

// --- バイト列（domain は Node の Buffer・TextEncoder を使わない。値はすべて ASCII） ---

function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0x7e || code < 0x20)
      throw new TypeError('ASCII の印字可能な文字だけを使ってください。');
    bytes[index] = code;
  }
  return bytes;
}

// 部品を 0x00 で区切ってつなぐ（区切りを入れるので、部品の境目をずらした別の組と同じ列にならない）。
function joinWithZero(parts: readonly string[]): Uint8Array {
  const encoded = parts.map(asciiBytes);
  const length =
    encoded.reduce((sum, part) => sum + part.length, 0) + parts.length - 1;
  const out = new Uint8Array(length);
  let offset = 0;
  encoded.forEach((part, index) => {
    if (index > 0) {
      out[offset] = 0;
      offset += 1;
    }
    out.set(part, offset);
    offset += part.length;
  });
  return out;
}

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// 標準の base64（= の詰め物つき）を読む。形が違えば null。
export function decodeBackupBase64(text: string): Uint8Array | null {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      text,
    )
  )
    return null;
  const body = text.replace(/=+$/u, '');
  const out = new Uint8Array(Math.floor((body.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of body) {
    value = (value << 6) | BASE64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (value >> bits) & 0xff;
      index += 1;
    }
  }
  // 詰め物の前の余りのビットは 0（同じバイト列に別の表記を許さない）。
  if ((value & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

// --- HKDF の入力 ---

export interface BackupHkdfInput {
  readonly hash: 'sha256';
  // RFC 5869 の salt。空（長さ 0）は「HashLen 個の 0」と同じ扱い（RFC 5869 §2.2）。
  readonly salt: Uint8Array;
  readonly info: Uint8Array;
  readonly length: number;
}

const WRAP_LABEL = 'buddy/backup/key-wrap/v1';
// 台帳・記憶の用途別の鍵（ADR 0040 の info）。salt は空。
export const LEDGER_SUBKEY_INFO = {
  source_id: 'buddy/ledger/source-id/v1',
  memory_dedupe: 'buddy/memory/dedupe/v1',
} as const;
export type LedgerSubkeyUse = keyof typeof LEDGER_SUBKEY_INFO;
const RECOVERY_CHECK_INFO = 'buddy/recovery-key/check/v1';

// 包む鍵（AES-256-GCM の鍵）の導き方: HKDF-SHA256(ikm = 復旧キーの 32 バイト, salt = 包みの kdf.salt の 16 バイト,
// info = "buddy/backup/key-wrap/v1" ‖ 0x00 ‖ purpose ‖ 0x00 ‖ key_id, L = 32)。用途と鍵の ID を info に入れるので、
// 用途ごとに包む鍵が変わり、同じ nonce が別の用途で重なっても鍵が同じにならない。
export function keyWrapHkdfInput(wrap: BackupKeyWrapLike): BackupHkdfInput {
  const salt = decodeBackupBase64(wrap.kdf.salt);
  if (salt === null || salt.length !== 16)
    throw new TypeError('salt は 16 バイトの base64 にしてください。');
  return {
    hash: 'sha256',
    salt,
    info: joinWithZero([WRAP_LABEL, wrap.purpose, wrap.key_id]),
    length: 32,
  };
}

// AES-256-GCM の追加認証データ: "buddy/backup/key-wrap/v1" ‖ 0x00 ‖ purpose ‖ 0x00 ‖ key_id ‖ 0x00 ‖ recovery_key_id。
// 包みを別の用途・別の鍵の ID・別の復旧キーの欄へ入れ替えると、認証タグが合わず開けない（取り違えの検出）。
export function keyWrapAad(wrap: BackupKeyWrapLike): Uint8Array {
  return joinWithZero([
    WRAP_LABEL,
    wrap.purpose,
    wrap.key_id,
    wrap.recovery_key_id,
  ]);
}

const PAYLOAD_LABEL = 'buddy/backup/payload/v1';
const UUID_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

// 封筒の本体（SQLite の写し）を暗号化する鍵の導き方（ADR 0055 の U121）:
// HKDF-SHA256(ikm = backup_file の鍵, salt = backup_id（UUID の 16 バイト）,
// info = "buddy/backup/payload/v1" ‖ 0x00 ‖ backup_file の鍵の ID, L = 32)。
// 毎回の封筒の鍵が backup_id ごとに変わるので、1 つの鍵で nonce の再利用を気にせず何度でも取れる（nonce も毎回乱数）。
export function backupPayloadHkdfInput(
  ikmKeyId: string,
  backupId: string,
): BackupHkdfInput {
  if (!UUID_TEXT.test(backupId))
    throw new TypeError('backup_id は小文字の UUID にしてください。');
  const salt = new Uint8Array(16);
  const hex = backupId.replace(/-/gu, '');
  for (let index = 0; index < 16; index += 1)
    salt[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return {
    hash: 'sha256',
    salt,
    info: joinWithZero([PAYLOAD_LABEL, ikmKeyId]),
    length: 32,
  };
}

export interface BackupPayloadAadFields {
  readonly backup_id: string;
  readonly created_at: string;
  readonly store_generation: string;
  readonly db_schema_version: number;
  readonly forgetting_generation: string;
  readonly ledger_id: string;
  readonly ledger_head_hash: string;
  readonly excluded_tables: readonly string[];
  // backup_file の鍵の ID（封筒の key_wraps の backup_file の key_id）。
  readonly backup_file_key_id: string;
  // 封筒の平文の欄のうち payload（本体の長さと SHA-256。別に照合する）を除いた全体の SHA-256（小文字の 16 進 64 桁）。
  // storage が正規の JSON から求める。key_wraps・included_storage_modes・excluded_data・schema など上の欄にない欄も、
  // 書き換えると本体の認証に失敗する（PR #175 の P1）。
  readonly envelope_sha256: string;
}

const HEX64 = /^[0-9a-f]{64}$/u;

// 本体の AES-256-GCM の追加認証データ: ラベル ‖ 0x00 ‖ 封筒の平文の欄（backup_id・created_at・store_generation・
// db_schema_version・forgetting_generation・ledger_id・ledger_head_hash・除外した表（コンマ区切り）・鍵の ID・封筒の平文の欄の
// 全体の SHA-256）を 0x00 で区切る。
// 封筒（平文）を別の本体と組み替える・書き換えると認証タグが合わず開けない（ADR 0047 の P3-7 の引き継ぎ）。
export function backupPayloadAad(fields: BackupPayloadAadFields): Uint8Array {
  if (!HEX64.test(fields.envelope_sha256))
    throw new TypeError(
      'envelope_sha256 は小文字の 16 進 64 桁にしてください。',
    );
  return joinWithZero([
    PAYLOAD_LABEL,
    fields.backup_id,
    fields.created_at,
    fields.store_generation,
    String(fields.db_schema_version),
    fields.forgetting_generation,
    fields.ledger_id,
    fields.ledger_head_hash,
    fields.excluded_tables.join(','),
    fields.backup_file_key_id,
    fields.envelope_sha256,
  ]);
}

// 台帳の HMAC の鍵（ledger_hmac_key）から用途別の鍵を導く: HKDF-SHA256(ikm = ledger_hmac_key, salt = 空, info = 用途の名前, L = 32)。
export function ledgerSubkeyHkdfInput(use: LedgerSubkeyUse): BackupHkdfInput {
  if (!Object.hasOwn(LEDGER_SUBKEY_INFO, use))
    throw new TypeError('台帳の鍵の用途が分かりません。');
  return {
    hash: 'sha256',
    salt: new Uint8Array(0),
    info: asciiBytes(LEDGER_SUBKEY_INFO[use]),
    length: 32,
  };
}

// 復旧キーの確認値（RecoveryKeyRecord.check_value。32 ビット）: HKDF-SHA256(ikm = 復旧キー, salt = 空,
// info = "buddy/recovery-key/check/v1", L = 4) を大文字の 16 進 8 桁にする。打ち間違いを先に見つけるためだけ。
export function recoveryCheckHkdfInput(): BackupHkdfInput {
  return {
    hash: 'sha256',
    salt: new Uint8Array(0),
    info: asciiBytes(RECOVERY_CHECK_INFO),
    length: 4,
  };
}

export type BackupHkdfProblem =
  | 'hash_not_sha256'
  | 'salt_length_invalid'
  | 'info_empty'
  | 'info_too_long'
  | 'info_not_buddy_label'
  | 'length_invalid';

const BUDDY_PREFIX = asciiBytes('buddy/');

// HKDF の入力の検査（Core が node:crypto の hkdfSync を呼ぶ直前に使う）。salt は 0 か 16 バイト、info は buddy/ で始まる
// 1〜1024 バイト（Node.js の上限）、長さは 1〜32 バイト（この ADR の用途は 32 と確認値の 4 だけ）。
export function backupHkdfInputProblems(
  input: BackupHkdfInput,
): BackupHkdfProblem[] {
  const problems: BackupHkdfProblem[] = [];
  if (input.hash !== 'sha256') problems.push('hash_not_sha256');
  if (input.salt.length !== 0 && input.salt.length !== 16)
    problems.push('salt_length_invalid');
  if (input.info.length === 0) problems.push('info_empty');
  if (input.info.length > 1024) problems.push('info_too_long');
  if (
    input.info.length < BUDDY_PREFIX.length ||
    BUDDY_PREFIX.some((byte, index) => input.info[index] !== byte)
  )
    problems.push('info_not_buddy_label');
  if (
    !Number.isSafeInteger(input.length) ||
    input.length < 1 ||
    input.length > 32
  )
    problems.push('length_invalid');
  return problems;
}

// --- 復旧キーの文字列（Crockford base32。4 文字 × 13 組 = 260 ビットのうち、先頭の 256 ビット） ---

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function encodeRecoveryCode(key: Uint8Array): string {
  if (key.length !== 32)
    throw new TypeError('復旧キーは 32 バイトにしてください。');
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of key) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >> bits) & 31];
    }
  }
  // 残りの 1 ビットに 0 を 4 つ足して 52 文字にする。
  out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.match(/.{4}/gu)?.join('-') ?? '';
}

// 本人が入力した復旧キーを 32 バイトに戻す。区切りの - と空白は無視し、小文字は大文字に、Crockford の読み替え
// （I・L → 1、O → 0）だけを許す。U などの使わない文字・文字数の違い・末尾の 4 ビットが 0 でないものは null。
// 正規化の前に ASCII の英数字・空白・- だけに絞る（toUpperCase は 'ı' を I、'ſ' を S にするので。Sonnet の P3-1）。
export function decodeRecoveryCode(text: string): Uint8Array | null {
  if (!/^[0-9A-Za-z\s-]*$/u.test(text)) return null;
  const normalized = text
    .replace(/[\s-]/gu, '')
    .toUpperCase()
    .replace(/[IL]/gu, '1')
    .replace(/O/gu, '0');
  if (normalized.length !== 52) return null;
  const out = new Uint8Array(32);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of normalized) {
    const digit = CROCKFORD.indexOf(char);
    if (digit < 0) return null;
    value = ((value << 5) | digit) & 0xffff;
    bits += 5;
    if (bits >= 8 && index < 32) {
      bits -= 8;
      out[index] = (value >> bits) & 0xff;
      index += 1;
    }
  }
  if (index !== 32 || bits !== 4 || (value & 0b1111) !== 0) return null;
  return out;
}

// --- 設定のやり直しで鍵を保つ ---

export interface KeyStoreKeyRef {
  readonly key_id: string;
}

const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export interface BackupSetupKeyInput {
  // KeyStore に今ある鍵（用途ごとに今使う 1 つ。null はない）。
  readonly keystore: Readonly<Record<BackupKeyPurpose, KeyStoreKeyRef | null>>;
  // DB に記録した台帳の鍵の ID（schema_meta。null は未記録）。
  readonly recorded_ledger_key_id: string | null;
  // 台帳の今の世代。
  readonly forgetting_generation: string;
  // DB の暗号文が使っている鍵の ID。
  readonly db_blob_key_ids: readonly string[];
}

export type BackupSetupKeyProblem =
  | 'key_id_invalid'
  | 'generation_invalid'
  | 'data_key_missing'
  | 'data_key_not_covering_db'
  | 'ledger_key_missing'
  | 'ledger_key_mismatch'
  | 'ledger_key_unrecorded';

export type BackupSetupKeyPlan =
  | {
      readonly ok: true;
      readonly actions: Readonly<
        Record<BackupKeyPurpose, 'reuse' | 'generate'>
      >;
      // 台帳の鍵の ID を DB に記録する（新しく作ったとき・まだ記録していなかったとき）。
      readonly record_ledger_key_id: boolean;
      // 3 つの鍵を、新しい復旧キーで包み直す（復旧キーは 1 度だけ表示。古いバックアップは古い復旧キーで開く）。
      readonly rewrap_all: true;
    }
  | { readonly ok: false; readonly reasons: readonly BackupSetupKeyProblem[] };

// 設定（CLI）をやり直しても、ある鍵は作り直さない。台帳に項目がある・台帳の鍵を記録したのに KeyStore にない（欠落）、
// KeyStore の鍵が記録と違う（取り違え）ときは、新しい鍵を作らずに止める（作ると、台帳と記憶の HMAC を照合できず、
// 忘れた元情報の再取り込みを止められなくなる）。データ鍵は CLI が作らない（ADR 0040。読むだけ）。
export function backupSetupKeyPlan(
  input: BackupSetupKeyInput,
): BackupSetupKeyPlan {
  const problems = new Set<BackupSetupKeyProblem>();
  const ids = [
    ...BACKUP_KEY_PURPOSES.map((purpose) => input.keystore[purpose]?.key_id),
    input.recorded_ledger_key_id ?? undefined,
    ...input.db_blob_key_ids,
  ].filter((id): id is string => id !== undefined);
  if (ids.some((id) => !KEY_ID.test(id))) problems.add('key_id_invalid');
  if (!isBackupGeneration(input.forgetting_generation))
    problems.add('generation_invalid');
  const data = input.keystore.data_key;
  if (data === null) problems.add('data_key_missing');
  else if (input.db_blob_key_ids.some((id) => id !== data.key_id))
    problems.add('data_key_not_covering_db');
  const ledger = input.keystore.ledger_hmac_key;
  const recorded = input.recorded_ledger_key_id;
  const ledgerHasEntries = input.forgetting_generation !== '0';
  if (recorded === null) {
    if (ledgerHasEntries) problems.add('ledger_key_unrecorded');
  } else if (ledger === null) problems.add('ledger_key_missing');
  else if (ledger.key_id !== recorded) problems.add('ledger_key_mismatch');
  if (problems.size > 0) return { ok: false, reasons: [...problems] };
  return {
    ok: true,
    actions: {
      backup_file: input.keystore.backup_file === null ? 'generate' : 'reuse',
      data_key: 'reuse',
      ledger_hmac_key: ledger === null ? 'generate' : 'reuse',
    },
    record_ledger_key_id: recorded === null,
    rewrap_all: true,
  };
}

// --- 復元で鍵を入れる順序（稼働中の鍵を壊さない） ---

export interface KeyStoreEntry {
  readonly purpose: BackupKeyPurpose;
  readonly key_id: string;
  // 封筒の同じ ID の鍵と素材が同じか（Core が開いた鍵と定数時間で比べる）。ID が違う鍵は比べない（null）。
  readonly material_matches_restored: boolean | null;
}

export type KeyInstallStep =
  // 封筒から開いた鍵を、自分の ID で KeyStore に足す（既存の鍵を上書きしない）。
  | {
      readonly step: 'stage_key';
      readonly purpose: BackupKeyPurpose;
      readonly key_id: string;
    }
  // 同じ ID・同じ素材の鍵がすでにある。何もしない。
  | {
      readonly step: 'keep_existing_key';
      readonly purpose: BackupKeyPurpose;
      readonly key_id: string;
    }
  // 足した鍵を読み戻して比べる。
  | { readonly step: 'verify_staged_keys' }
  // 作業用の DB と差し替え、同じ transaction で今使う鍵の ID を記録する（台帳の鍵・新しく書く暗号文の鍵）。
  | {
      readonly step: 'swap_database';
      readonly active_key_ids: Readonly<Record<BackupKeyPurpose, string>>;
    }
  // 使わなくなった既存の鍵は消さずに残す（消すのは本人が確かめた後の別の操作）。
  | {
      readonly step: 'retain_previous_keys';
      readonly keys: readonly KeyRef[];
    };

// 鍵は用途と ID の組で指す（同じ ID が別の用途にあっても取り違えない。Sonnet の P2-3）。
export interface KeyRef {
  readonly purpose: BackupKeyPurpose;
  readonly key_id: string;
}

export type KeyInstallProblem =
  | 'key_wrap_unusable'
  | 'key_material_conflict'
  | 'key_material_unverified'
  | 'ledger_key_conflict';

export type KeyInstallPlan =
  | {
      readonly ok: true;
      readonly steps: readonly KeyInstallStep[];
      // 差し替えの前に失敗したときに消してよい鍵（この計画で足した鍵だけ。用途と ID の組）。既存の鍵は含まない。
      readonly discard_on_failure: readonly KeyRef[];
    }
  | { readonly ok: false; readonly reasons: readonly KeyInstallProblem[] };

// 復元で鍵を KeyStore に入れる計画。足すだけで上書き・削除をしない。差し替え（段階 5 の後）より前のどこで失敗しても、
// 足した鍵を消すだけで、稼働中の鍵と DB は元のまま。同じ ID で素材が違う鍵（取り違え）、台帳の鍵が別の ID で
// すでにある（別の HMAC の空間）ときは入れない。同じ ID の鍵が別の用途で KeyStore にあるときも、取り違えとして入れない。
export function keyInstallPlan(input: {
  readonly key_wraps: readonly BackupKeyWrapLike[];
  readonly keystore: readonly KeyStoreEntry[];
}): KeyInstallPlan {
  const problems = new Set<KeyInstallProblem>();
  const restored = {} as Record<BackupKeyPurpose, string>;
  for (const purpose of BACKUP_KEY_PURPOSES) {
    const wrap = keyWrapFor(input.key_wraps, purpose);
    if (wrap === null || !KEY_ID.test(wrap.key_id))
      problems.add('key_wrap_unusable');
    else restored[purpose] = wrap.key_id;
  }
  if (keyWrapProblems(input.key_wraps).length > 0)
    problems.add('key_wrap_unusable');
  if (problems.size > 0) return { ok: false, reasons: [...problems] };
  const steps: KeyInstallStep[] = [];
  const staged: KeyRef[] = [];
  for (const purpose of BACKUP_KEY_PURPOSES) {
    const keyId = restored[purpose];
    const same = input.keystore.filter(
      (entry) => entry.purpose === purpose && entry.key_id === keyId,
    );
    if (
      purpose === 'ledger_hmac_key' &&
      input.keystore.some(
        (entry) => entry.purpose === purpose && entry.key_id !== keyId,
      )
    )
      problems.add('ledger_key_conflict');
    if (
      input.keystore.some(
        (entry) => entry.key_id === keyId && entry.purpose !== purpose,
      )
    )
      problems.add('key_material_conflict');
    if (same.length === 0) {
      steps.push({ step: 'stage_key', purpose, key_id: keyId });
      staged.push({ purpose, key_id: keyId });
    } else if (same.some((entry) => entry.material_matches_restored === false))
      problems.add('key_material_conflict');
    else if (same.some((entry) => entry.material_matches_restored !== true))
      problems.add('key_material_unverified');
    else steps.push({ step: 'keep_existing_key', purpose, key_id: keyId });
  }
  if (problems.size > 0) return { ok: false, reasons: [...problems] };
  const isRestored = (entry: KeyRef): boolean =>
    restored[entry.purpose] === entry.key_id;
  const seen = new Set<string>();
  const retained: KeyRef[] = [];
  for (const entry of input.keystore) {
    const key = `${entry.purpose}\u0000${entry.key_id}`;
    if (isRestored(entry) || seen.has(key)) continue;
    seen.add(key);
    retained.push({ purpose: entry.purpose, key_id: entry.key_id });
  }
  retained.sort((a, b) =>
    a.purpose !== b.purpose
      ? a.purpose < b.purpose
        ? -1
        : 1
      : a.key_id < b.key_id
        ? -1
        : a.key_id > b.key_id
          ? 1
          : 0,
  );
  steps.push({ step: 'verify_staged_keys' });
  steps.push({ step: 'swap_database', active_key_ids: { ...restored } });
  steps.push({ step: 'retain_previous_keys', keys: retained });
  return { ok: true, steps, discard_on_failure: staged };
}

export type KeyInstallOrderProblem =
  | 'swap_before_staging'
  | 'swap_before_verify'
  | 'verify_before_staging'
  | 'swap_missing'
  | 'step_after_swap';

// 鍵を入れる手順の順序の検査（Core の実装が計画の順序を入れ替えていないかを確かめる）。足す・確かめる・差し替える
// の順で、差し替えの後は既存の鍵を残すことしかしない。
export function keyInstallOrderProblems(
  steps: readonly KeyInstallStep[],
): KeyInstallOrderProblem[] {
  const problems = new Set<KeyInstallOrderProblem>();
  const swap = steps.findIndex((step) => step.step === 'swap_database');
  const verify = steps.findIndex((step) => step.step === 'verify_staged_keys');
  const lastStage = steps.reduce(
    (last, step, index) => (step.step === 'stage_key' ? index : last),
    -1,
  );
  if (swap < 0) problems.add('swap_missing');
  if (swap >= 0 && lastStage > swap) problems.add('swap_before_staging');
  if (swap >= 0 && (verify < 0 || verify > swap))
    problems.add('swap_before_verify');
  if (verify >= 0 && lastStage > verify) problems.add('verify_before_staging');
  if (
    swap >= 0 &&
    steps.slice(swap + 1).some((step) => step.step !== 'retain_previous_keys')
  )
    problems.add('step_after_swap');
  return [...problems];
}
