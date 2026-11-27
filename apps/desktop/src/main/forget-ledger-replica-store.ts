// 端末の忘却台帳の複製の保存（B06-07b-3、Issue #179、設計 03、ADR 0040・0180・0182）。
//
// Electron の userData 配下の forget-ledger-replica.json に、契約の ForgetLedgerReplica（世代 1 から head までの全体・
// 本文なし・元情報は HMAC だけ）を置く。device-io-state.json と同じく、同じディレクトリの一時ファイルに書いて fsync し、
// rename で置き換えてからディレクトリを fsync する（Windows はディレクトリを開いて fsync できないので rename まで）。
// - 読み込み: 契約の形（Ajv）と連鎖（世代・previous_hash・entry_hash・entry_id と忘れた対象の重複・head）を確かめる。
//   中身が壊れている（UTF-8・JSON・形・部分の複製・連鎖）ファイルは使わない（unreadable。閉じた側）。開けない・読めない
//   （ファイルが無いことを除く読み込みのエラー）・ファイルでないものは transient、大きさの上限を超えるものは too_large に
//   して、どちらも退避も置き換えもしない（正常な複製を退避して head を巻き戻さない）。
// - 退避: 読めないファイル・中枢と食い違うファイル・持ち主の違うファイルは消さず、
//   forget-ledger-replica.set-aside-<乱数>.json に残す（中枢が忘却を失った証拠。自動では消さない）。置き換えは、新しい
//   一時ファイルを fsync まで書く → 今のファイルをハードリンク（できなければ写しを作って fsync）で退避する → 一時ファイルを
//   rename する、の順で、保存先のファイルが欠ける時間を作らない。退避したファイルが上限（8 個）に達していたら、
//   新しく退避せず、置き換えもしない（古い退避は消さない）。
// - rename・退避の写しが EPERM・EBUSY・EACCES（Windows でウイルス対策ソフトなどが開いている）で失敗したら、
//   間隔を空けて 5 回まで繰り返す。
// - 取り残された一時ファイル（rename の前に止まった書き込み）は、読み込みのときに消す（中身は中枢から受け取った
//   連鎖で、正規のファイルか中枢から取り直せる）。
// ファイル名・ログに台帳の中身（ID・HMAC・世代・hash）を出さない。Electron に依存しない（node:test で試験する）。

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  open,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ForgetLedgerReplica } from '@buddy/contracts';
import { ledgerChainProblem, ledgerHeadOf } from '@buddy/client';
import type {
  LedgerReplicaChain,
  LedgerReplicaLoad,
  LedgerReplicaStorePort,
  LedgerReplicaWriteResult,
} from '@buddy/client';

export const FORGET_LEDGER_REPLICA_FILE = 'forget-ledger-replica.json';
export const FORGET_LEDGER_REPLICA_SCHEMA = 'buddy.forget-ledger-replica.v1';
// 読み書きする大きさの上限。契約の台帳は 100000 件までだが、1 件の配列（忘れた対象・HMAC）に上限がないので、
// 契約からファイルの最大の大きさは決まらない（ADR 0182）。上限を超えるファイルは読まず（too_large）、上限を超える
// 複製は書かない（次の起動で読めないファイルを作らない）。
export const FORGET_LEDGER_REPLICA_MAX_BYTES = 64 * 1024 * 1024;
// 退避したファイルの数の上限。達したら新しく退避せず、置き換えもしない（古い退避は消さない。U405）。
export const FORGET_LEDGER_REPLICA_MAX_SET_ASIDE = 8;
// rename・退避の写しを繰り返す間隔（ミリ秒。最初の 1 回の後に 5 回まで）。
export const FORGET_LEDGER_REPLICA_RETRY_DELAYS_MS: readonly number[] = [
  50, 100, 150, 200, 200,
];

const TEMP_PREFIX = '.forget-ledger-replica-';
const TEMP_SUFFIX = '.tmp';
const ASIDE_PREFIX = 'forget-ledger-replica.set-aside-';
const ASIDE_SUFFIX = '.json';
// Windows で、ほかのプログラムがファイルを開いているときに返る。
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

export const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const errorCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined;

