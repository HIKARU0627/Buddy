// 実際の時計・タイマー・乱数・request_id（@buddy/client の ClientClock の実装、ADR 0025）。
// Electron に依存しない。試験は模擬の時計か、この時計を短い間隔の設定と組み合わせて使う。
import { randomUUID } from 'node:crypto';
import type { ClientClock } from '@buddy/client';

export function systemClock(): ClientClock {
  return {
    now: () => Date.now(),
    setTimer(ms, run) {
      const timer = setTimeout(run, ms);
      // タイマーだけでプロセス（試験）を生かし続けない。
      timer.unref();
      return () => clearTimeout(timer);
    },
    random: () => Math.random(),
    newRequestId: () => randomUUID(),
  };
}

// process.platform を契約の DevicePlatform にする。
export function devicePlatformOf(
  platform: NodeJS.Platform,
): 'macos' | 'windows' | 'linux' {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}
