// 記録しない区切りの発言の RAM（B06-07a-2 の 2c、ADR 0190。設計 03 記録しない会話の境界、ADR 0045・0059・0060）。
//
// 記録しない区切りの間の発言・応答・直前のやりとりを、Core のメモリーにだけ持つ。DB・WAL・ログ・バックアップには書かない
// （許可表の「禁止（RAM）」の行: persist_turns・persist_turn_response・persist_command_receipt など）。
//
// 持つもの（暫定。ADR 0190、U480）:
// - 同じ要求の再送に同じ応答を返すための控え（接続範囲と要求 ID の組 → 要求の照合値と応答）。上限 PRIVATE_REPLAY_LIMIT 件で、
//   古いものから捨てる（捨てた要求の再送は新しい要求として処理し直す。保存はしないので二重の記録にはならない）。
// - 直前のやりとり（本人の発言と Buddy の返事の文）。上限 PRIVATE_RECENT_TURNS_LIMIT 件（契約の ConversationContext の
//   recent_turns の上限と同じ 6 件）。最後のやりとりから 30 分・本人の時間帯の日付の変更を過ぎたら捨てる（通常の区切りの
//   自動の区切りと同じ規則。domain の automaticSegmentBoundary）。期限は記録しない間の発言のたびに確かめて捨てる（expire）。
//   発言がない間は時計で捨てず、次の発言・終える・ロック・忘却・停止まで残る。
// - 処理中の要求（同時に届いた同じ要求は、その結果を待って同じ応答を返す。解釈・読み取りを外部へ 2 回送らない）。
//
// 捨てる時（discard）: 記録しない会話を終えた（保存境界の命令 discard_private_ram）・Core の停止・端末のロックの申告・
// 忘却の知らせ。Core の再起動では RAM ごと失われる。捨てるたびに epoch を進め、処理の途中で捨てた後に届いた結果を
// 持たない（hold は始めたときの epoch と区切りが今と同じときだけ受け付ける）。

import { automaticSegmentBoundary } from '@buddy/domain';

// 直前のやりとりの上限（本人の発言と Buddy の返事を 1 件ずつ数える）。契約の ConversationContext.recent_turns と同じ。
export const PRIVATE_RECENT_TURNS_LIMIT = 6;
// 同じ要求の再送に返す応答の控えの上限。
export const PRIVATE_REPLAY_LIMIT = 64;

export interface PrivateRecentTurn {
  readonly role: 'user' | 'buddy';
  readonly text: string;
  // UTC の RFC 3339。
  readonly at: string;
}

export interface PrivateSegmentRef {
  readonly segment_id: string;
  readonly segment_generation: string;
}

export type PrivateDiscardReason =
  'private_ended' | 'locked' | 'forgotten' | 'core_stopped';

export type PrivateReplay =
  | { readonly kind: 'none' }
  | { readonly kind: 'same'; readonly body: object }
  | { readonly kind: 'conflict' };

export interface PrivateHeld {
  readonly replays: number;
  readonly recent_turns: number;
  // 処理中の要求の数。
  readonly running: number;
  readonly discards: number;
  // 最後に捨てた理由（まだ捨てていなければ null）。
  readonly last_discard: PrivateDiscardReason | null;
}

export interface PrivateConversationRamOptions {
  // 本人の時間帯（日付の変更の判定。発言の解釈と同じ値）。
  readonly utcOffset: string;
}

const sameSegment = (
  a: PrivateSegmentRef | null,
  b: PrivateSegmentRef,
): boolean =>
  a !== null &&
  a.segment_id === b.segment_id &&
  a.segment_generation === b.segment_generation;

export class PrivateConversationRam {
  readonly #utcOffset: string;
  #segment: PrivateSegmentRef | null = null;
  #replays = new Map<
    string,
    { readonly hash: string; readonly body: object }
  >();
  #recent: PrivateRecentTurn[] = [];
  #openedAt: string | null = null;
  #lastAt: string | null = null;
  #epoch = 0;
  #lastDiscard: PrivateDiscardReason | null = null;
  // 処理中の要求（鍵 → 照合値と処理の結果）。同時に届いた同じ要求は、この結果を待って同じ応答を返す。
  #running = new Map<
    string,
    { readonly hash: string; readonly promise: Promise<unknown> }
  >();

  constructor(options: PrivateConversationRamOptions) {
    this.#utcOffset = options.utcOffset;
  }

  // 捨てた回数。処理を始めたときに控え、結果を持つ前に今と同じかを確かめる。
  get epoch(): number {
    return this.#epoch;
  }

  // 今持っている件数（試験・診断用。本文は返さない）。
  held(): PrivateHeld {
    return {
      replays: this.#replays.size,
      recent_turns: this.#recent.length,
      running: this.#running.size,
      discards: this.#epoch,
      last_discard: this.#lastDiscard,
    };
  }