// 試験で失敗を入れるファイルの操作。
export interface ReplicaFileOps {
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly link: (existing: string, created: string) => Promise<void>;
  readonly copyFile: (from: string, to: string, mode: number) => Promise<void>;
  // 読み込みのために開く。
  readonly openRead: (path: string) => Promise<FileHandle>;
}

const NODE_OPS: ReplicaFileOps = {
  rename,
  link,
  copyFile,
  openRead: (path) => open(path, 'r'),
};

async function fsyncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// 消せなくても続ける（Windows で開かれているときは少し待って繰り返す）。
async function removeQuietly(path: string): Promise<void> {
  await rm(path, { force: true, maxRetries: 3 }).catch(() => undefined);
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
      await removeQuietly(join(dirname(path), name));
}

const isAsideName = (name: string): boolean =>
  name.startsWith(ASIDE_PREFIX) && name.endsWith(ASIDE_SUFFIX);

// 退避したファイルの名前（試験で数える）。
export async function setAsideReplicaFiles(path: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dirname(path));
  } catch {
    return [];
  }
  return names
    .filter(isAsideName)
    .sort()
    .map((name) => join(dirname(path), name));
}

export interface ParsedReplica {
  readonly chain: LedgerReplicaChain;
  readonly device_id: string;
}

// 保存した複製の文を確かめる。使えれば連鎖と持ち主、だめなら null。
export function parseReplicaText(
  text: string,
  valid: (name: 'ForgetLedgerReplica', value: unknown) => boolean,
): ParsedReplica | null {
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
    chain: {
      ledger_id: replica.ledger.ledger_id,
      entries: replica.ledger.entries,
    },
    device_id: replica.device_id,
  };
}

export async function loadReplicaFile(
  path: string,
  valid: (name: 'ForgetLedgerReplica', value: unknown) => boolean,
  options: {
    readonly maxBytes?: number;
    readonly openRead?: (path: string) => Promise<FileHandle>;
  } = {},
): Promise<LedgerReplicaLoad> {
  const maxBytes = options.maxBytes ?? FORGET_LEDGER_REPLICA_MAX_BYTES;
  await removeStaleTemps(path);
  let bytes: Buffer;
  try {
    const handle = await (options.openRead ?? NODE_OPS.openRead)(path);
    try {
      const info = await handle.stat();
      // ファイルでない（ディレクトリなど）: 中身が壊れたのではなく、退避もできないので触らない。
      if (!info.isFile()) return { kind: 'transient' };
      if (info.size > maxBytes) return { kind: 'too_large' };
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // ファイルが無い以外の読み込みのエラー（EBUSY・EPERM・EACCES・EMFILE など）は、中身を確かめられなかっただけ。
    return errorCode(error) === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'transient' };
  }
  // 読んでいる間に伸びた（stat の後）。
  if (bytes.length > maxBytes) return { kind: 'too_large' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { kind: 'unreadable' };
  }
  const parsed = parseReplicaText(text, valid);
  return parsed === null
    ? { kind: 'unreadable' }
    : { kind: 'loaded', chain: parsed.chain, device_id: parsed.device_id };
}

export interface ReplicaFileStoreOptions {
  readonly path: string;
  readonly valid: (name: 'ForgetLedgerReplica', value: unknown) => boolean;
  // 今の登録の端末 ID（中枢の bootstrap の値）。分からなければ保存しない。
  readonly deviceId: () => string | null;
  readonly now: () => Date;
  // 試験で rename の前の停止を再現する（置き換えでは退避の後・rename の前）。
  readonly beforeRename?: () => void | Promise<void>;
  // 試験で rename の後の停止を再現する（ディレクトリの fsync の前）。
  readonly afterRename?: () => void | Promise<void>;
  // 試験で読み込み・rename・ハードリンク・写しに失敗を入れる。
  readonly ops?: Partial<ReplicaFileOps>;
  // 繰り返しの間の待ち（試験で実時間を待たない）。
  readonly wait?: (ms: number) => Promise<void>;
  readonly maxBytes?: number;
  readonly maxSetAside?: number;
}

export function replicaFileText(replica: ForgetLedgerReplica): string {
  return `${JSON.stringify(replica)}\n`;
}

