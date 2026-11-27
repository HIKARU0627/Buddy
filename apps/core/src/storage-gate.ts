// 保存境界の保持者（StorageModeGate の核。設計 03 記録しない会話の境界、ADR 0045・0059、B06-07a-2）。
//
// domain の遷移（applyStorageBoundaryEvent）が返す命令を Core が実行する側。今の保存モード・区切りの ID・世代を RAM に持ち、
// 記録しない区切りの世代の番号だけをデータディレクトリの時計の状態ファイル（storage_boundary の欄）に置く。
//
// 本人が 2026-10-31 に決定した（ADR 0059 の U146。Q7）:
// - 世代の番号だけを永続する（本文・区切りの ID・発言は持たない）。再起動の後も世代は戻らず、古い由来の結果は必ず拒否する
//   （記録しない区切りが由来の結果は、世代が違えば origin_private で永続化しない）。
// - Core が再起動すると記録しない区切りの RAM（発言・一時のキャンバス・承認前の確認）は失われる。そこで再起動後は通常の
//   区切りへ戻し、端末に「記録しない会話が終わった」ことを NoticeSink で知らせる（運搬は UI-05。ここでは作らない）。
//
// 入る・出るは、世代をファイルへ書けたときだけ進める（書けなければ状態も命令も変えない＝入れない・出られない）。入る側を
// 書けないときに RAM だけで入らないのは、再起動の後に「記録しない会話が終わった」ことを知らせる手段を失い、端末が記録しない
// 会話のつもりで続けてしまうため。書き込みの失敗は呼び出し側へ返す（503 に写すのは API を足す次の段階）。

import { randomUUID } from 'node:crypto';
import {
  applyStorageBoundaryEvent,
  initialStorageBoundaryState,
  storageOriginRejection,
} from '@buddy/domain';
import type {
  StorageBoundaryCommand,
  StorageBoundaryEvent,
  StorageBoundaryRejection,
  StorageBoundaryState,
  StorageModeName,
  StorageOrigin,
  StorageOriginRejection,
} from '@buddy/domain';
import type {
  ClockStateFilePort,
  StorageBoundaryRecord,
} from './clock-state.js';
import type { NoticeSink } from './notice-sink.js';

// 命令の実行先。Live を閉じる・一時のキャンバスを始める／終える・RAM を捨てる・区切りを開く、を呼び出し側が結び付ける
// （今回は Live を閉じるだけを Core がつなぐ。ほかは保存先ごとに次の段階でつなぐ）。命令の実行の失敗は状態を戻さない
// （記録しない側に倒した状態は RAM で確定済みで、戻すと保存してしまう側へ倒れる）。
export interface StorageGateEffects {
  run(command: StorageBoundaryCommand): void | Promise<void>;
}

export interface StorageModeGateOptions {
  readonly clock: Pick<ClockStateFilePort, 'loadBoundary' | 'saveBoundary'>;
  readonly notices?: NoticeSink;
  readonly effects?: StorageGateEffects;
  readonly now: () => number;
  readonly newId?: () => string;
  readonly log?: (message: string) => void;
}

export type StorageGateFailure =
  // 遷移の規則が拒否した（すでに記録しない区切り・区切りの ID の再利用など）。
  | { readonly ok: false; readonly reason: StorageBoundaryRejection }
  // 世代を書く場所がない（時計の状態ファイルが無い・読めない・形が違う）。入る・出るを進めない。
  | { readonly ok: false; readonly reason: 'persist_unavailable' }
  // 世代の書き込みが失敗した。
  | { readonly ok: false; readonly reason: 'persist_failed' }
  | { readonly ok: false; readonly reason: 'closed' };

export type StorageGateResult =
  { readonly ok: true; readonly origin: StorageOrigin } | StorageGateFailure;

// 独立した確認の事象（B06-07a-2 の 2d、ADR 0192）。外部変更の頼み・画面での承認・取り下げ。
export type StorageConfirmationEvent = Extract<
  StorageBoundaryEvent,
  {
    readonly type:
      | 'external_change_requested'
      | 'confirmation_approved'
      | 'confirmation_declined';
  }
