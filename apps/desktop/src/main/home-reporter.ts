// 自宅の指紋の定期報告（設計 11 §10、ADR 0022・0025）。
//
// - 5 分ごと（中枢は受け取りから 6 分の間だけ使う）と、ネットワークが変わったとき（接続口のアドレスの変化を
//   15 秒ごとに確かめる）・スリープからの復帰のときに、指紋を集めて POST /v1/home-network/reports で送る。
// - 指紋の値（MAC・サブネット・SSID）はこの報告の本文にだけ入れ、ログ・画面・IPC に出さない。画面へは
//   中枢の判定（許可・免除・診断の理由）だけを渡す。
// - 契約の形に合わない要素は null にして送る（推測で埋めない）。
// Electron に依存しない。収集（@buddy/platform の指紋の収集）・送信・時計は注入する。

import type { HomeFingerprint, HomeNetworkStatus } from '@buddy/contracts';
import type { ClientApiOutcome } from '@buddy/client';

export const HOME_REPORT_INTERVAL_MS = 5 * 60_000;
export const NETWORK_WATCH_INTERVAL_MS = 15_000;

export interface HomeObservation {
  readonly gateway_mac: string | null;
  readonly subnet: string | null;
  readonly ssid: string | null;
}

export interface HomeReportResult {
  readonly status: HomeNetworkStatus;
  readonly reportedAt: number;
}

export interface HomeReporterOptions {
  readonly collect: () => Promise<HomeObservation>;
  readonly send: (body: Record<string, unknown>) => Promise<ClientApiOutcome>;
  readonly valid: (name: string, value: unknown) => boolean;
  // 接続口の状態を表す値（変化だけを見る。値は保存・出力しない）。
  readonly networkSignature: () => string;
  readonly now: () => number;
  readonly setTimer: (ms: number, run: () => void) => () => void;
  readonly newRequestId: () => string;
  readonly onResult: (result: HomeReportResult) => void;
  readonly intervalMs?: number;
  readonly watchIntervalMs?: number;
  readonly log?: (code: string) => void;
}

// 契約の各要素の形に合わない値は null にする。
export function sanitizeFingerprint(
  observation: HomeObservation,
  valid: (name: string, value: unknown) => boolean,
): HomeFingerprint {
  const pick = (name: string, value: string | null) =>
    value !== null && valid(name, value) ? value : null;
  return {
    gateway_mac: pick('MacAddress', observation.gateway_mac),
    subnet: pick('HomeSubnet', observation.subnet),
    ssid: pick('WifiSsid', observation.ssid),
  };
}

export class HomeReporter {
  readonly #options: HomeReporterOptions;
  #running = false;
  #reportTimer: (() => void) | null = null;
  #watchTimer: (() => void) | null = null;
  #signature: string | null = null;
  #inFlight: Promise<void> | null = null;
  #again = false;

  constructor(options: HomeReporterOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#signature = this.#readSignature();
    this.reportNow('start');
    this.#scheduleWatch();
  }

  stop(): void {
    this.#running = false;
    this.#reportTimer?.();
    this.#reportTimer = null;
    this.#watchTimer?.();
    this.#watchTimer = null;
  }

  // すぐに報告する（ネットワークの変化・スリープからの復帰・自宅の外で拒否された後）。報告中なら終わってからもう一度。
  reportNow(reason: string): void {
    if (!this.#running) return;
    this.#options.log?.(`home_report:${reason}`);
    if (this.#inFlight !== null) {
      this.#again = true;
      return;
    }
    this.#reportTimer?.();
    this.#reportTimer = null;
    this.#inFlight = this.#report().finally(() => {
      this.#inFlight = null;
      if (!this.#running) return;
      if (this.#again) {
        this.#again = false;
        this.reportNow('queued');
        return;
      }
      this.#reportTimer = this.#options.setTimer(
        this.#options.intervalMs ?? HOME_REPORT_INTERVAL_MS,
        () => {
          this.#reportTimer = null;
          this.reportNow('interval');
        },
      );
    });
  }

  // 試験用: 進行中の報告が終わるまで待つ。
  async idle(): Promise<void> {
    while (this.#inFlight !== null) await this.#inFlight;
  }

  async #report(): Promise<void> {
    let observation: HomeObservation;
    try {
      observation = await this.#options.collect();
    } catch {
      observation = { gateway_mac: null, subnet: null, ssid: null };
    }
    if (!this.#running) return;
    const outcome = await this.#options.send({
      request_id: this.#options.newRequestId(),
      fingerprint: sanitizeFingerprint(observation, this.#options.valid),
    });
    if (!this.#running) return;
    if (
      outcome.kind === 'response' &&
      outcome.status === 200 &&
      this.#options.valid('HomeNetworkStatus', outcome.body)
    ) {
      this.#options.onResult({
        status: outcome.body as HomeNetworkStatus,
        reportedAt: this.#options.now(),
      });
      return;
    }
    this.#options.log?.(
      outcome.kind === 'response'
        ? `home_report_rejected:${outcome.status}`
        : `home_report_failed:${outcome.kind}`,
    );
  }

  #scheduleWatch(): void {
    this.#watchTimer = this.#options.setTimer(
      this.#options.watchIntervalMs ?? NETWORK_WATCH_INTERVAL_MS,
      () => {
        this.#watchTimer = null;
        if (!this.#running) return;
        const next = this.#readSignature();
        if (next !== this.#signature) {
          this.#signature = next;
          this.reportNow('network_changed');
        }
        this.#scheduleWatch();
      },
    );
  }

  #readSignature(): string {
    try {
      return this.#options.networkSignature();
    } catch {
      return 'unavailable';
    }
  }
}

// os.networkInterfaces() の形から、接続口の変化を見るための値を作る（ループバックを除く）。
export function networkSignatureOf(
  interfaces: Readonly<
    Record<
      string,
      | readonly {
          readonly address: string;
          readonly netmask: string;
          readonly family: string;
          readonly internal: boolean;
        }[]
      | undefined
    >
  >,
): string {
  const entries: string[] = [];
  for (const [name, addresses] of Object.entries(interfaces))
    for (const address of addresses ?? [])
      if (!address.internal)
        entries.push(
          `${name}|${address.family}|${address.address}|${address.netmask}`,
        );
  return entries.sort().join(';');
}
