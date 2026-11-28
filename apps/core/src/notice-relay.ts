// 知らせの運搬（UI-05 の段階 3、ADR 0187、U40・U168）。
//
// NoticeSink（期限切れ・忘却・忘却台帳の前進・記録しない会話の終了の知らせ。notice-sink.ts）に入った知らせを、
// 1. 流れの表示（キャンバスの物・区切りにつないだ要約）の後始末へ渡す（canvas-stream.ts の applyNotice。版を進める）。
// 2. そのとき開いている WSS の購読へ `{type:"notice"}` として渡す（event-stream.ts が接続範囲を確かめた後の購読だけを
//    登録する）。購読のない端末・切れた接続には送らない。イベントの記録（cursor）に入れず、溜めず、再送しない
//    （本人の決定 2026-11-01、U168）。取り逃した端末の表示は版と getCanvas で収束し、忘却台帳は次の接続の同期で追いつく。
// 3. 起動の設定で渡された受け取り口（試験・診断。CoreRetentionOptions.notices）へもそのまま渡す。
//
// 端末へ送る知らせから、RetentionNotice の source_item（元サービスの生の ID。expiry-store の notice_item_id は
// remote_id）を除く。除いて空になった知らせは送らない。本文・要約・検索語・HMAC は今の知らせの型にない。送る前に
// 契約（EventStreamMessage）で形を確かめ、合わなければ送らない。配信の失敗は元の処理（掃除・忘却）の失敗にしない。

import type { EventStreamMessage, RetentionNoticeItem } from '@buddy/contracts';
import type { ApiContract } from './api-contract.js';
import { createApiContract } from './api-contract.js';
import type { Notice, NoticeSink } from './notice-sink.js';

export type StreamNoticeMessage = Extract<
  EventStreamMessage,
  { type: 'notice' }
>;

// WSS の購読の口（event-stream.ts の EventStreamOptions.notices）。受け手は送れなかった（閉じた・詰まった）ときだけ false を返す。
export type NoticeListener = (message: StreamNoticeMessage) => unknown;

export interface NoticeNotifier {
  subscribe(listener: NoticeListener): () => void;
}

// 端末へ送る形にする。source_item を除き、除いて空なら null（送らない）。
export function streamNoticeOf(notice: Notice): StreamNoticeMessage | null {
  if (notice.schema !== 'buddy.retention-notice.v1')
    return { type: 'notice', notice };
  const items = notice.items.filter(
    (item: RetentionNoticeItem) => item.item_kind !== 'source_item',
  );
  const [first, ...rest] = items;
  if (first === undefined) return null;
  return { type: 'notice', notice: { ...notice, items: [first, ...rest] } };
}

export interface NoticeRelayOptions {
  // 起動の設定で渡された受け取り口（試験・診断）。なければ渡さない。
  readonly downstream?: NoticeSink;
  readonly contract?: ApiContract;
  readonly log?: (message: string) => void;
}

export class NoticeRelay implements NoticeSink, NoticeNotifier {
  readonly #options: NoticeRelayOptions;
  readonly #listeners = new Set<NoticeListener>();
  #contract: ApiContract | null;
  // 流れの表示の後始末（Core が HTTPS の受付と流れの経路を作った後に付ける）。false は当てられなかったこと。
  #display: ((notice: Notice) => boolean) | null = null;

  constructor(options: NoticeRelayOptions = {}) {
    this.#options = options;
    this.#contract = options.contract ?? null;
  }

  // 流れの表示の後始末を付ける（1 つだけ。付け直すと前のものを外す）。
  attachDisplay(handler: (notice: Notice) => boolean): void {
    this.#display = handler;
  }

  subscribe(listener: NoticeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // 開いている購読の数（試験・診断）。
  get listenerCount(): number {
    return this.#listeners.size;
  }

  publish(notice: Notice): void | Promise<void> {
    // 1. 表示の後始末を先に行う（版の知らせが先に届き、notice を受けた端末が取る getCanvas が消した後の記述になる）。
    const display = this.#display;
    if (display !== null) {
      let applied: boolean;
      try {
        applied = display(notice);
      } catch {
        applied = false;
      }
      if (!applied)
        this.#log(
          '知らせに合わせてキャンバスを片付けられませんでした（掃除・忘却には影響しません）。',
        );
    }
    // 2. 開いている購読へ。購読がなければ形の検査もしない（溜めない・再送しない）。
    if (this.#listeners.size > 0) {
      const message = streamNoticeOf(notice);
      if (message !== null) {
        this.#contract ??= createApiContract();
        if (this.#contract.valid('EventStreamMessage', message)) {
          for (const listener of [...this.#listeners]) {
            try {
              listener(message);
            } catch {
              // 1 つの購読の失敗で他の購読を止めない。
            }
          }
        } else
          this.#log(
            '契約に合わない知らせを端末へ送りませんでした（掃除・忘却には影響しません）。',
          );
      }
    }
    // 3. 起動の設定で渡された受け取り口。結果（Promise）は呼び出し側へ返す（失敗のログは呼び出し側が出す）。
    return this.#options.downstream?.publish(notice);
  }

  // 気づきの増減の知らせ（CandidateNotice、ADR 0196）を、開いている購読へだけ渡す。流れの表示の後始末・起動の設定の受け取り口へは
  // 渡さない（キャンバス・掃除と関係しない）。契約に合わなければ送らない。渡せた購読の数を返す（購読がなければ 0。溜めない・
  // 再送しない）。
  publishCandidate(message: StreamNoticeMessage): number {
    if (
      message.notice.schema !== 'buddy.candidate-notice.v1' ||
      this.#listeners.size === 0
    )
      return 0;
    this.#contract ??= createApiContract();
    if (!this.#contract.valid('EventStreamMessage', message)) {
      this.#log('契約に合わない気づきの知らせを端末へ送りませんでした。');
      return 0;
    }
    let handed = 0;
    for (const listener of [...this.#listeners]) {
      try {
        if (listener(message) !== false) handed += 1;
      } catch {
        // 1 つの購読の失敗で他の購読を止めない。
      }
    }
    return handed;
  }

  #log(message: string): void {
    this.#options.log?.(message);
  }
}
