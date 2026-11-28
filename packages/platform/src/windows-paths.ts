// Windows のコマンドの絶対パスを環境変数から作る（ADR 0022 のレビューの指摘 L9、ADR 0203）。
//
// PowerShell・netsh・schtasks・whoami・powercfg は %SystemRoot%\System32 の絶対パスで呼ぶ。名前だけで呼ぶと、
// Windows の実行ファイルの探し方（カレントディレクトリを PATH より先に探す）で、同じ名前の別の実行ファイルを
// 使い得るため。SystemRoot が取れない・形が違うときは PATH から探さず、呼べない扱いにする。
// 環境変数の値（ユーザー名を含み得るパス）はログ・理由に入れない。
import { win32 } from 'node:path';

// ドライブ文字から始まる絶対パス（例 C:\Windows・C:\Program Files）。相対・UNC・`.`・`..`・使えない文字は不可。
// `%` は Task Scheduler などが環境変数として展開するので、ここでも受け付けない。
const DRIVE_ABSOLUTE = /^[A-Za-z]:\\(?:[^\\/:*?"<>|%\r\n]+\\?)*$/u;

// ドライブ文字から始まる正規化した絶対パスのディレクトリか（末尾の \ は 1 つまで許す）。
export function isWindowsDriveAbsolute(value: string | undefined): boolean {
  if (value === undefined || !DRIVE_ABSOLUTE.test(value)) return false;
  if (/\p{Cc}/u.test(value)) return false;
  return !value.split('\\').some((part) => part === '..' || part === '.');
}

// %SystemRoot%\System32。使えない値なら null。
export function windowsSystem32(systemRoot: string | undefined): string | null {
  if (!isWindowsDriveAbsolute(systemRoot)) return null;
  return win32.join(systemRoot as string, 'System32');
}

// Windows PowerShell 5.1（どの Windows 10・11 にもある）の絶対パス。
export function windowsPowerShellPath(system32: string): string {
  return win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// PowerShell に固定のスクリプトを渡す引数。プロファイルを読まず、対話しない。
// スクリプトは定数か、検査した値だけから作る（外から受け取った文字列を埋め込まない）。
export function powerShellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', script];
}
