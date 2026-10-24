// 音声レンダラーの隔離（設計 10 §1、B05-06、ADR 0050）。Electron に依存しない（node:test で試験する）。
// 音声レンダラーは隠した BrowserWindow 1 枚で、sandbox・contextIsolation・ローカルの HTML だけを読み込む。
// - 専用のスキーム（buddy-voice://renderer/）と、保存しない専用のセッション（partition）を使う。UI レンダラーのスキーム
//   （buddy://app/）は、このセッションに登録しないので読めない。
// - このセッションの通信は、音声レンダラーの入口とビルド済みのファイルだけを許し、ほかの要求（http・https・ws・wss・file・
//   data・blob・UI のスキーム・別のホスト）はすべて拒否する（session.webRequest）。CSP でも接続先を持たせない。
// - 権限（マイク・カメラ・通知など）はすべて拒否する。この作業の音声レンダラーは模擬で、マイクを使わない（合成の PCM）。
//   実際のマイクを持たせる作業で、入出力の許可が有効な間の音声だけの許可を足す（ADR 0050 の残り）。
// - 中枢・端末トークン・OpenAI の資格情報を持たせない。preload は 6 つの命令の受け取りと ACK の返送だけを公開する。
// WebRTC の通信は session.webRequest の対象外（原本 10 §1 は「WebRTC 以外の通信を持たせない」）。この作業の模擬は
// WebRTC を使わない。実際の Live の接続を作る作業で、接続先を確かめる方法を足す（ADR 0050 の残り）。
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

export const VOICE_SCHEME = 'buddy-voice';
export const VOICE_HOST = 'renderer';
export const VOICE_ENTRY_URL = `${VOICE_SCHEME}://${VOICE_HOST}/voice.html`;
// 保存しないセッション（persist: を付けない。Cookie・キャッシュ・権限の記録をディスクに残さない）。
export const VOICE_PARTITION = 'buddy-voice-renderer';
// main → 音声レンダラーの命令と、音声レンダラー → main の ACK の Electron の IPC のチャネル。
export const VOICE_COMMAND_CHANNEL = 'voice.command';
export const VOICE_ACK_CHANNEL = 'voice.ack';
// 模擬のレンダラーの故障の注入（開発の起動だけ）を preload へ渡す引数。
export const VOICE_FAULT_ARG = '--buddy-voice-fault=';

// 音声レンダラーの CSP。スクリプトは同じスキームのファイルだけで、接続・メディア・埋め込み・ワーカーを持たせない。
// 模擬は音を出さない（効果音は記録だけ）ので media-src も 'none'。
export const VOICE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'none'",
  "img-src 'none'",
  "font-src 'none'",
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
};

function voiceUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${VOICE_SCHEME}:` &&
      parsed.host === VOICE_HOST &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === ''
      ? parsed
      : null;
  } catch {
    return null;
  }
}

// 音声レンダラーのスキームの要求を、ビルド済みの音声レンダラーのディレクトリの中のファイルに対応づける。
// ディレクトリの外・隠しファイル・HTML と JS 以外・符号化した区切り文字・問い合わせ（?）・断片（#）は null。
export function resolveVoiceAsset(
  rootDir: string,
  requestUrl: string,
): { readonly path: string; readonly contentType: string } | null {
  const parsed = voiceUrl(requestUrl);
  if (parsed === null) return null;
  const raw = parsed.pathname.slice(1).split('/');
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

// 音声レンダラーのセッションで通してよい要求か（session.webRequest の onBeforeRequest で使う）。
// 音声レンダラーのスキームの HTML・JS だけ。ほかはすべて拒否する。
export function voiceRequestAllowed(url: string): boolean {
  const parsed = voiceUrl(url);
  if (parsed === null) return false;
  const last = parsed.pathname.split('/').at(-1) ?? '';
  return CONTENT_TYPES[extname(last).toLowerCase()] !== undefined;
}

// 画面内の遷移は許さない（最初の読み込みは loadURL で、遷移の判定を通らない）。
export function voiceNavigationAllowed(url: string): boolean {
  void url;
  return false;
}

// 権限の要求・確認はすべて拒否する（模擬はマイクを使わない）。
export function voicePermissionAllowed(permission: string): boolean {
  void permission;
  return false;
}

// 送信元が音声レンダラーの主フレームか（ACK を受け取ってよいか）。webContents の ID が今の音声レンダラーと同じで、
// 主フレームで、URL が音声レンダラーのスキームのときだけ。
export interface VoiceSenderFacts {
  readonly senderWebContentsId: number;
  readonly voiceWebContentsId: number | null;
  readonly senderIsMainFrame: boolean;
  readonly senderFrameUrl: string | null;
}

export function isVoiceSender(facts: VoiceSenderFacts): boolean {
  return (
    facts.voiceWebContentsId !== null &&
    facts.senderWebContentsId === facts.voiceWebContentsId &&
    facts.senderIsMainFrame &&
    facts.senderFrameUrl !== null &&
    voiceUrl(facts.senderFrameUrl) !== null
  );
}

export interface VoiceWebPreferences {
  readonly preload: string;
  readonly partition: string;
  readonly sandbox: true;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly nodeIntegrationInWorker: false;
  readonly nodeIntegrationInSubFrames: false;
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly experimentalFeatures: false;
  readonly webviewTag: false;
  readonly spellcheck: false;
  readonly devTools: boolean;
  // 隠した窓でもタイマーを間引かない（停止の ACK を遅らせない）。
  readonly backgroundThrottling: false;
  readonly additionalArguments: readonly string[];
}

export interface VoiceWindowOptions {
  readonly show: false;
  readonly width: number;
  readonly height: number;
  readonly frame: false;
  readonly focusable: false;
  readonly skipTaskbar: true;
  readonly resizable: false;
  readonly movable: false;
  readonly minimizable: false;
  readonly maximizable: false;
  readonly fullscreenable: false;
  readonly title: string;
  readonly webPreferences: VoiceWebPreferences;
}

// 隠した音声レンダラーの窓の作り方。表示しない・前面を取らない・タスクバーに出さない。開発者ツールは開発の起動だけ。
export function voiceWindowOptions(
  preload: string,
  launch: { readonly packaged: boolean; readonly fault: string | null },
): VoiceWindowOptions {
  return {
    show: false,
    width: 320,
    height: 240,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Buddy voice',
    webPreferences: {
      preload,
      partition: VOICE_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !launch.packaged,
      backgroundThrottling: false,
      additionalArguments:
        launch.packaged || launch.fault === null
          ? []
          : [`${VOICE_FAULT_ARG}${launch.fault}`],
    },
  };
}

// 音声の組み立て（開発用のフラグ）。--buddy-voice=mock（または BUDDY_DESKTOP_VOICE=mock）で、模擬のレンダラーと、
// 端末の中だけで答える模擬の中枢（リースと Live の接続）を使う。配布版（packaged）と既定は off（音声レンダラーを作らない）。
// 故障の注入 --buddy-voice-fault=<指定>（または BUDDY_DESKTOP_VOICE_FAULT）も開発の起動だけで受ける。
export const VOICE_MODE_FLAG = '--buddy-voice=';
export const VOICE_MODE_ENV = 'BUDDY_DESKTOP_VOICE';
export const VOICE_FAULT_FLAG = '--buddy-voice-fault=';
export const VOICE_FAULT_ENV = 'BUDDY_DESKTOP_VOICE_FAULT';

export type VoiceMode = 'off' | 'mock';

const lastFlag = (argv: readonly string[], flag: string): string | undefined =>
  argv
    .filter((arg) => arg.startsWith(flag))
    .map((arg) => arg.slice(flag.length))
    .at(-1);

export function voiceMode(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  launch: { readonly packaged: boolean },
): VoiceMode {
  if (launch.packaged) return 'off';
  return (lastFlag(argv, VOICE_MODE_FLAG) ?? env[VOICE_MODE_ENV]) === 'mock'
    ? 'mock'
    : 'off';
}

// 故障の注入の指定（形は voice-mock-renderer.ts の parseMockFaults が検査する）。開発の起動で、模擬のときだけ。
export function voiceFaultSpec(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  launch: { readonly packaged: boolean },
): string | null {
  if (launch.packaged) return null;
  const value = lastFlag(argv, VOICE_FAULT_FLAG) ?? env[VOICE_FAULT_ENV];
  return value === undefined || value === '' || !/^[a-z0-9_.,:=]+$/u.test(value)
    ? null
    : value;
}
