// 家計の記録の CSV を、本人が選んだ場所へ書く（ADR 0172）。Electron に依存しない（node:test で試験する）。
//
// - 書き出した CSV は金額・店名・メモを平文で含む。書くのは本人が保存先の選択で選んだパスだけで、一時ファイル・ログ・
//   画面の記憶域へは出さない。パスもログへ出さない。
// - ファイルの権限は、新しく作ったときも、すでにあるファイルを本人が上書きすると選んだときも、本人だけ（0600）にする。
//   上書きのときは、中身を書く前に権限を 0600 へ変える（元の権限のまま平文を書かない）。Windows ではファイルの権限が
//   所有者・グループ・その他の三つ組ではなく ACL で決まり、chmod が変えられるのは読み取り専用の印だけである。そのため、
//   Windows では 0600 になることを保証せず、保存先のフォルダの ACL に従う（実機では未確認）。
// - 保存先がシンボリックリンクのときは、書かずに拒否する（リンク先の別のファイルを意図せず書き換えないため）。
// - 消してよいのは、この処理が新しく作ったファイルだけである。開けなかったとき（読み取り専用の既存のファイル・権限・
//   存在しないフォルダなど）は、何も作らず何も消さない。本人の元のファイルを消さない。すでにあるファイルを開いて
//   切り詰めた後に書けなかったときは、消さずにそのまま残す（ADR 0172）。
// - 書けなかった結果は、保存先がどうなったかで分ける（画面の文が事実と合うように）。

import { constants } from 'node:fs';

/** 開いたファイルの操作（node:fs/promises の FileHandle の一部）。 */
export interface HouseholdExportFileHandle {
  readonly chmod: (mode: number) => Promise<void>;
  readonly writeFile: (
    text: string,
    options: { readonly encoding: 'utf8' },
  ) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface HouseholdExportFileSystem {
  readonly lstat: (
    path: string,
  ) => Promise<{ readonly isSymbolicLink: () => boolean }>;
  readonly open: (
    path: string,
    flags: number,
    mode: number,
  ) => Promise<HouseholdExportFileHandle>;
  readonly rm: (
    path: string,
    options: { readonly force: true },
  ) => Promise<void>;
}

/**
 * 書いた結果。
 * - saved: 書けた。
 * - link_refused: 保存先がシンボリックリンクなので、何も書かなかった。
 * - failed_unchanged: 開けなかったので、何も作らず何も変えなかった（元のファイルはそのまま）。
 * - failed_removed: 新しく作ったファイルに書けなかったので、書きかけのファイルを消した。
 * - failed_left: 書きかけのファイルが残っているか、選んだファイルの中身が不完全になっているか、状態を確かめられない
 *   （新しく作ったファイルを消せなかった・すでにあるファイルを切り詰めた後に書けなかった）。
 */
export type HouseholdExportWriteResult =
  | 'saved'
  | 'link_refused'
  | 'failed_unchanged'
  | 'failed_removed'
  | 'failed_left';

export const HOUSEHOLD_EXPORT_FILE_MODE = 0o600;
// 新しく作る（すでにあれば EEXIST で失敗する。リンクもたどらない）。
export const CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
// すでにあるファイルを切り詰めて開く。リンクはたどらない（O_NOFOLLOW がない Windows では 0。lstat の確認だけに頼る）。
export const OVERWRITE_FLAGS =
  constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

export async function writeHouseholdExportFile(
  path: string,
  text: string,
  fileSystem: HouseholdExportFileSystem,
): Promise<HouseholdExportWriteResult> {
  try {
    if ((await fileSystem.lstat(path)).isSymbolicLink()) return 'link_refused';
  } catch (error) {
    // まだない（これから作る）なら進む。それ以外（権限・パスの誤りなど）は何もせず失敗にする。
    if (errorCode(error) !== 'ENOENT') return 'failed_unchanged';
  }
  let handle: HouseholdExportFileHandle;
  let created = true;
  try {
    handle = await fileSystem.open(
      path,
      CREATE_FLAGS,
      HOUSEHOLD_EXPORT_FILE_MODE,
    );
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') return 'failed_unchanged';
    // すでにあるファイル（本人が上書きすると選んだ）。開けなければ、何も消さずに失敗にする。
    try {
      handle = await fileSystem.open(
        path,
        OVERWRITE_FLAGS,
        HOUSEHOLD_EXPORT_FILE_MODE,
      );
      created = false;
    } catch (overwriteError) {
      // 開く前にリンクへ差し替えられたとき（O_NOFOLLOW による ELOOP）は拒否として扱う。
      return errorCode(overwriteError) === 'ELOOP'
        ? 'link_refused'
        : 'failed_unchanged';
    }
  }
  let written = false;
  try {
    // 中身を書く前に権限を本人だけにする（すでにあるファイルの元の権限のまま平文を書かない）。
    await handle.chmod(HOUSEHOLD_EXPORT_FILE_MODE);
    await handle.writeFile(text, { encoding: 'utf8' });
    written = true;
  } catch {
    // 下で後始末する。
  }
  let closed = true;
  try {
    await handle.close();
  } catch {
    closed = false;
  }
  if (written && closed) return 'saved';
  // ここまで来たら失敗。新しく作ったファイルだけ消す。すでにあったファイルは、元の中身がもう失われているが、
  // 本人のファイルなので消さずに残す。
  if (!created) return 'failed_left';
  try {
    await fileSystem.rm(path, { force: true });
    return 'failed_removed';
  } catch {
    return 'failed_left';
  }
}
