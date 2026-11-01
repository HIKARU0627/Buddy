// 音声の会話の操作の記号（B05-05、本人の方針: 説明は文字ではなく並びと形で伝える）。単色の線の SVG で、色は文字色に従う。
// 返し方は「声」（スピーカー）と「文字」（行）の 2 つ、操作は「読み上げの停止」（■）と「会話の終了」（×）。
// 読み上げは呼び出し側の名前で伝える（記号そのものは読み上げない）。
import type { ReactNode } from 'react';

export type VoiceControlIconKey =
  'reply_voice' | 'reply_text' | 'stop_playback' | 'end_conversation';

const PATHS: Readonly<Record<VoiceControlIconKey, ReactNode>> = {
  // 声で返す: スピーカーと音の波。
  reply_voice: (
    <>
      <path d="M2.5 6.5h2.5L8.5 3.5v9L5 9.5H2.5z" />
      <path d="M11 6a3 3 0 0 1 0 4M12.8 4.2a5.5 5.5 0 0 1 0 7.6" />
    </>
  ),
  // 文字で返す: 3 本の行。
  reply_text: (
    <>
      <path d="M3 4.5h10M3 8h10M3 11.5h6.5" />
    </>
  ),
  // 読み上げの停止: 塗らない四角（停止の記号と同じ形）。
  stop_playback: (
    <>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
    </>
  ),
  // 会話の終了: ×。
  end_conversation: (
    <>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </>
  ),
};

export function VoiceControlIcon({
  icon,
  className,
}: {
  readonly icon: VoiceControlIconKey;
  readonly className: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[icon]}
    </svg>
  );
}
