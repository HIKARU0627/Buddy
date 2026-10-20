// Core のライフサイクル（設計 02 処理の配置・運用上の境界、ADR 0012）。
// 状態の遷移だけを持つ純粋な表で、ソケット・ファイル・シグナルの副作用は core.ts に置く。

export const LIFECYCLE_STATES = [
  'starting',
  'running',
  'stopping',
  'stopped',
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

// started: 排他・状態・制御チャネルの準備が終わった。
// stop_requested: シグナルまたは制御チャネルの stop。
// failed: 起動途中の失敗、または実行中の回復できない障害。
// released: ソケット・ロックを解放し終えた。
export type LifecycleEvent =
  'started' | 'stop_requested' | 'failed' | 'released';

export const LIFECYCLE_TRANSITIONS: Readonly<
  Record<
    LifecycleState,
    Readonly<Partial<Record<LifecycleEvent, LifecycleState>>>
  >
> = {
  starting: {
    started: 'running',
    stop_requested: 'stopping',
    failed: 'stopping',
  },
  running: { stop_requested: 'stopping', failed: 'stopping' },
  // 終了処理中の stop・失敗は遷移ではなく、進行中の終了処理に合流させる。
  stopping: { released: 'stopped' },
  stopped: {},
};

export function nextLifecycleState(
  state: LifecycleState,
  event: LifecycleEvent,
): LifecycleState | null {
  return LIFECYCLE_TRANSITIONS[state][event] ?? null;
}

// 制御チャネルの要求を受け付けるか。status は停止完了まで答え、
// stop は実行中だけ新しい終了処理を始める（終了処理中は進行中の終了を返す）。
export function controlOpDisposition(
  state: LifecycleState,
  op: 'status' | 'stop',
): 'answer' | 'begin_stop' | 'already_stopping' | 'unavailable' {
  if (state === 'stopped') return 'unavailable';
  if (op === 'status') return 'answer';
  if (state === 'stopping') return 'already_stopping';
  return 'begin_stop';
}

export class Lifecycle {
  #state: LifecycleState = 'starting';
  readonly #listeners = new Set<(state: LifecycleState) => void>();

  get state(): LifecycleState {
    return this.#state;
  }

  // 新しい要求（将来のジョブ・API）を受け付けてよいのは running だけ。
  get acceptsNewWork(): boolean {
    return this.#state === 'running';
  }

  // 遷移できたら true。表にない組は状態を変えずに false を返す。
  apply(event: LifecycleEvent): boolean {
    const next = nextLifecycleState(this.#state, event);
    if (next === null) return false;
    this.#state = next;
    for (const listener of this.#listeners) listener(next);
    return true;
  }

  onChange(listener: (state: LifecycleState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
