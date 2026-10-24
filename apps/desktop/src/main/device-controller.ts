// main の端末状態（ロック・この端末の停止・io_epoch）と限定 IPC の受付（設計 10 §1・§1A、07 §2・§5、01、ADR 0014・0015）。
// 受付の順: 形式（Ajv の DesktopIpcRequest）→ 規則（domain の admitDesktopRequest）→ 状態遷移（nextDesktopIoState）
// → 保存 → 送る前の検査（応答・通知の schema と意味）。
// Electron に依存しない。Electron のアダプターが送信元の判定・ウィンドウの状態・OS のイベントを渡す。
import type {
  DesktopIpcChannel,
  DesktopIpcNotification,
  DesktopIpcResponse,
  DesktopStatusBar,
} from '@buddy/contracts';
import {
  DESKTOP_IPC_CHANNELS,
  admitDesktopRequest,
  nextDesktopIoState,
  type DesktopIoEvent,
  type DesktopIoState,
  type DesktopIpcRejectReason,
  type DesktopIpcSender,
  type DesktopPowerEvent,
} from '@buddy/domain';
import type { DesktopContract } from './contract.js';
import type { DeviceIoRecord } from './device-io-store.js';
import { NOT_CONNECTED_HUB, NO_VOICE, buildStatusBar } from './status-bar.js';
import type { StatusBarHub, StatusBarVoice } from './status-bar.js';

export type PowerEventNotification = Extract<
  DesktopIpcNotification,
  { channel: 'desktop.power_event' }
>;

// summon_canvas: デスクトップの層のキャンバスを前に出す（UI-02。前に出す・戻すの状態は canvas-presence が持つ）。
// status_panel_open・status_panel_close: 状態の層のパネルを出す・しまう（UI-04。状態は status-panel が持つ）。
export type DesktopEffect =
  | 'none'
  | 'hide_window'
  | 'quit'
  | 'summon_canvas'
  | 'status_panel_open'
  | 'status_panel_close';

export interface DesktopIpcOutcome {
  readonly response: DesktopIpcResponse;
  // 応答を返した後にアダプターが行う操作。入出力の状態は変えない。
  readonly effect: DesktopEffect;
}

export interface DesktopDeviceControllerOptions {
  readonly contract: DesktopContract;
  // 前回保存した io_epoch と停止の範囲。
  readonly initial: DeviceIoRecord;
  readonly now: () => Date;
  // io_epoch か停止の範囲が変わったときに同期で保存する。例外は onPersistError へ渡し、状態の変更は戻さない。
  readonly persist: (record: DeviceIoRecord) => void;
  readonly onNotification: (notification: DesktopIpcNotification) => void;
  readonly onPersistError?: (error: unknown) => void;
  // 電源・ロックの記録を保持する件数（古いものから捨てる）。
  readonly powerLogLimit?: number;
}

export class DesktopContractError extends Error {
  constructor(readonly codes: readonly string[]) {
    super(`desktop_contract_violation:${codes.join(',')}`);
    this.name = 'DesktopContractError';
  }
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const isChannel = (value: unknown): value is DesktopIpcChannel =>
  typeof value === 'string' &&
  (DESKTOP_IPC_CHANNELS as readonly string[]).includes(value);

export class DesktopDeviceController {
  readonly #options: DesktopDeviceControllerOptions;
  #state: DesktopIoState;
  #status: DesktopStatusBar;
  #hub: StatusBarHub = NOT_CONNECTED_HUB;
  #voice: StatusBarVoice = NO_VOICE;
  readonly #powerLog: PowerEventNotification[] = [];

  constructor(options: DesktopDeviceControllerOptions) {
    this.#options = options;
    // 起動直後はロック状態を unknown とし、OS で解除を確かめるまで入出力を許可しない（ADR 0015 の決定 1）。
    this.#state = {
      lockState: 'unknown',
      stopScope: options.initial.stop_scope,
      ioEpoch: options.initial.io_epoch,
    };
    this.#status = this.#checkedStatus();
  }

  get state(): DesktopIoState {
    return this.#state;
  }

