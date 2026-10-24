// リースの期限の計算と、世代（epoch）の発行・逆行の拒否の純粋な規則（B05-02、ADR 0041。設計 07 §5、10 §1A・§2A）。
// 時計は呼び出し側が読んで渡す（時計も乱数も内部で読まない）。端末・中枢・OS には依存しない。
// 期限は端末の単調時計で数える。端末の時計は中枢の時刻とは比べない（07 §5）。

import {
  applyLeaseResponse,
  type LeaseCurrentState,
  type LeaseRenewalResponseLike,
  type PendingLeaseRequest,
} from './voice.js';

// ---- 時計の読み取りと整合の検査 -----------------------------------------------------------------------------

// 同じ瞬間に読んだ 2 つの時計。単調時計はスリープで止まる・進むが実装によって違うので、壁時計との進みの差を見る。
export interface ClockReading {
  readonly mono_ms: number;
  readonly wall_ms: number;
}

// 単調時計と壁時計の進みの差の許容（ms）。原本に決めなし（07 §5 は「スリープ復帰・時計の不整合ではリースを捨てる」まで）。
// 仮の値で、T04・T07 の実測まで置く。NTP の小さな補正でリースを捨てすぎない広さにした。
export const LEASE_CLOCK_TOLERANCE_MS = 1000;

export type LeaseClockVerdict =
  'consistent' | 'mono_regressed' | 'skewed' | 'unavailable';

const readable = (reading: ClockReading | null): reading is ClockReading =>
  reading !== null &&
  Number.isFinite(reading.mono_ms) &&
  Number.isFinite(reading.wall_ms);

// since（リースの要求を送った時点）から now までの時計が、リースを持ち続けてよい整合か。
// - unavailable: 時計を読めない（状態取得不能。07 §5 はリースを捨てる）。
// - mono_regressed: 単調時計が戻った（あり得ない。時計の不整合）。
// - skewed: 壁時計と単調時計の進みの差が許容を超えた（スリープ復帰・壁時計の大きな変更）。壁時計が戻った場合も含む。
// 差がちょうど許容のときは整合とする（超えたときだけ捨てる）。
export function assessLeaseClock(
  since: ClockReading | null,
  now: ClockReading | null,
  toleranceMs: number = LEASE_CLOCK_TOLERANCE_MS,
): LeaseClockVerdict {
  if (!readable(since) || !readable(now)) return 'unavailable';
  const mono = now.mono_ms - since.mono_ms;
  const wall = now.wall_ms - since.wall_ms;
  if (mono < 0) return 'mono_regressed';
  return Math.abs(wall - mono) > toleranceMs ? 'skewed' : 'consistent';
}

const CLOCK_REASON: Readonly<
  Record<Exclude<LeaseClockVerdict, 'consistent'>, string>
> = {
  mono_regressed: 'mono_clock_regressed',
  skewed: 'sleep_or_clock_skew',
  unavailable: 'clock_unavailable',
};

// ---- 保持しているリースと期限の判定 ---------------------------------------------------------------------------

// 端末が持っているリース。期限は要求を送った時点の単調時計から数えた値（応答の受信時刻ではない）。
export interface HeldLease {
  readonly lease_id: string;
  readonly expires_at_mono_ms: number;
  // 期限を数えた起点の要求を送った時点の時計。以後の整合の検査の起点になる。
  readonly sent_at: ClockReading;
  // 直前の観測（前回の判定・更新を受けたときの時計）。単調時計がここより戻ったら、許容とは別に捨てる。
  readonly last_observed: ClockReading;
}

export type LeaseStatus =
  | { readonly status: 'valid'; readonly remaining_ms: number }
  | { readonly status: 'expired' }
  | { readonly status: 'discarded'; readonly reason: string };

export interface LeaseObservation {
  readonly status: LeaseStatus;
  // 次の観測に持ち越す状態。有効なときだけ（直前の観測を今の時計に更新）。失効・捨てたときは null。
  readonly held: HeldLease | null;
}

