// 家計の記録の CSV を、本人が選んだ場所へ書く（ADR 0172）。Electron に依存しない（node:test で試験する）。
//
// - 書き出した CSV は金額・店名・メモを平文で含む。書くのは本人が保存先の選択で選んだパスだけで、一時ファイル・ログ・
//   画面の記憶域へは出さない。パスもログへ出さない。
// - 新しく作るファイルの権限は本人だけ（0600）。すでにあるファイルを本人が上書きすると選んだときは、その権限を変えない。
// - 書けなかったとき（容量不足・権限・書き込みの途中の失敗）は、書きかけのファイルを消す（欠けたファイルを残さない）。
//   消せなかったときも失敗として返す。

export interface HouseholdExportFileSystem {
  readonly writeFile: (
    path: string,
    text: string,
    options: {
      readonly encoding: 'utf8';
      readonly mode: number;
      readonly flag: 'w';
    },
  ) => Promise<void>;
  readonly rm: (
    path: string,
    options: { readonly force: true },
  ) => Promise<void>;
}

export async function writeHouseholdExportFile(
  path: string,
  text: string,
  fileSystem: HouseholdExportFileSystem,
): Promise<'saved' | 'failed'> {
  try {
    await fileSystem.writeFile(path, text, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'w',
    });
    return 'saved';
  } catch {
    try {
      await fileSystem.rm(path, { force: true });
    } catch {
      // 消せなかった。失敗として返す。
    }
    return 'failed';
  }
}