  // 今の記録しない区切りに合わせる。別の区切り（入り直した・前の区切りを捨て損ねた）なら、前の中身を捨てる。
  bind(segment: PrivateSegmentRef, at: string): void {
    if (sameSegment(this.#segment, segment)) return;
    this.#reset();
    this.#segment = {
      segment_id: segment.segment_id,
      segment_generation: segment.segment_generation,
    };
    this.#openedAt = at;
  }

  // 同じ要求（接続範囲と要求 ID）の控え。照合値が違えば conflict（07 §3）。
  replay(segment: PrivateSegmentRef, key: string, hash: string): PrivateReplay {
    if (!sameSegment(this.#segment, segment)) return { kind: 'none' };
    const found = this.#replays.get(key);
    if (found === undefined) return { kind: 'none' };
    return found.hash === hash
      ? { kind: 'same', body: found.body }
      : { kind: 'conflict' };
  }

  // 期限（最後のやりとりから 30 分・本人の時間帯の日付の変更）を過ぎた直前のやりとりをメモリーから捨てる。記録しない間の
  // 発言のたびに、応答の控えを返す前に呼ぶ（会話の操作・再送でも呼ぶ）。発言がない間は、次の発言・終える・ロック・忘却・停止で捨てる。
  expire(segment: PrivateSegmentRef, now: string): void {
    if (!sameSegment(this.#segment, segment)) return;
    if (this.#recent.length === 0) return;
    const boundary = automaticSegmentBoundary({
      opened_at: this.#openedAt ?? now,
      last_turn_at: this.#lastAt,
      now,
      utc_offset: this.#utcOffset,
    });
    if (boundary === null) return;
    this.#recent = [];
    this.#lastAt = null;
  }

  // 直前のやりとり（古い順の写し）。期限を過ぎていれば、ここでも捨てて空を返す。
  recent(
    segment: PrivateSegmentRef,
    now: string,
  ): readonly PrivateRecentTurn[] {
    this.expire(segment, now);
    if (!sameSegment(this.#segment, segment)) return [];
    return this.#recent.map((turn) => ({ ...turn }));
  }

  // 同じ要求（鍵）が処理中か。照合値が違えば conflict。
  running(
    segment: PrivateSegmentRef,
    key: string,
    hash: string,
  ):
    | { readonly kind: 'none' }
    | { readonly kind: 'same'; readonly promise: Promise<unknown> }
    | { readonly kind: 'conflict' } {
    if (!sameSegment(this.#segment, segment)) return { kind: 'none' };
    const found = this.#running.get(key);
    if (found === undefined) return { kind: 'none' };
    return found.hash === hash
      ? { kind: 'same', promise: found.promise }
      : { kind: 'conflict' };
  }

  // 処理中の要求を控える。終わったら外す（捨てた後に別の処理が入っていれば、それは外さない）。
  track(key: string, hash: string, promise: Promise<unknown>): void {
    this.#running.set(key, { hash, promise });
    const done = () => {
      if (this.#running.get(key)?.promise === promise)
        this.#running.delete(key);
    };
    promise.then(done, done);
  }

  // 処理を終えた発言を持つ。始めたときの epoch と区切りが今と同じときだけ持つ（捨てた後・出た後に届いた結果を持たない）。
  // 持てたら true。
  hold(input: {
    readonly segment: PrivateSegmentRef;
    readonly epoch: number;
    readonly key: string;
    readonly hash: string;
    readonly body: object;
    readonly user_text: string;
    readonly buddy_text: string | null;
    readonly at: string;
  }): boolean {
    if (
      input.epoch !== this.#epoch ||
      !sameSegment(this.#segment, input.segment)
    )
      return false;
    this.#replays.delete(input.key);
    this.#replays.set(input.key, { hash: input.hash, body: input.body });
    for (const old of this.#replays.keys()) {
      if (this.#replays.size <= PRIVATE_REPLAY_LIMIT) break;
      this.#replays.delete(old);
    }
    const next: PrivateRecentTurn[] = [
      ...this.#recent,
      { role: 'user', text: input.user_text, at: input.at },
      ...(input.buddy_text === null
        ? []
        : [{ role: 'buddy' as const, text: input.buddy_text, at: input.at }]),
    ];
    this.#recent = next.slice(-PRIVATE_RECENT_TURNS_LIMIT);
    this.#lastAt =
      this.#lastAt === null || Date.parse(input.at) > Date.parse(this.#lastAt)
        ? input.at
        : this.#lastAt;
    return true;
  }

  // すべて捨てる（区切りの結び付きも外す）。epoch を進め、処理中の発言の結果を持たないようにする。
  discard(reason: PrivateDiscardReason): void {
    this.#reset();
    this.#segment = null;
    this.#openedAt = null;
    this.#epoch += 1;
    this.#lastDiscard = reason;
  }

  #reset(): void {
    this.#running = new Map();
    this.#replays = new Map();
    this.#recent = [];
    this.#lastAt = null;
  }
}
