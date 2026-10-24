// 音声の試験の道具（B05-06、ADR 0050）。手で進める時計と、模擬のレンダラー・端末状態・模擬の中枢をつないだ組み立て。
// Electron を起動しない。実際の音声・マイク・WebRTC・実 API は使わない（合成の PCM と模擬の値だけ）。
// 製品のコード（main.ts）からは読み込まない。
import type { DesktopIpcNotification } from '@buddy/contracts';
import type { AudioReason, LeaseRenewalResponseLike } from '@buddy/domain';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DesktopDeviceController } from './device-controller.js';
import type { DeviceIoRecord } from './device-io-store.js';
import { VoiceConsentStore, type LocalVoiceConsent } from './voice-consent.js';
import {
  VoiceController,
  type LiveOpenResult,
  type VoiceRendererPort,
} from './voice-controller.js';
import type {
  LeaseCoreContext,
  LeaseRenewalBody,
} from './voice-lease-keeper.js';
import {
  MockVoiceRenderer,
  NO_FAULTS,
  PCM_FRAME_MS,
  type MockAck,
  type MockFaults,
} from './voice-mock-renderer.js';

export const contract = createDesktopContract(loadContractSchema());

// 手で進める時計。単調時計（整数の ms）と壁時計は同じだけ進む（スリープ・時計の変更は試験が別に起こす）。
export class ManualVoiceClock {
  mono = 1_000;
  wall = Date.parse('2030-10-05T00:00:00.000Z');
  #seq = 0;
  #ids = 0;
  #timers: { at: number; seq: number; run: () => void; live: boolean }[] = [];