  get statusBar(): DesktopStatusBar {
    return this.#status;
  }

  get powerLog(): readonly PowerEventNotification[] {
    return [...this.#powerLog];
  }

  // UI レンダラーからの要求。ipcChannel は Electron の IPC のチャネル名で、要求の channel と一致しなければ拒否する。
  handleIpc(
    ipcChannel: string,
    raw: unknown,
    sender: DesktopIpcSender,
  ): DesktopIpcOutcome {
    if (!this.#options.contract.isRequest(raw) || raw.channel !== ipcChannel)
      return this.#reject(
        this.#echoRequestId(raw),
        this.#echoChannel(raw, ipcChannel),
        'invalid_request',
      );
    const expected =
      raw.channel === 'desktop.io_resume'
        ? raw.payload.expected_io_epoch
        : null;
    const admission = admitDesktopRequest(
      raw.channel,
      expected,
      this.#state,
      sender,
    );
    if (!admission.ok)
      return this.#reject(raw.request_id, raw.channel, admission.reason);
    switch (raw.channel) {
      case 'desktop.get_state':
        return this.#respondWithStatus(raw.request_id, raw.channel);
      case 'desktop.io_stop':
        this.#apply({ kind: 'io_stop' });
        return this.#respondWithStatus(raw.request_id, raw.channel);
      case 'desktop.io_resume':
        this.#apply({ kind: 'io_resume' });
        return this.#respondWithStatus(raw.request_id, raw.channel);
      case 'desktop.window_hide':
        return this.#respond(
          { request_id: raw.request_id, channel: raw.channel, outcome: 'ok' },
          'hide_window',
        );
      case 'desktop.client_quit':
        return this.#respond(
          { request_id: raw.request_id, channel: raw.channel, outcome: 'ok' },
          'quit',
        );
      case 'desktop.canvas_summon':
        return this.#respond(
          { request_id: raw.request_id, channel: raw.channel, outcome: 'ok' },
          'summon_canvas',
        );
      case 'desktop.status_panel':
        return this.#respond(
          { request_id: raw.request_id, channel: raw.channel, outcome: 'ok' },
          raw.payload.open ? 'status_panel_open' : 'status_panel_close',
        );
      default:
        // 接続・ペアリングのチャネルは core-link が受け付ける（ここへ渡さない。ADR 0025）。
        return this.#reject(raw.request_id, raw.channel, 'invalid_request');
    }
  }

  // OS からの電源・ロックの通知（powerMonitor）。記録してから規則どおりに状態を変える。
  recordOsEvent(event: DesktopPowerEvent): void {
    this.#record(event, 'os_event');
    this.#apply({ kind: 'power', event });
  }

  // OS への問い合わせの結果（lock-query.ts で読み替えたもの）。null は取得できなかったので何も変えない。
  // ロック状態が変わるときだけ記録する（同じ結果の繰り返しで記録を埋めない）。
  applyLockQuery(event: 'lock_screen' | 'unlock_screen' | null): boolean {
    if (event === null) return false;
    const lockState = event === 'lock_screen' ? 'locked' : 'unlocked';
    if (this.#state.lockState === lockState) return false;
    this.#record(event, 'os_query');
    this.#apply({ kind: 'power', event });
    return true;
  }

  // 中枢との接続の状態（core-link から。B03-05）。状態欄が変わるときだけ通知する。
  setHub(hub: StatusBarHub): void {
    if (
      hub.connection === this.#hub.connection &&
      hub.lastConfirmedAt === this.#hub.lastConfirmedAt &&
      (hub.budgetHeld ?? null) === (this.#hub.budgetHeld ?? null)
    )
      return;
    this.#hub = hub;
    this.#refreshStatus();
  }

  // 音声の状態（main の音声の制御から。B05-06）。状態欄が変わるときだけ通知する。
  setVoice(voice: StatusBarVoice): void {
    if (
      voice.enabled === this.#voice.enabled &&
      voice.state === this.#voice.state
    )
      return;
    this.#voice = voice;
    this.#refreshStatus();
  }

  // main の中の本人の操作（トレイの「入出力を停止」・全体の停止のショートカット。UI-04）からのこの端末の入出力停止。
  // いつでも受け付ける。画面の停止（desktop.io_stop）と同じ状態の遷移（io_stop）を通る。
  stopFromMain(): void {
    this.#apply({ kind: 'io_stop' });
  }

  #apply(event: DesktopIoEvent): void {
    const before = this.#state;
    const after = nextDesktopIoState(before, event);
    this.#state = after;
    const record = toRecord(after);
    if (record !== null && !sameRecord(record, toRecord(before)))
      try {
        this.#options.persist(record);
      } catch (error) {
        this.#options.onPersistError?.(error);
      }
    this.#refreshStatus();
  }

  #refreshStatus(): void {
    const status = this.#checkedStatus();
    if (JSON.stringify(status) === JSON.stringify(this.#status)) return;
    this.#status = status;
    this.#notify({ channel: 'desktop.state_changed', status });
  }

  #record(event: DesktopPowerEvent, source: 'os_event' | 'os_query'): void {
    const notification: PowerEventNotification = {
      channel: 'desktop.power_event',
      event,
      source,
      observed_at: this.#options.now().toISOString(),
    };
    this.#notify(notification);
    this.#powerLog.push(notification);
    const limit = this.#options.powerLogLimit ?? 100;
    if (this.#powerLog.length > limit)
      this.#powerLog.splice(0, this.#powerLog.length - limit);
  }

  #notify(notification: DesktopIpcNotification): void {
    const errors = this.#options.contract.notificationErrors(notification);
    if (errors.length > 0) throw new DesktopContractError(errors);
    this.#options.onNotification(notification);
  }

  #checkedStatus(): DesktopStatusBar {
    const status = buildStatusBar(this.#state, this.#hub, this.#voice);
    const errors = this.#options.contract.statusBarErrors(status);
    if (errors.length > 0) throw new DesktopContractError(errors);
    return status;
  }

  #respondWithStatus(
    requestId: string,
    channel: 'desktop.get_state' | 'desktop.io_stop' | 'desktop.io_resume',
  ): DesktopIpcOutcome {
    return this.#respond(
      { request_id: requestId, channel, outcome: 'ok', status: this.#status },
      'none',
    );
  }

  #reject(
    requestId: string | null,
    channel: DesktopIpcChannel | null,
    reason: DesktopIpcRejectReason,
  ): DesktopIpcOutcome {
    return this.#respond(
      { request_id: requestId, channel, outcome: 'rejected', reason },
      'none',
    );
  }

  #respond(
    response: DesktopIpcResponse,
    effect: DesktopEffect,
  ): DesktopIpcOutcome {
    const errors = this.#options.contract.responseErrors(response);
    if (errors.length > 0) throw new DesktopContractError(errors);
    return { response, effect };
  }

  // 形式が不正な要求でも、request_id が UUID v4 の文字列なら対応づけのために返す。確かめられなければ null。
  #echoRequestId(raw: unknown): string | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const id = (raw as Record<string, unknown>)['request_id'];
    return typeof id === 'string' && UUID_V4.test(id) ? id : null;
  }

  // チャネルは要求と Electron の IPC のチャネルが一致し、契約の一覧にあるときだけ返す。
  #echoChannel(raw: unknown, ipcChannel: string): DesktopIpcChannel | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const channel = (raw as Record<string, unknown>)['channel'];
    return isChannel(channel) && channel === ipcChannel ? channel : null;
  }
}

// 保存するのは none と local だけ（来客モード・全体停止は中枢が正本。B01 では起こらない）。
function toRecord(state: DesktopIoState): DeviceIoRecord | null {
  if (state.stopScope !== 'none' && state.stopScope !== 'local') return null;
  return { io_epoch: state.ioEpoch, stop_scope: state.stopScope };
}

function sameRecord(a: DeviceIoRecord, b: DeviceIoRecord | null): boolean {
  return (
    b !== null && a.io_epoch === b.io_epoch && a.stop_scope === b.stop_scope
  );
}
