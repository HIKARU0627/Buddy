// B06 の統合の共通部品（B06-09、Issue #145）。合成のデータ鍵での封筒・合成の目印・目印の探し方・順序の並べ替えを持つ。
//
// 目印（marker）は試験ごとに作る合成の ASCII の文字列で、実データ・個人の値・内部の URL を含まない。探し方は 2 つ:
// - 平文の目印: 保存されたファイル（DB・WAL・台帳の別ファイル・バックアップ・ログ・知らせ・応答）のどこにも平文で
//   出ないこと。本文はデータ鍵で封じて保存するので、平文が出ればログ・応答・暗号化の漏れを表す。
// - 暗号文の目印: 封筒の暗号文（AES-256-GCM の出力のバイト列）そのもの。消した行の暗号文が DB・WAL・バックアップの
//   中身に残っていないことを、バイト列の一致で探す（secure_delete・checkpoint・忘却の適用の観測）。
// どちらも、消していない行の暗号文が見つかること（陽性の対照）を一緒に確かめ、探し方が働いていることを示す。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  openBlob,
  restoreSourceHmac,
  sealBlob,
} from '../../packages/storage/dist/index.js';

export const specification = JSON.parse(
  readFileSync(new URL('./b06-expectations.json', import.meta.url), 'utf8'),
);

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
// 合成のデータ鍵（値に意味はない）。key_id は製品と同じ形。
export const DATA_KEY = Object.freeze({
  keyId: 'data-key-v1',
  key: Buffer.alloc(32, 0x36),
});
// 店の世界（DB worker だけ）で使う台帳の HMAC の鍵（合成）。製品の世界（Core）はバックアップの設定で作った鍵を使う。
export const STORE_LEDGER_KEY = Buffer.alloc(32, 0x4c);

