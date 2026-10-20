// ウィンドウ・トレイ・画面の読み込み・遷移・送信元の判断（設計 02・10 §1、01 停止・終了、ADR 0014・0015）。
// Electron のアダプターはここで決めた結果に従って BrowserWindow・Tray・protocol を操作する。
// Electron に依存しない（node:test で試験する）。
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { DesktopStatusBar } from '@buddy/contracts';

// UI レンダラーはこのスキームのローカルの画面だけを表示する（file:// と外部ページを使わない）。
export const APP_SCHEME = 'buddy';
export const APP_HOST = 'app';
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

// UI レンダラーの Content-Security-Policy。スクリプト・スタイルは同じスキームのファイルだけで、
// インラインのスクリプト・eval・外部への接続・埋め込み・フォーム送信を許さない。
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === `${APP_SCHEME}:` &&
      parsed.host === APP_HOST &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

// アプリのスキームの要求を、ビルド済みの画面のディレクトリの中のファイルに対応づける。
// ディレクトリの外・隠しファイル・想定外の種類・符号化した区切り文字は null（読み込まない）。
export function resolveAppAsset(
  rootDir: string,
  requestUrl: string,
): { readonly path: string; readonly contentType: string } | null {
  if (!isAppUrl(requestUrl)) return null;
  const pathname = new URL(requestUrl).pathname;
  const raw = pathname === '/' ? ['index.html'] : pathname.slice(1).split('/');
  const segments: string[] = [];
  for (const encoded of raw) {
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    if (segment === '' || segment.startsWith('.') || /[\\/:\0]/u.test(segment))
      return null;
    segments.push(segment);
  }
  const last = segments.at(-1);
  if (last === undefined) return null;
  const contentType = CONTENT_TYPES[extname(last).toLowerCase()];
  if (contentType === undefined) return null;
  const root = resolve(rootDir);
  const path = resolve(root, ...segments);
  const inside = relative(root, path);
  if (inside === '' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    return null;
  return { path, contentType };
}

// 新しいウィンドウはすべて拒否する。https のリンクだけを通常のブラウザーへ渡す（特権のある画面で外部ページを開かない）。
export function externalOpenTarget(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== ''
    )
      return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

// 画面内の遷移はアプリの画面だけを許す（外部ページへの遷移を拒否する）。
export function navigationAllowed(url: string): boolean {
  return isAppUrl(url);
}

export interface SenderFacts {
  // 要求を送った webContents の ID と、main が作った UI レンダラーの webContents の ID。
  readonly senderWebContentsId: number;
  readonly uiWebContentsId: number | null;
  // 送信元のフレームが UI レンダラーの主フレームか（子フレームでない）。フレームが破棄済みなら false。
  readonly senderIsMainFrame: boolean;
  // 送信元のフレームの URL（取得できなければ null）。
  readonly senderFrameUrl: string | null;
}

export function isTrustedSender(facts: SenderFacts): boolean {
  return (
    facts.uiWebContentsId !== null &&
    facts.senderWebContentsId === facts.uiWebContentsId &&
    facts.senderIsMainFrame &&
    facts.senderFrameUrl !== null &&
    isAppUrl(facts.senderFrameUrl)
  );
}

// ウィンドウを閉じる操作とクライアントの終了を区別する（02）。
// 終了の操作（トレイの「クライアントを終了」・desktop.client_quit・OS の終了要求）の後だけウィンドウを本当に閉じる。
// それ以外はウィンドウを隠してトレイに残る。どちらも端末の入出力の状態と中枢を変えない。
export class ClientLifecycle {
  #quitting = false;

  get quitting(): boolean {
    return this.#quitting;
  }

  requestQuit(): void {
    this.#quitting = true;
  }

  onWindowCloseRequested(): 'hide' | 'close' {
    return this.#quitting ? 'close' : 'hide';
  }

  // すべてのウィンドウが閉じてもトレイに残る（終了の操作のときは Electron が終了処理を続ける）。
  onAllWindowsClosed(): 'stay_in_tray' | 'quit' {
    return this.#quitting ? 'quit' : 'stay_in_tray';
  }
}

export type TrayAction = 'show_window' | 'io_stop' | 'client_quit';

export interface TrayMenuItem {
  readonly action: TrayAction;
  readonly label: string;
}

// トレイのメニュー。再開は画面操作だけなので置かない。中枢の停止はデスクトップから送らないので置かない。
export const TRAY_MENU: readonly TrayMenuItem[] = [
  { action: 'show_window', label: 'Buddy を表示' },
  { action: 'io_stop', label: 'この端末の入出力を停止' },
  { action: 'client_quit', label: 'クライアントを終了（中枢は止めません）' },
];

// トレイの説明文。ロック中・不明では内容を出さない。
export function trayTooltip(status: DesktopStatusBar): string {
  if (status.visibility === 'hidden')
    return status.lock_state === 'locked'
      ? 'Buddy（ロック中）'
      : 'Buddy（ロック状態を確認中）';
  return status.input_permitted
    ? 'Buddy（この端末の入出力: 受付中）'
    : 'Buddy（この端末の入出力: 停止中）';
}