// EPERM・EBUSY・EACCES のときだけ、間隔を空けて繰り返す。使い切ったら最後の失敗を投げる。
async function retrying(
  operation: () => Promise<void>,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      const pause = FORGET_LEDGER_REPLICA_RETRY_DELAYS_MS[attempt];
      const code = errorCode(error);
      if (
        pause === undefined ||
        typeof code !== 'string' ||
        !RETRYABLE.has(code)
      )
        throw error;
      await wait(pause);
    }
  }
}

// 同じディレクトリに一時ファイルを新しく作り、書いて fsync して閉じる。
async function writeTemporary(
  directory: string,
  text: string,
): Promise<string> {
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
    await removeQuietly(temporary);
    throw error;
  }
  await handle.close();
  return temporary;
}

async function fsyncFile(path: string): Promise<void> {
  // Windows は書き込みのできる開き方でないと fsync できない。
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createReplicaFileStore(
  options: ReplicaFileStoreOptions,
): LedgerReplicaStorePort {
  const ops: ReplicaFileOps = { ...NODE_OPS, ...options.ops };
  const wait =
    options.wait ?? ((ms: number) => delay(ms).then(() => undefined));
  const maxBytes = options.maxBytes ?? FORGET_LEDGER_REPLICA_MAX_BYTES;
  const maxSetAside =
    options.maxSetAside ?? FORGET_LEDGER_REPLICA_MAX_SET_ASIDE;
  const path = options.path;
  const directory = dirname(path);

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

  // 一時ファイルを保存先へ rename する（失敗したら一時ファイルと、この置き換えで作った退避を消す。rename の前なので、
  // 退避と同じ中身は保存先に残っている）。
  const commit = async (
    temporary: string,
    madeAside: string | null = null,
  ): Promise<void> => {
    try {
      await options.beforeRename?.();
      await retrying(() => ops.rename(temporary, path), wait);
    } catch (error) {
      await removeQuietly(temporary);
      if (madeAside !== null) await removeQuietly(madeAside);
      throw error;
    }
    await options.afterRename?.();
    await fsyncDirectory(directory);
  };

  // 今のファイルを消さずに aside に残す。ファイルが無ければ false。ハードリンク（中身を写さない）を先に試し、
  // できなければ写しを作って fsync する。どちらもできなければ例外（置き換えを諦める）。
  const setAside = async (aside: string): Promise<boolean> => {
    try {
      await ops.link(path, aside);
    } catch (linkError) {
      if (errorCode(linkError) === 'ENOENT') return false;
      try {
        await retrying(
          () => ops.copyFile(path, aside, constants.COPYFILE_EXCL),
          wait,
        );
        await fsyncFile(aside);
      } catch (copyError) {
        const code = errorCode(copyError);
        if (code === 'ENOENT') return false;
        // 途中まで書いた写しを残さない（同じ名前のほかのファイルは消さない）。
        if (code !== 'EEXIST') await removeQuietly(aside);
        throw copyError;
      }
    }
    await fsyncDirectory(directory);
    return true;
  };

  const currentExists = async (): Promise<boolean> => {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  };

  return {
    load: () =>
      loadReplicaFile(path, options.valid, {
        maxBytes,
        openRead: ops.openRead,
      }),
    save: async (chain): Promise<LedgerReplicaWriteResult> => {
      const text = build(chain);
      if (Buffer.byteLength(text, 'utf8') > maxBytes) return 'too_large';
      await commit(await writeTemporary(directory, text));
      return 'saved';
    },
    replace: async (chain): Promise<LedgerReplicaWriteResult> => {
      const text = build(chain);
      if (Buffer.byteLength(text, 'utf8') > maxBytes) return 'too_large';
      // 退避が上限に達していて、退避するファイルがある: 新しく退避せず、置き換えもしない。
      const names = await readdir(directory);
      if (
        names.filter(isAsideName).length >= maxSetAside &&
        (await currentExists())
      )
        return 'set_aside_limit';
      const temporary = await writeTemporary(directory, text);
      const aside = join(
        directory,
        `${ASIDE_PREFIX}${randomUUID()}${ASIDE_SUFFIX}`,
      );
      let madeAside: boolean;
      try {
        madeAside = await setAside(aside);
      } catch (error) {
        // 退避できなければ置き換えを諦める（今のファイルはそのまま）。
        await removeQuietly(temporary);
        throw error;
      }
      await commit(temporary, madeAside ? aside : null);
      return 'saved';
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