// 順序だけを固定する PRNG（b07-support.mjs と同じ線形合同法。b07 の実行器を読み込まないよう写した）。
export function shuffled(values, seed) {
  let state = seed >>> 0;
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// 合成の目印。試験の回ごとに違う値にする（前の回の残りを今回の観測と取り違えない）。
export function marker(label, seed, round) {
  return `B06-SYNTH-${label}-${seed}-${round}-${randomUUID().slice(0, 8)}`;
}

// 封筒を作る（SealedBlobInput の形）。所有者は製品と同じ（表・ID・版 0・用途）。
export function seal(text, ownerTable, ownerId, purpose) {
  const sealed = sealBlob(DATA_KEY, Buffer.from(text, 'utf8'), {
    ownerTable,
    ownerId,
    ownerVersion: 0,
    purpose,
  });
  if (!sealed.ok) throw new Error(`seal: ${sealed.reason}`);
  return {
    blob_id: randomUUID(),
    format_version: sealed.envelope.formatVersion,
    key_id: sealed.envelope.keyId,
    nonce: sealed.envelope.nonce,
    ciphertext: sealed.envelope.ciphertext,
    tag: sealed.envelope.tag,
  };
}

// DB の sealed_blobs の 1 行を開く（陽性の対照: 消していない本文が実際に保存されていること）。
export function openRow(row, ownerTable, ownerId, purpose) {
  const opened = openBlob(
    DATA_KEY,
    {
      formatVersion: row.format_version,
      keyId: row.key_id,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      tag: row.tag,
    },
    { ownerTable, ownerId, ownerVersion: 0, purpose },
  );
  return opened.ok ? Buffer.from(opened.plaintext).toString('utf8') : null;
}

export function insertBlob(db, blob, purpose, ownerTable, ownerId, createdAt) {
  db.prepare(
    'INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, NULL)',
  ).run(
    blob.blob_id,
    purpose,
    ownerTable,
    ownerId,
    blob.format_version,
    blob.key_id,
    blob.nonce,
    blob.ciphertext,
    blob.tag,
    createdAt,
  );
}

export function insertSession(db, sessionId, createdAt, mode = 'normal') {
  db.prepare(
    'INSERT INTO sessions (session_id, storage_mode, display_device_id, route_revision, summary_blob_id, created_at, ended_at) VALUES (?, ?, NULL, 0, NULL, ?, NULL)',
  ).run(sessionId, mode, createdAt);
}

// 発言を 1 つ入れる（本文は合成の目印を封じた暗号文）。戻り値は封筒（暗号文の目印に使う）。
export function insertTurn(
  db,
  { turnId, sessionId, text, createdAt, expiresAt },
) {
  const blob = seal(text, 'turns', turnId, 'turn_text');
  insertBlob(db, blob, 'turn_text', 'turns', turnId, createdAt);
  db.prepare(
    "INSERT INTO turns (turn_id, session_id, role, input_kind, text_blob_id, created_at, expires_at) VALUES (?, ?, 'user', 'text', ?, ?, ?)",
  ).run(turnId, sessionId, blob.blob_id, createdAt, expiresAt);
  return blob;
}

// 会話の要約を付ける（本文は目印の暗号文）。由来（derivations）は呼び出し側が足す。
export function setSummary(db, sessionId, text, createdAt) {
  const blob = seal(text, 'sessions', sessionId, 'session_summary');
  insertBlob(db, blob, 'session_summary', 'sessions', sessionId, createdAt);
  db.prepare(
    'UPDATE sessions SET summary_blob_id = ? WHERE session_id = ?',
  ).run(blob.blob_id, sessionId);
  return blob;
}

export function edge(db, artifactKind, artifactId, sourceKind, sourceId, at) {
  db.prepare(
    'INSERT INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(artifactKind, artifactId, sourceKind, sourceId, at);
}

// 保存してよい記憶の種類の設定（ADR 0191）。既定は空なので、記憶を保存するケースは先に好みを許可する（版 0 → 1）。
export const SETTINGS_REVISION = '1';
export async function allowPreference(store, now) {
  const allowed = await store.memory({
    kind: 'memory.settings_set',
    expected_revision: '0',
    allowed_kinds: ['preference'],
    now,
  });
  if (!allowed.ok) throw new Error(JSON.stringify(allowed));
}

// 記憶の保存の命令（memory.save）。由来の HMAC は渡された関数で求める（Core と同じ restoreSourceHmac の形）。
export function memorySaveOp({
  memoryId,
  text,
  sources,
  hmac,
  generation,
  now,
  n,
  origin = 'auto_extraction',
  settingsRevision = SETTINGS_REVISION,
}) {
  const sealed = seal(text, 'memories', memoryId, 'memory_text');
  return {
    sealed,
    op: {
      kind: 'memory.save',
      memory_id: memoryId,
      origin,
      memory_kind: 'preference',
      text: sealed,
      target_key: seal(
        `target-${n}`,
        'memories',
        memoryId,
        'memory_target_key',
      ),
      // 合成の HMAC の形の値（記憶ごとに別。同じ対象・同じ内容の衝突を作らない）。
      target_key_hash: n.toString(16).padStart(2, '0').repeat(32),
      dedupe_key: (n + 0x80).toString(16).padStart(2, '0').repeat(32),
      sources,
      source_hmacs: sources.map((source) => ({
        ...source,
        hmac: hmac(source),
      })),
      forgetting_generation: generation,
      settings_revision: settingsRevision,
      now,
    },
  };
}

export const storeHmac = () => restoreSourceHmac(STORE_LEDGER_KEY);

// 結果の要約（ID・理由だけ。本文を含めない）。
export function saveOutcome(result) {
  if (result.ok) return { saved: true, status: result.value.status };
  return { saved: false, reasons: [...(result.reasons ?? [])].sort() };
}

// --- 目印の探し方 ---

// ディレクトリの中のファイルを再帰的に集める（ラベルはディレクトリからの相対パス、区切りは /）。
export function filesUnder(directory, label) {
  const found = {};
  if (!existsSync(directory)) return found;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else
        found[`${label}/${relative(directory, path).split(sep).join('/')}`] =
          path;
    }
  };
  walk(directory);
  return found;
}

// sources: { ラベル: パス | Buffer | string }。needles: { ラベル: Buffer | string }。
// 見つかった組を「ソースのラベル > 目印のラベル」の辞書順の配列で返す。ないファイルは飛ばす。
export function findResidue(sources, needles) {
  const found = [];
  for (const [sourceLabel, source] of Object.entries(sources)) {
    let bytes;
    if (Buffer.isBuffer(source)) bytes = source;
    else if (typeof source === 'string' && existsSync(source))
      bytes = readFileSync(source);
    else if (typeof source === 'object' && source !== null && 'text' in source)
      bytes = Buffer.from(source.text, 'utf8');
    else continue;
    for (const [needleLabel, needle] of Object.entries(needles)) {
      const value = Buffer.isBuffer(needle)
        ? needle
        : Buffer.from(needle, 'utf8');
      if (value.length > 0 && bytes.indexOf(value) >= 0)
        found.push(`${sourceLabel} > ${needleLabel}`);
    }
  }
  return found.sort();
}

// 目印のラベルだけ（どのファイルにあったかを問わない）。
export function residueLabels(found) {
  return [...new Set(found.map((entry) => entry.split(' > ')[1]))].sort();
}

// 文字列を探す対象にする（ログ・知らせ・応答の JSON）。
export const textSource = (value) => ({
  text: typeof value === 'string' ? value : JSON.stringify(value),
});
