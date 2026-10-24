// 音声レンダラーの preload（設計 10 §1、B05-06、ADR 0050）。sandbox の中で動くため CommonJS で出力する。
// 公開するのは、main からの命令（6 つの限定 IPC）の受け取りと、ACK の返送と、開発の起動の故障の注入の指定だけ。
// 中枢・端末トークン・HTTP・任意の IPC は渡さない。命令の形・世代は音声レンダラーと main の両方で検査する。
import { contextBridge, ipcRenderer } from 'electron';

// main の voice-window.ts の VOICE_COMMAND_CHANNEL・VOICE_ACK_CHANNEL・VOICE_FAULT_ARG と同じ値
// （sandbox の preload は electron 以外を読み込めない。一致は main の試験で確かめる）。
const COMMAND_CHANNEL = 'voice.command';
const ACK_CHANNEL = 'voice.ack';
const FAULT_ARG = '--buddy-voice-fault=';

declare const process: { readonly argv?: readonly string[] } | undefined;

function faults(): string | null {
  const argv = typeof process === 'undefined' ? [] : (process.argv ?? []);
  const given = argv
    .filter((arg) => arg.startsWith(FAULT_ARG))
    .map((arg) => arg.slice(FAULT_ARG.length));
  const [value] = given;
  return given.length === 1 &&
    value !== undefined &&
    /^[a-z0-9_.,:=]+$/u.test(value)
    ? value
    : null;
}

// 命令の本体だけを渡し、Electron のイベントオブジェクト（送信元の情報）を渡さない。
function onCommand(listener: (request: unknown) => void): () => void {
  if (typeof listener !== 'function') throw new Error('voice_listener');
  const forward = (_event: unknown, request: unknown) => listener(request);
  ipcRenderer.on(COMMAND_CHANNEL, forward);
  return () => ipcRenderer.removeListener(COMMAND_CHANNEL, forward);
}

function ack(value: unknown): void {
  ipcRenderer.send(ACK_CHANNEL, value);
}

contextBridge.exposeInMainWorld('buddyVoice', {
  faults: faults(),
  onCommand,
  ack,
});
