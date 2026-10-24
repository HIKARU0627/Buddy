// 音声レンダラーの入口（設計 10 §1、B05-06、ADR 0050）。隠した窓の中で、sandbox・contextIsolation で動く。
// この作業では模擬のレンダラー（MockVoiceRenderer）だけを動かす。マイク・WebRTC・音の再生を使わず、合成の PCM を作る。
// Electron・Node.js の API を使わず、preload が公開した命令の受け取りと ACK の返送だけを使う。
import {
  MockVoiceRenderer,
  PCM_FRAME_MS,
  parseMockFaults,
  type MockAck,
} from '../main/voice-mock-renderer.js';

interface BuddyVoiceApi {
  readonly faults: string | null;
  onCommand(listener: (request: unknown) => void): () => void;
  ack(value: MockAck): void;
}

declare global {
  interface Window {
    readonly buddyVoice?: BuddyVoiceApi;
  }
}

const api = window.buddyVoice;
if (api !== undefined) {
  const renderer = new MockVoiceRenderer(
    {
      ack: (value) => api.ack(value),
      schedule: (ms, task) => {
        setTimeout(task, ms);
      },
      wallNow: () => new Date().toISOString(),
      // 故障の注入の「固まる」: 本当にイベントループを止める（main の ACK の期限と無応答の検知で強制終了される）。
      hang: () => {
        for (;;) {
          // 何もしない（固まる）。
        }
      },
    },
    parseMockFaults(api.faults),
  );
  api.onCommand((request) => renderer.receive(request));
  setInterval(() => renderer.tick(), PCM_FRAME_MS);
}