// リースを使ってよいかの観測。時計が整合していなければ期限を見る前に捨てる（時計を信用できないので延命しない）。
// 整合は、要求を送った時点からの進みの差（許容つき）に加えて、直前の観測からの単調時計の逆行（許容なし）も見る
// （要求の時点より後に 1ms でも戻れば、残り時間が増えるので捨てる）。期限ちょうどは失効。
// 呼び出し側は、有効なときに返る held を次の観測に渡す（状態を持つのは呼び出し側）。
export function observeLease(
  held: HeldLease | null,
  now: ClockReading | null,
  toleranceMs: number = LEASE_CLOCK_TOLERANCE_MS,
): LeaseObservation {
  const discard = (reason: string): LeaseObservation => ({
    status: { status: 'discarded', reason },
    held: null,
  });
  if (held === null) return discard('no_lease');
  const verdict = assessLeaseClock(held.sent_at, now, toleranceMs);
  if (verdict !== 'consistent') return discard(CLOCK_REASON[verdict]);
  const reading = now as ClockReading;
  if (reading.mono_ms < held.last_observed.mono_ms)
    return discard(CLOCK_REASON.mono_regressed);
  const remaining = held.expires_at_mono_ms - reading.mono_ms;
  return remaining > 0
    ? {
        status: { status: 'valid', remaining_ms: remaining },
        held: { ...held, last_observed: reading },
      }
    : { status: { status: 'expired' }, held: null };
}

// observeLease の判定だけ（状態を更新しない単発の判定）。リースを継続して見張る処理では使わない（同じ held で時計が戻った値を
// 続けて評価すると、残り時間が増えても検出できない）。継続して見張るときは observeLease が返す held を次の観測へ渡す。
export function evaluateLease(
  held: HeldLease | null,
  now: ClockReading | null,
  toleranceMs: number = LEASE_CLOCK_TOLERANCE_MS,
): LeaseStatus {
  return observeLease(held, now, toleranceMs).status;
}

// 端末が更新要求を送った時点の記録。applyLeaseResponse の pending に壁時計の読みを足したもの。
export interface LeaseSendRecord extends PendingLeaseRequest {
  readonly requested_at_wall_ms: number;
}

export interface LeaseRenewalOutcome {
  readonly held: HeldLease | null;
  readonly reasons: string[];
  readonly clock: LeaseClockVerdict;
}

// 応答を受けたときの判定。期限は要求を送った時点の単調時計に ttl を足した値で、応答の受信時刻から足し直さない。
// 時計が整合していなければ（スリープ復帰・時計の不整合・時計を読めない）延ばさず捨てる。
// 判定の中身（要求 ID・nonce・世代・期限切れ）は applyLeaseResponse と同じで、ここは時計の整合を足すだけ。
// 時計の整合は、要求を送った時点からの進み（許容つき）と、置き換える今のリースの直前の観測からの単調時計の逆行（許容なし）。
// 受理したリースの last_observed は応答を受けた時計で、直前の観測より戻ることはない。
export function acceptLeaseRenewal(
  pending: LeaseSendRecord | null,
  response: LeaseRenewalResponseLike,
  now: ClockReading | null,
  current: LeaseCurrentState,
  // 更新で置き換える今のリース。必須で、初回（置き換えるリースがない）だけ明示的に null を渡す。その直前の観測より応答の単調時計が戻っていれば、更新も拒否する
  // （旧い状態の観測と更新の適用を 1 つの遷移として検査する。拒否したときの旧いリースは、呼び出し側が捨てる）。
  previousHeld: HeldLease | null,
  toleranceMs: number = LEASE_CLOCK_TOLERANCE_MS,
): LeaseRenewalOutcome {
  // 省略（undefined）は、前の観測を渡し忘れた呼び出しなので、受理せず例外にする（null は「置き換えるリースがない」）。
  if ((previousHeld as HeldLease | null | undefined) === undefined)
    throw new TypeError(
      'acceptLeaseRenewal needs previousHeld (null for the first lease)',
    );
  const sentAt: ClockReading | null =
    pending === null
      ? null
      : {
          mono_ms: pending.requested_at_mono_ms,
          wall_ms: pending.requested_at_wall_ms,
        };
  let clock = assessLeaseClock(sentAt, now, toleranceMs);
  if (
    clock === 'consistent' &&
    previousHeld !== null &&
    (now as ClockReading).mono_ms < previousHeld.last_observed.mono_ms
  )
    clock = 'mono_regressed';
  const result = applyLeaseResponse(
    pending,
    response,
    now === null ? Number.NaN : now.mono_ms,
    clock === 'consistent',
    current,
  );
  if (result.expires_at_mono_ms === null || pending === null || sentAt === null)
    return {
      held: null,
      clock,
      reasons: result.reasons.flatMap((reason) =>
        reason === 'clock_inconsistent' && clock !== 'consistent'
          ? [reason, CLOCK_REASON[clock]]
          : [reason],
      ),
    };
  return {
    held: {
      lease_id: pending.lease_id,
      expires_at_mono_ms: result.expires_at_mono_ms,
      sent_at: sentAt,
      last_observed: now as ClockReading,
    },
    clock,
    reasons: [],
  };
}

