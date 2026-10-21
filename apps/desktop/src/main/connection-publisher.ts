// 中枢との接続の状態を状態欄と画面へ送る手順（electron/main.ts の pushConnection。ADR 0025、レビューの指摘 L8）。
//
// - 状態欄の更新（refreshHub = controller.setHub）が状態欄の通知を出し、その通知の処理がもう一度送る処理を
//   呼ぶ（再入）と、同じ接続の通知を二重に送っていた。送っている途中に呼ばれたら、今の送りが終わった後に
//   もう一度だけ組み立て直す（最新の値にする）。
// - 前回送った通知と同じ内容は送らない。画面を読み込み直したとき（前回の値を持っていない）は reset で忘れる。
// Electron に依存しない（node:test で試験する）。

export interface ConnectionPublisherOptions<T> {
  // 状態欄の中枢の欄を今の接続の状態にそろえる（状態欄の通知を出すことがある）。
  readonly refreshHub: () => void;
  // 送る通知を組み立てる。送らないなら null。
  readonly build: () => T | null;
  readonly send: (notification: T) => void;
}

// 再入が続いても組み立て直しは有限回にする（同じ値なら送らないので、通常は 2 回で終わる）。
const MAX_ROUNDS = 4;

export class ConnectionPublisher<T> {
  readonly #options: ConnectionPublisherOptions<T>;
  #running = false;
  #again = false;
  #last: string | null = null;

  constructor(options: ConnectionPublisherOptions<T>) {
    this.#options = options;
  }

  publish(): void {
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        this.#again = false;
        this.#options.refreshHub();
        const notification = this.#options.build();
        if (notification !== null) {
          const text = JSON.stringify(notification);
          if (text !== this.#last) {
            this.#last = text;
            this.#options.send(notification);
          }
        }
        if (!this.#again) break;
      }
    } finally {
      this.#running = false;
    }
  }

  // 画面を読み込み直した（前回送った値を画面が持っていない）。次の publish は同じ内容でも送る。
  reset(): void {
    this.#last = null;
  }
}
