// 端末の忘却台帳の複製の保存（B06-07b-3、Issue #179、設計 03、ADR 0040・0180・0182）。
//
// Electron の userData 配下の forget-ledger-replica.json に、契約の ForgetLedgerReplica（世代 1 から head までの全体・
// 本文なし・元情報は HMAC だけ）を置く。device-io-state.json と同じく、同じディレクトリの一時ファイルに書いて fsync し、
// rename で置き換えてからディレクトリを fsync する（Windows はディレクトリを開いて fsync できないので rename まで）。
// - 読み込み: 契約の形（Ajv）と連鎖（世代・previous_hash・entry_hash・entry_id と忘れた対象の重複・head）を確かめる。
//   読めない・形が違う・部分の複製・連鎖が壊れているファイルは使わない（unreadable。閉じた側）。
// - 退避: 読めないファイル・中枢と食い違うファイルは消さず、forget-ledger-replica.set-aside-<乱数>.json へ rename する
//   （中枢が忘却を失った証拠として残す。自動では消さない）。
// - 取り残された一時ファイル（rename の前に止まった書き込み）は、読み込みのときに消す（中身は中枢から受け取った
//   連鎖で、正規のファイルか中枢から取り直せる）。
// ファイル名・ログに台帳の中身（ID・HMAC・世代・hash）を出さない。Electron に依存しない（node:test で試験する）。

import { createHash, randomUUID } from 'node:crypto';
import { open, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ForgetLedgerReplica } from '@buddy/contracts';
import { ledgerChainProblem, ledgerHeadOf } from '@buddy/client';
import type {
  LedgerReplicaChain,
  LedgerReplicaLoad,
  LedgerReplicaStorePort,
} from '@buddy/client';

export const FORGET_LEDGER_REPLICA_FILE = 'forget-ledger-replica.json';
export const FORGET_LEDGER_REPLICA_SCHEMA = 'buddy.forget-ledger-replica.v1';
// 読み込む大きさの上限（契約の台帳の上限 100000 件を見込む）。超えるファイルは読まずに unreadable にする。
export const FORGET_LEDGER_REPLICA_MAX_BYTES = 64 * 1024 * 1024;

const TEMP_PREFIX = '.forget-ledger-replica-';
const TEMP_SUFFIX = '.tmp';
const ASIDE_PREFIX = 'forget-ledger-replica.set-aside-';
const ASIDE_SUFFIX = '.json';

export const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const errorCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined;

async function fsyncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeStaleTemps(path: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dirname(path));
  } catch {
    return;
  }
  for (const name of names)
    if (name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX))
      await rm(join(dirname(path), name), { force: true }).catch(
        () => undefined,
      );
}

// 退避したファイルの名前（試験で数える）。
export async function setAsideReplicaFiles(path: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dirname(path));
  } catch {
    return [];
  }
  return names
    .filter(
      (name) => name.startsWith(ASIDE_PREFIX) && name.endsWith(ASIDE_SUFFIX),
    )
    .sort()
    .map((name) => join(dirname(path), name));
}

// 保存した複製の文を確かめる。使えれば連鎖、だめなら null。
export function parseReplicaText(
  text: string,
  valid: (name: 'ForgetLedgerReplica', value: unknown) => boolean,
): LedgerReplicaChain | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!valid('ForgetLedgerReplica', value)) return null;
  const replica = value as ForgetLedgerReplica;
  if (ledgerChainProblem(replica.ledger, sha256Hex) !== null) return null;
  return {
    ledger_id: replica.ledger.ledger_id,
    entries: replica.ledger.entries,
  };
}

export async function loadReplicaFile(
  path: string,
  valid: (name: 'ForgetLedgerReplica', value: unknown) => boolean,
): Promise<LedgerReplicaLoad> {
  await removeStaleTemps(path);
  let bytes: Buffer;
  try {
    const handle = await open(path, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > FORGET_LEDGER_REPLICA_MAX_BYTES)
        return { kind: 'unreadable' };
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    return errorCode(error) === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable' };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { kind: 'unreadable' };
  }
  const chain = parseReplicaText(text, valid);
  return chain === null ? { kind: 'unreadable' } : { kind: 'loaded', chain };
}

export interface ReplicaFileStoreOptions {
  readonly path: string;
  readonly valid: (name: 'ForgetLedgerReplica', value: unknown) => boolean;
  // 今の登録の端末 ID（中枢の bootstrap の値）。分からなければ保存しない。
  readonly deviceId: () => string | null;
  readonly now: () => Date;
  // 試験で rename の前の停止を再現する。
  readonly beforeRename?: () => void | Promise<void>;
}

export function replicaFileText(replica: ForgetLedgerReplica): string {
  return `${JSON.stringify(replica)}\n`;
}

async function writeAtomic(
  path: string,
  text: string,
  beforeRename?: () => void | Promise<void>,
): Promise<void> {
  const directory = dirname(path);
  const temporary = join(
    directory,
    `${TEMP_PREFIX}${randomUUID()}${TEMP_SUFFIX}`,
  );
  // wx: 新しいファイルだけを作る（同じ名前を開いて切り詰めない）。閉じてから rename・削除する（Windows の EPERM）。
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await beforeRename?.();
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await fsyncDirectory(directory);
}

export function createReplicaFileStore(
  options: ReplicaFileStoreOptions,
): LedgerReplicaStorePort {
  const build = (chain: LedgerReplicaChain): string => {
    const deviceId = options.deviceId();
    if (deviceId === null || chain.ledger_id === null)
      throw new Error('forget_ledger_replica_unbuildable');
    const at = options.now().toISOString();
    const replica: ForgetLedgerReplica = {
      schema: FORGET_LEDGER_REPLICA_SCHEMA,
      device_id: deviceId,
      replicated_at: at,
      ledger: {
        schema: 'buddy.forget-ledger-file.v1',
        ledger_id: chain.ledger_id,
        entries: [...chain.entries],
        head: ledgerHeadOf(chain),
        written_at: at,
      },
    };
    // 書く前に契約の形を確かめる（本文・余分な欄を書かない）。
    if (!options.valid('ForgetLedgerReplica', replica))
      throw new Error('forget_ledger_replica_invalid');
    return replicaFileText(replica);
  };
  return {
    load: () => loadReplicaFile(options.path, options.valid),
    save: async (chain) => {
      await writeAtomic(options.path, build(chain), options.beforeRename);
    },
    replace: async (chain) => {
      const text = build(chain);
      const aside = join(
        dirname(options.path),
        `${ASIDE_PREFIX}${randomUUID()}${ASIDE_SUFFIX}`,
      );
      try {
        // 消さずに退避する（新しい名前なので、ほかのファイルを上書きしない）。
        await rename(options.path, aside);
        await fsyncDirectory(dirname(options.path));
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
      await writeAtomic(options.path, text, options.beforeRename);
    },
  };
}

// 試験用: 退避の名前の形（ファイル名に台帳の中身を入れない）。
export const isSetAsideName = (path: string): boolean => {
  const name = basename(path);
  return (
    name.startsWith(ASIDE_PREFIX) &&
    name.endsWith(ASIDE_SUFFIX) &&
    /^[0-9a-f-]{36}$/u.test(
      name.slice(ASIDE_PREFIX.length, -ASIDE_SUFFIX.length),
    )
  );
};