  setTimer = (ms: number, run: () => void): (() => void) => {
    const timer = {
      at: this.mono + ms,
      seq: (this.#seq += 1),
      run,
      live: true,
    };
    this.#timers.push(timer);
    return () => {
      timer.live = false;
    };
  };

  newId = (): string => {
    this.#ids += 1;
    const tail = this.#ids.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${tail}`;
  };

  // ms だけ進め、その間に来るタイマーを時刻の順に動かす。動かすたびに約束（Promise）の続きを流す。
  async advance(ms: number): Promise<void> {
    const end = this.mono + ms;
    await flush();
    for (;;) {
      const next = this.#timers
        .filter((timer) => timer.live && timer.at <= end)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (next === undefined) break;
      next.live = false;
      const step = next.at - this.mono;
      if (step > 0) {
        this.mono += step;
        this.wall += step;
      }
      next.run();
      await flush();
    }
    const rest = end - this.mono;
    if (rest > 0) {
      this.mono += rest;
      this.wall += rest;
    }
    this.#timers = this.#timers.filter((timer) => timer.live);
    await flush();
  }
}

// 約束の続き（マイクロタスク）を流し切る。
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

export interface HarnessOptions {
  // 作り直しの順に使う故障（足りなければ故障なし）。
  readonly faults?: readonly MockFaults[];
  // IPC の片道の遅延（ms）。
  readonly ipcMs?: number;
  // 音声レンダラーの読み込みにかかる時間（ms）。
  readonly loadMs?: number;
  readonly consent?: LocalVoiceConsent | null;
  // OS の確認ダイアログの答え（順に使う。足りなければ「やめる」）。
  readonly dialog?: readonly (boolean | 'not_shown')[];
  // OS の確認ダイアログが答えを返すまでの時間（ms）。
  readonly dialogMs?: number;
  // リースの更新の答え（既定は受け付ける）。null は結果不明。
  readonly renew?: (
    body: LeaseRenewalBody,
  ) => LeaseRenewalResponseLike | null | 'never';
  readonly renewMs?: number;
  readonly open?: () => LiveOpenResult;
  readonly openMs?: number;
  readonly coreConnected?: boolean;
  // 中枢へ閉じる要求（closeLive）が例外を投げる。
  readonly closeFails?: boolean;
  // 同意の記録の保存・消去に失敗する。
  readonly consentSaveFails?: boolean;
  readonly consentRemoveFails?: boolean;
  readonly enabled?: boolean;
  readonly initial?: DeviceIoRecord;
}

interface RendererSlot {
  readonly generation: number;
  readonly mock: MockVoiceRenderer;
  alive: boolean;
  ready: boolean;
}

// 端末状態（DesktopDeviceController）・音声の制御・模擬のレンダラー・模擬の中枢をつないだ組み立て。
export function voiceHarness(options: HarnessOptions = {}) {
  const clock = new ManualVoiceClock();
  const ipcMs = options.ipcMs ?? 1;
  const loadMs = options.loadMs ?? 5;
  const logs: string[] = [];
  const log = (code: string) => logs.push(code);
  const slots: RendererSlot[] = [];
  const sent: {
    generation: number;
    at: number;
    request: Record<string, unknown>;
  }[] = [];
  const acks: MockAck[] = [];
  const kills: number[] = [];
  const dialogs: number[] = [];
  const cancelled: number[] = [];
  const answers = [...(options.dialog ?? [])];
  const closed: { id: string; reason: AudioReason }[] = [];
  const renewals: LeaseRenewalBody[] = [];
  const opens: number[] = [];
  const notifications: DesktopIpcNotification[] = [];
  let consentRecord: LocalVoiceConsent | null = options.consent ?? null;
  let epoch = 0n;
  // 必ず代入する（下の DesktopDeviceController の通知から参照する）。
  let voice: VoiceController | null = null;

  const slot = (generation: number) =>
    slots.find((entry) => entry.generation === generation) ?? null;

  const renderer: VoiceRendererPort = {
    create(generation) {
      const faults = options.faults?.[generation - 1] ?? NO_FAULTS;
      const entry: RendererSlot = {
        generation,
        alive: true,
        ready: false,
        mock: new MockVoiceRenderer(
          {
            ack: (ack) => {
              acks.push(ack);
              clock.setTimer(ipcMs, () => {
                // 強制終了した音声レンダラーの送りかけの ACK は main に届かない（プロセスがない）。
                if (entry.alive) voice?.receiveAck(generation, ack);
              });
            },
            schedule: (ms, task) => {
              clock.setTimer(ms, () => {
                if (entry.alive) task();
              });
            },
            wallNow: () => new Date(clock.wall).toISOString(),
          },
          faults,
        ),
      };
      slots.push(entry);
      const tick = () => {
        if (!entry.alive) return;
        entry.mock.tick();
        clock.setTimer(PCM_FRAME_MS, tick);
      };
      clock.setTimer(PCM_FRAME_MS, tick);
      clock.setTimer(loadMs, () => {
        if (!entry.alive) return;
        entry.ready = true;
        voice?.rendererReady(generation);
      });
    },
    send(generation, request) {
      const entry = slot(generation);
      if (entry === null || !entry.alive) return false;
      sent.push({
        generation,
        at: clock.mono,
        request: structuredClone(request) as unknown as Record<string, unknown>,
      });
      clock.setTimer(ipcMs, () => {
        if (entry.alive) entry.mock.receive(structuredClone(request));
      });
      return true;
    },
    kill(generation) {
      kills.push(generation);
      const entry = slot(generation);
      if (entry !== null) entry.alive = false;
      // Electron は窓を壊すとその場で閉じた出来事を出す（main.ts の closed）。同じ順で届ける。
      voice?.rendererGone(generation, 'closed');
    },
  };

  const context: LeaseCoreContext = {
    deviceId: clock.newId(),
    coreInstanceId: clock.newId(),
    commandScopeId: clock.newId(),
  };
  const delayed = <T>(ms: number, value: () => T): Promise<T> =>
    new Promise((resolve) => clock.setTimer(ms, () => resolve(value())));

  const device = new DesktopDeviceController({
    contract,
    initial: options.initial ?? { io_epoch: '0', stop_scope: 'none' },
    now: () => new Date(clock.wall),
    persist: () => undefined,
    onNotification: (notification) => {
      notifications.push(notification);
      if (notification.channel === 'desktop.state_changed')
        voice?.deviceChanged(device.state);
    },
  });

  const consent = new VoiceConsentStore({
    load: () => consentRecord,
    save: (record) => {
      if (options.consentSaveFails === true) throw new Error('disk full');
      consentRecord = record;
    },
    remove: () => {
      if (options.consentRemoveFails === true) throw new Error('read only');
      consentRecord = null;
    },
    now: () => new Date(clock.wall).toISOString(),
    log,
  });

  const created = new VoiceController({
    enabled: options.enabled ?? true,
    contract,
    renderer,
    core: {
      context: () => (options.coreConnected === false ? null : context),
      renew: (body) => {
        renewals.push(body);
        const answer =
          // 答えを決めていなければ受け付ける。null（結果不明）は null のまま渡す（成功に変えない）。
          options.renew === undefined
            ? ({
                request_id: body.request_id,
                lease_id: body.lease_id,
                nonce: body.nonce,
                result: 'renewed',
                ttl_ms: body.ttl_ms,
              } as const)
            : options.renew(body);
        if (answer === 'never') return new Promise(() => undefined);
        return delayed(options.renewMs ?? 10, () => answer);
      },
      openLive: () => {
        opens.push(clock.mono);
        return delayed(options.openMs ?? 50, () => {
          if (options.open) return options.open();
          epoch += 1n;
          return {
            kind: 'answer',
            liveSessionId: clock.newId(),
            sdpAnswer: 'v=0\r\ns=buddy-test\r\n',
            audioEpoch: epoch.toString(),
            sessionEpoch: epoch.toString(),
          } as const;
        });
      },
      closeLive: (id, reason) => {
        if (options.closeFails === true) throw new Error('core link down');
        closed.push({ id, reason });
      },
    },
    clock: {
      mono: () => clock.mono,
      wall: () => clock.wall,
      setTimer: clock.setTimer,
      newId: clock.newId,
    },
    consent,
    confirmConsent: () => {
      dialogs.push(clock.mono);
      const answer = answers.shift() ?? false;
      return options.dialogMs === undefined
        ? Promise.resolve(answer)
        : delayed(options.dialogMs, () => answer);
    },
    cancelConsent: () => {
      cancelled.push(clock.mono);
    },
    stopDevice: () => device.stopFromMain(),
    onChange: () => {
      if (voice === null) return;
      device.setVoice({
        enabled: options.enabled ?? true,
        state: voice.statusVoice(),
      });
      const notification = {
        channel: 'desktop.voice_changed' as const,
        voice: voice.view(),
      };
      const errors = contract.notificationErrors(notification);
      if (errors.length > 0)
        throw new Error(`voice_notification_invalid:${errors.join(',')}`);
      notifications.push(notification);
    },
    log,
  });
  voice = created;
  created.deviceChanged(device.state);

  return {
    clock,
    voice: created,
    device,
    slots,
    sent,
    acks,
    kills,
    dialogs,
    cancelled,
    closed,
    renewals,
    opens,
    logs,
    notifications,
    consentRecord: () => consentRecord,
    slot,
    current: () => slots.at(-1) ?? null,
    sentChannels: () => sent.map((entry) => String(entry.request['channel'])),
    // OS への問い合わせでロック解除を確かめた（起動直後）。
    unlock: () => device.applyLockQuery('unlock_screen'),
  };
}