// ---- 世代（epoch）の発行と逆行の拒否（ADR 0005、0038、0041） ----------------------------------------------------

// 世代は先頭ゼロのない非負整数の 10 進文字列（07 §1。JavaScript の数値精度に依存させない）。
const EPOCH_FORMAT = /^(?:0|[1-9][0-9]*)$/u;

export const isEpoch = (value: unknown): value is string =>
  typeof value === 'string' && EPOCH_FORMAT.test(value);

const parse = (value: string): bigint => {
  if (!isEpoch(value)) throw new TypeError(`invalid epoch: ${String(value)}`);
  return BigInt(value);
};

// 世代を 1 進める。端末の io_epoch・output_epoch（停止時にその場で進める）と、中枢が発行する世代の両方が使う。
export const advanceEpoch = (current: string): string =>
  (parse(current) + 1n).toString();

export type EpochClass = 'current' | 'stale' | 'unknown' | 'invalid';

// 受け取った世代が、自分の今の世代と比べて現在か・古いか・発行元が出していない新しい値か。
// 古い値も、新しい値（発行元を確かめられない）も受け付けない（audio.ts の acceptDelivery と同じ向き）。
export function classifyEpoch(given: string, current: string): EpochClass {
  if (!isEpoch(given) || !isEpoch(current)) return 'invalid';
  const a = BigInt(given);
  const b = BigInt(current);
  return a === b ? 'current' : a < b ? 'stale' : 'unknown';
}

// 受け取った側が世代を持ち続ける規則。小さい値に戻さない（戻る値は無視し、戻ろうとしたことを知らせる）。
export function holdEpoch(
  held: string,
  incoming: string,
): { readonly value: string; readonly regressed: boolean } {
  const a = parse(held);
  const b = parse(incoming);
  return b < a
    ? { value: held, regressed: true }
    : { value: incoming, regressed: false };
}

export interface DeviceEpochPair {
  readonly io_epoch: string;
  readonly output_epoch: string;
}

export type DeviceEpochKey = keyof DeviceEpochPair;

export type DeviceEpochReport =
  | {
      readonly ok: true;
      readonly next: DeviceEpochPair;
      readonly advanced: readonly DeviceEpochKey[];
    }
  | {
      readonly ok: false;
      readonly reason: 'epoch_regressed' | 'invalid_epoch';
      readonly keys: readonly DeviceEpochKey[];
      // 戻さずに持ち続けている値。端末はこの値より大きい値から進め直す。
      readonly stored: DeviceEpochPair;
    };

const DEVICE_EPOCH_KEYS: readonly DeviceEpochKey[] = [
  'io_epoch',
  'output_epoch',
];

