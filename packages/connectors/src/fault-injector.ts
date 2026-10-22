// 故障点の注入装置（tests/integration/fault-points.json の fault_points と同じ名前）。
// Core 側の地点は Core のコードが hit() を呼び、模擬 provider 側の地点は provider が take() で引き取る。
// 待ち合わせは固定時間の sleep ではなく、関門（pause・barrier）で行う。

export const FAULT_POINTS = [
  'before_approval_save',
  'after_approval_save',
  'after_target_recheck',
  'after_dispatch_intent_before_send',
  'after_external_apply_before_response',
  'before_result_save',
  'after_event_delivery_before_ack',
  'approval_barrier',
  'response_timeout_then_late_apply',
  'core_restart',
] as const;

export type FaultPoint = (typeof FAULT_POINTS)[number];

/** 模擬 provider が引き取る地点。ほかは Core のコードが hit() を呼ぶ（core_restart は試験装置が行う）。 */
export const PROVIDER_FAULT_POINTS = [
  'after_external_apply_before_response',
  'response_timeout_then_late_apply',
] as const satisfies readonly FaultPoint[];

export type FaultSpec =
  /** 地点に来たところで止め、release() まで待たせる。 */
  | { readonly mode: 'pause' }
  /** 地点で InjectedFaultError を投げ、そこで処理を打ち切る。 */
  | { readonly mode: 'throw' }
  /** parties 件が来るまで全員を待たせ、そろった瞬間に一斉に解放する。 */
  | { readonly mode: 'barrier'; readonly parties: number }
  /** provider: 外部の変更を適用した後、応答を返さずに接続を切る。 */
  | { readonly mode: 'drop_response' }
  /** provider: 適用せずに要求を保留する。releaseLateApplies() で遅れて適用する。 */
  | { readonly mode: 'hold_then_apply' };

/** 一致させる条件。指定しない項目は何にでも一致する。 */
export interface FaultMatch {
  readonly operation_id?: string;
  readonly step_id?: string;
}

export interface FaultContext {
  readonly operation_id?: string | null;
  readonly step_id?: string | null;
}

export interface ArmOptions {
  /** 注入する回数。既定は 1 回（barrier は parties 回）。 */
  readonly times?: number;
  readonly match?: FaultMatch;
}

export class InjectedFaultError extends Error {
  readonly point: FaultPoint;
  constructor(point: FaultPoint) {
    super(`injected fault: ${point}`);
    this.name = 'InjectedFaultError';
    this.point = point;
  }
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Armed {
  readonly point: FaultPoint;
  readonly spec: FaultSpec;
  remaining: number;
  readonly match: FaultMatch;
  readonly gate: Deferred;
  arrived: number;
}

function matches(match: FaultMatch, context: FaultContext): boolean {
  if (
    match.operation_id !== undefined &&
    match.operation_id !== context.operation_id
  )
    return false;
  if (match.step_id !== undefined && match.step_id !== context.step_id)
    return false;
  return true;
}

export class FaultInjector {
  readonly #armed: Armed[] = [];
  readonly #hits = new Map<FaultPoint, number>();
  readonly #waiters: { point: FaultPoint; count: number; wake: () => void }[] =
    [];

  arm(point: FaultPoint, spec: FaultSpec, options: ArmOptions = {}): void {
    if (spec.mode === 'barrier' && spec.parties < 2)
      throw new Error('barrier の parties は 2 以上にしてください。');
    const times = options.times ?? (spec.mode === 'barrier' ? spec.parties : 1);
    this.#armed.push({
      point,
      spec,
      remaining: times,
      match: options.match ?? {},
      gate: deferred(),
      arrived: 0,
    });
  }

  /** 地点を通った回数（注入の有無にかかわらず数える）。 */
  hitCount(point: FaultPoint): number {
    return this.#hits.get(point) ?? 0;
  }

  /** 地点を count 回通るまで待つ。固定時間の sleep の代わり。 */
  waitReached(point: FaultPoint, count = 1): Promise<void> {
    if (this.hitCount(point) >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#waiters.push({ point, count, wake: resolve });
    });
  }

  /** pause で止めている処理を再開する。 */
  release(point: FaultPoint): void {
    for (const armed of this.#armed) {
      if (armed.point === point && armed.spec.mode === 'pause')
        armed.gate.resolve();
    }
  }

  /** Core のコードが故障点で呼ぶ。注入されていなければ何もしない。 */
  async hit(point: FaultPoint, context: FaultContext = {}): Promise<void> {
    const armed = this.#consume(point, context);
    if (armed === undefined) return;
    switch (armed.spec.mode) {
      case 'throw':
        throw new InjectedFaultError(point);
      case 'pause':
        await armed.gate.promise;
        return;
      case 'barrier':
        armed.arrived += 1;
        if (armed.arrived >= armed.spec.parties) armed.gate.resolve();
        await armed.gate.promise;
        return;
      default:
        // provider 用の指定を Core の地点に使う設定の誤りは、黙って通さない。
        throw new Error(`Core の地点に使えない指定: ${armed.spec.mode}`);
    }
  }

  /** 模擬 provider が呼ぶ。一致する指定を 1 回分引き取る。 */
  take(point: FaultPoint, context: FaultContext = {}): FaultSpec | undefined {
    return this.#consume(point, context)?.spec;
  }

  #consume(point: FaultPoint, context: FaultContext): Armed | undefined {
    const count = this.hitCount(point) + 1;
    this.#hits.set(point, count);
    for (const waiter of [...this.#waiters]) {
      if (waiter.point === point && count >= waiter.count) {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        waiter.wake();
      }
    }
    const armed = this.#armed.find(
      (entry) =>
        entry.point === point &&
        entry.remaining > 0 &&
        matches(entry.match, context),
    );
    if (armed !== undefined) armed.remaining -= 1;
    return armed;
  }
}