>;

export type StorageConfirmationResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: StorageBoundaryRejection | 'closed';
      readonly errors: readonly string[];
    };

const iso = (ms: number): string => new Date(ms).toISOString();

export class StorageModeGate {
  readonly #clock: StorageModeGateOptions['clock'];
  readonly #effects: StorageGateEffects | undefined;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #log: (message: string) => void;
  #state: StorageBoundaryState;
  #serial: Promise<unknown> = Promise.resolve();
  #closed = false;
  // 書き込みの結果が不確かな失敗（置き換えの後の fsync の失敗など）の後に、ファイルを RAM の状態に合わせ直すための記録。
  // 合わせ直せるまで次の入る・出る・停止のたびに試す。
  #pendingRestore: StorageBoundaryRecord | null = null;

  private constructor(
    options: StorageModeGateOptions,
    state: StorageBoundaryState,
  ) {
    this.#clock = options.clock;
    this.#effects = options.effects;
    this.#now = options.now;
    this.#newId = options.newId ?? randomUUID;
    this.#log = options.log ?? (() => undefined);
    this.#state = state;
  }

  // 起動。ファイルに残った世代を引き継ぎ、新しい通常の区切りを開く。前の起動で記録しない区切りが開いていたら、終わったことを
  // 知らせる。世代の書き込み・知らせの失敗は起動を止めない（通常の区切りに戻っていて、保存側へ倒れる要素がない）。
  static async open(options: StorageModeGateOptions): Promise<StorageModeGate> {
    const log = options.log ?? (() => undefined);
    const newId = options.newId ?? randomUUID;
    let generation = '1';
    let ended: string | null = null;
    let persist = false;
    let loaded: Awaited<
      ReturnType<StorageModeGateOptions['clock']['loadBoundary']>
    >;
    try {
      loaded = await options.clock.loadBoundary();
    } catch {
      loaded = { status: 'unavailable' };
    }
    if (loaded.status === 'ok') {
      generation = (BigInt(loaded.record.segment_generation) + 1n).toString();
      if (loaded.record.private_open) ended = loaded.record.segment_generation;
      persist = true;
    } else if (loaded.status === 'invalid') {
      // 壊れた欄は読み替えない。世代は 1 から数え直し（区切りの ID が新しいので、古い由来は区切りの ID の違いで拒否される）、
      // 欄を書き直す。何番の記録しない区切りが開いていたかは分からないので、終わった知らせは出せない。
      log(
        '記録しない区切りの世代の欄が壊れています。世代を数え直し、欄を書き直します。',
      );
      persist = true;
    } else if (loaded.status === 'unavailable') {
      log(
        '記録しない区切りの世代を置く時計の状態ファイルがありません。記録しない会話には入れません（時計の採り直しの後に使えます）。',
      );
    }
    const state: StorageBoundaryState = {
      ...initialStorageBoundaryState(newId(), 'normal'),
      segment_generation: generation,
    };
    const gate = new StorageModeGate(options, state);
    if (persist) {
      try {
        const saved = await options.clock.saveBoundary({
          segment_generation: generation,
          private_open: false,
        });
        if (saved === 'unavailable')
          log('起動の世代を時計の状態ファイルに書けませんでした。');
      } catch {
        log('起動の世代を時計の状態ファイルに書けませんでした。');
      }
    }
    if (ended !== null) await gate.#announceEnded(options, ended);
    return gate;
  }