// 中枢が端末の報告（io_epoch・output_epoch）を受けるとき。端末が進めた値は受け入れ、1 つでも保存した値より
// 小さい報告は全体を拒否する（端末の保存の喪失・再インストールで巻き戻さない。ADR 0005）。拒否しても保存した値は変えない。
export function acceptDeviceEpochReport(
  stored: DeviceEpochPair,
  report: DeviceEpochPair,
): DeviceEpochReport {
  const invalid = DEVICE_EPOCH_KEYS.filter(
    (key) => !isEpoch(report[key]) || !isEpoch(stored[key]),
  );
  if (invalid.length > 0)
    return { ok: false, reason: 'invalid_epoch', keys: invalid, stored };
  const regressed = DEVICE_EPOCH_KEYS.filter(
    (key) => BigInt(report[key]) < BigInt(stored[key]),
  );
  if (regressed.length > 0)
    return { ok: false, reason: 'epoch_regressed', keys: regressed, stored };
  return {
    ok: true,
    next: { io_epoch: report.io_epoch, output_epoch: report.output_epoch },
    advanced: DEVICE_EPOCH_KEYS.filter(
      (key) => BigInt(report[key]) > BigInt(stored[key]),
    ),
  };
}

// 端末の main が起動したときの世代の取り方。中枢の値（取得できなければ null）と自分の保存値（なければ null）の
// 大きい方に 1 を足して始める（再インストール・保存の喪失で巻き戻さない。ADR 0038。原本に決めなし）。
export function deviceEpochAtStartup(
  core: string | null,
  saved: string | null,
): string {
  const a = core === null ? 0n : parse(core);
  const b = saved === null ? 0n : parse(saved);
  return ((a > b ? a : b) + 1n).toString();
}

// 中枢が発行する世代。control_epoch は lost へ入るときに nextLiveControl が進める。
export interface CoreEpochs {
  readonly audio_epoch: string;
  readonly control_epoch: string;
  readonly session_epoch: string;
}

// 音声の世代を新しくする出来事。Live の開始・再接続・端末交代では、前の接続の音声・文字起こし・結果を引き継がない。
export const LIVE_EPOCH_EVENTS = [
  'live_start',
  'reconnect',
  'device_move',
] as const;
export type LiveEpochEvent = (typeof LIVE_EPOCH_EVENTS)[number];

// Live の開始・再接続・端末交代で audio_epoch と session_epoch を 1 つずつ進める（live_sessions の挿入と同じ
// transaction で行う。ADR 0038）。session_epoch も進めるのは、前の接続の結果を新しい接続の音声へ付け替えないため
// （原本に決めなし。どの出来事も同じ幅）。control_epoch は変えない。
export function issueLiveEpochs(
  current: CoreEpochs,
  event: LiveEpochEvent,
): { readonly next: CoreEpochs; readonly issued: readonly string[] } {
  if (!LIVE_EPOCH_EVENTS.includes(event))
    throw new TypeError(`unknown epoch event: ${String(event)}`);
  return {
    next: {
      ...current,
      audio_epoch: advanceEpoch(current.audio_epoch),
      session_epoch: advanceEpoch(current.session_epoch),
    },
    issued: ['audio_epoch', 'session_epoch'],
  };
}

// サイドバンドが lost へ入るときに control_epoch を 1 進める（nextLiveControl と同じ規則。音声・session は変えない）。
export function issueControlEpoch(current: CoreEpochs): CoreEpochs {
  return { ...current, control_epoch: advanceEpoch(current.control_epoch) };
}

// バックアップの復元後、最初の発行の前に audio_epoch・session_epoch を進める（復元で戻った値と復元前の接続の値が
// 同じになっても、旧接続が使えないようにする案。進める幅は原本に決めなし）。
export function epochsAfterRestore(
  current: CoreEpochs,
  step: number = 1,
): CoreEpochs {
  if (!Number.isSafeInteger(step) || step < 1)
    throw new RangeError('restore step must be a positive integer');
  const by = BigInt(step);
  return {
    ...current,
    audio_epoch: (parse(current.audio_epoch) + by).toString(),
    session_epoch: (parse(current.session_epoch) + by).toString(),
  };
}