  async #announceEnded(
    options: StorageModeGateOptions,
    ended: string,
  ): Promise<void> {
    this.#log(
      '前の起動で記録しない会話が開いていました。通常の区切りへ戻しました（発言は保存していません）。',
    );
    const sink = options.notices;
    if (sink === undefined) return;
    try {
      await sink.publish({
        schema: 'buddy.storage-boundary-notice.v1',
        notice_id: this.#newId(),
        occurred_at: iso(this.#now()),
        kind: 'private_ended',
        reason: 'core_restarted',
        ended_generation: ended,
        segment_id: this.#state.segment_id,
        segment_generation: this.#state.segment_generation,
      });
    } catch {
      this.#log(
        '記録しない会話が終わった知らせを渡せませんでした（区切りの切り替えには影響しません）。',
      );
    }
  }

  // ---- 読み取り（同期。Live の受付・入出力の状態・入力の判定が毎回呼ぶ） ---------------------------------------------

  get mode(): StorageModeName {
    return this.#state.mode;
  }

  privateConversation(): boolean {
    return this.#state.mode === 'private';
  }

  // 今の区切りの由来（処理を始めるときに控え、結果が戻ったときに origin として照合する）。
  origin(): StorageOrigin {
    return {
      segment_id: this.#state.segment_id,
      segment_generation: this.#state.segment_generation,
      storage_mode: this.#state.mode,
    };
  }

  // 遅れて届いた結果・端末が見ていた区切りの由来の照合（domain の storageOriginRejection）。null なら今の区切りの結果。
  originRejection(origin: unknown): StorageOriginRejection | null {
    return storageOriginRejection(this.#state, origin);
  }

  // ---- 入る・出る -----------------------------------------------------------------------------------------------

  // 記録しない区切りに入る。世代を書けたときだけ入る（命令は世代を書いた後に実行する）。
  enterPrivate(): Promise<StorageGateResult> {
    return this.#exclusive(async () => {
      if (this.#closed) return { ok: false, reason: 'closed' } as const;
      await this.#settle();
      // 閉じる要求の取りこぼしを避けるため、Live は開いているものとして遷移を当てる（閉じる命令は重ねて呼んでも
      // 閉じ済みの接続には何もしない）。Core はここで Live の段階を持たず、Live の制御が正本。
      const before: StorageBoundaryState = { ...this.#state, live: 'open' };
      const result = applyStorageBoundaryEvent(before, {
        type: 'enter_private',
        segment_id: this.#newId(),
      });
      if (result.rejected !== null)
        return { ok: false, reason: result.rejected } as const;
      const failure = await this.#persist(result.state, true);
      if (failure !== null) {
        // 書き込みの結果が不確かなら（置き換えの後の失敗）、入っていない状態（通常の区切り）にファイルを合わせ直す。
        if (failure.reason === 'persist_failed')
          await this.#restore({
            segment_generation: this.#state.segment_generation,
            private_open: false,
          });
        return failure;
      }
      this.#state = { ...result.state, live: 'closed' };
      await this.#run(result.commands);
      return { ok: true, origin: this.origin() } as const;
    });
  }

  // 記録しない区切りから出る（出る先は通常か継続相談）。RAM を捨て、前の要約を持ち込まない区切りを開く。
  exitPrivate(mode: 'normal' | 'extended'): Promise<StorageGateResult> {
    return this.#exclusive(async () => {
      if (this.#closed) return { ok: false, reason: 'closed' } as const;
      await this.#settle();
      const result = applyStorageBoundaryEvent(this.#state, {
        type: 'exit_private',
        segment_id: this.#newId(),
        mode,
      });
      if (result.rejected !== null)
        return { ok: false, reason: result.rejected } as const;
      const failure = await this.#persist(result.state, false);
      if (failure !== null) {
        // 書き込みの結果が不確かなら（置き換えは済み、その後の fsync が失敗した場合など）、ファイルは「出た」と読める。RAM は
        // 記録しない区切りに留まるので、再起動の後の終了の知らせを失わないよう、ファイルを記録しない区切りが開いている状態に
        // 合わせ直す（Q7）。
        if (failure.reason === 'persist_failed')
          await this.#restore({
            segment_generation: this.#state.segment_generation,
            private_open: true,
          });
        return failure;
      }
      this.#state = result.state;
      await this.#run(result.commands);
      return { ok: true, origin: this.origin() } as const;
    });
  }

  // ---- 独立した確認（B06-07a-2 の 2d、ADR 0192） -------------------------------------------------------------------

  // 承認を待つ独立した確認の数（試験・診断の口。中身は返さない）。
  pendingConfirmations(): number {
    return this.#state.pending_confirmations.length;
  }

  // 独立した確認の事象を domain の遷移に当て、返った命令（確認を出す・最小の操作記録）を run に渡す。入る・出ると同じ順に
  // 1 つずつ行う（承認と記録の書き込みの間に出る・入るが割り込まない）。拒否されたら状態も命令も変えない（domain が
  // 確認の ID の使用済みを記録した状態は進める）。命令の実行は呼び出し側が行い、その失敗で状態を戻さない（承認済みの確認を
  // 承認前へ戻すと、同じ承認で 2 回記録し得る）。
  confirmation<T>(
    event: StorageConfirmationEvent,
    run: (commands: readonly StorageBoundaryCommand[]) => Promise<T>,
  ): Promise<StorageConfirmationResult<T>> {
    return this.#exclusive(async () => {
      if (this.#closed)
        return { ok: false, reason: 'closed', errors: [] } as const;
      const result = applyStorageBoundaryEvent(this.#state, event);
      this.#state = result.state;
      if (result.rejected !== null)
        return {
          ok: false,
          reason: result.rejected,
          errors: [...result.errors],
        } as const;
      return { ok: true, value: await run(result.commands) } as const;
    });
  }

  // 承認を待つ確認をすべて取り下げる（ロックの申告・忘却の知らせで記録しない区切りの中身を捨てるとき。ADR 0192）。
  // 取り下げた確認の ID を返す。取り下げた確認への後の承認は confirmation_not_found で、記録も外部変更も作らない。
  dropConfirmations(): Promise<readonly string[]> {
    return this.#exclusive(() => {
      const dropped: string[] = [];
      for (const pending of this.#state.pending_confirmations) {
        const result = applyStorageBoundaryEvent(this.#state, {
          type: 'confirmation_declined',
          confirmation_id: pending.confirmation_id,
        });
        if (result.rejected !== null) continue;
        this.#state = result.state;
        dropped.push(pending.confirmation_id);
      }
      return Promise.resolve(dropped);
    });
  }

  // 閉じた後は入る・出るを受けない。合わせ直せていない書き込みが残っていれば、最後にもう一度試す。
  async close(): Promise<void> {
    this.#closed = true;
    await this.#exclusive(() => this.#settle());
  }

  // 結果が不確かだった書き込みの後始末が残っていれば、もう一度試す。
  async #settle(): Promise<void> {
    if (this.#pendingRestore !== null)
      await this.#restore(this.#pendingRestore);
  }

  // ファイルを RAM の状態に合わせ直す（3 回まで）。合わせ直せなければ記録を残し、次の機会に試す。
  async #restore(record: StorageBoundaryRecord): Promise<void> {
    this.#pendingRestore = record;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if ((await this.#clock.saveBoundary(record)) !== 'saved') break;
        this.#pendingRestore = null;
        return;
      } catch {
        // もう一度試す。
      }
    }
    this.#log(
      '記録しない区切りの世代をファイルに合わせ直せませんでした（次の機会に試します）。',
    );
  }

  // 世代をファイルへ書く。書けなければ失敗を返す（呼び出し側は状態を進めない）。
  async #persist(
    next: StorageBoundaryState,
    privateOpen: boolean,
  ): Promise<StorageGateFailure | null> {
    try {
      const saved = await this.#clock.saveBoundary({
        segment_generation: next.segment_generation,
        private_open: privateOpen,
      });
      if (saved !== 'saved')
        return { ok: false, reason: 'persist_unavailable' };
      this.#pendingRestore = null;
      return null;
    } catch {
      return { ok: false, reason: 'persist_failed' };
    }
  }

  async #run(commands: readonly StorageBoundaryCommand[]): Promise<void> {
    if (this.#effects === undefined) return;
    for (const command of commands) {
      try {
        await this.#effects.run(command);
      } catch {
        // 状態は進めたまま、次の命令へ進む（失敗した命令の結果を理由に保存側へ戻さない）。
        this.#log(`保存境界の命令（${command.type}）を実行できませんでした。`);
      }
    }
  }

  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#serial.then(run, run);
    this.#serial = next.catch(() => undefined);
    return next;
  }
}
