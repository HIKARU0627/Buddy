// 安全停止の知らせ（U315、ADR 0198。設計 01 いつも見える状態、03「取り消しと安全停止」）。
//
// - 安全停止の正本は DB の safety_breaker（止める・再開するたびに safety_revision が進む）。Core は、安全停止を変え得る
//   書込み（操作の命令 operation.* と停止の解除 safety.resume）が終わるたびに今の版を読み、前に読んだ版と違えば、開いている
//   WSS の購読へ SafetyNotice を 1 回送る。
// - 知らせには停止の理由・状態・版・操作の ID を入れない（ID と時刻だけ）。端末は受けたら自動実行の一覧（GET /v1/auto-actions）を
//   読み直し、状態欄の安全停止を出す。知らせを状態の正本にしない。
// - 溜めない・再送しない（ADR 0187 の notice と同じ）。購読がない間に変わった分は、端末が接続した・ロックを解除したときの
//   読み取りで追いつく。読めなかった（DB worker が使えない）ときは前の版のまま何も送らない（読めないことを「変わった」に
//   しない。次の書込みで読み直す）。
// - 読み取りは 1 つずつ。読んでいる間に届いた知らせは、読み終えた後にもう一度だけ読む（取りこぼさない・重ねない）。
// - ロック中・記録しない会話の間も送る（本文を持たない。端末はロック中は読まない）。

import type { StreamNoticeMessage } from './notice-relay.js';

export interface SafetyNoticesOptions {
  // 安全停止の今の版。読めなければ null。
  readonly read: () => Promise<string | null>;
  // 開いている購読へ渡す（渡せた購読の数を返す。購読がなければ 0）。
  readonly send: (message: StreamNoticeMessage) => number;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly log?: (message: string) => void;
}

export interface SafetyNotices {
  // 起動のときの版を読む（これより後の変化だけを知らせる）。
  start(): Promise<void>;
  // 安全停止を変え得る書込みが終わった。今の版を読み、変わっていれば知らせる。
  observe(): void;
  // 進行中の読み取りが終わるまで待つ（試験・停止）。
  idle(): Promise<void>;
  // 以後は読まない・送らない。
  close(): void;
}

export function createSafetyNotices(
  options: SafetyNoticesOptions,
): SafetyNotices {
  let known: string | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let closed = false;

  const readSafely = async (): Promise<string | null> => {
    try {
      return await options.read();
    } catch {
      return null;
    }
  };

  const check = async (): Promise<void> => {
    const revision = await readSafely();
    if (closed || revision === null || revision === known) return;
    known = revision;
    const handed = options.send({
      type: 'notice',
      notice: {
        schema: 'buddy.safety-notice.v1',
        notice_id: options.newId(),
        occurred_at: options.now().toISOString(),
      },
    });
    if (handed === 0)
      options.log?.(
        '安全停止の状態が変わりましたが、開いている購読がないため知らせを送りませんでした（端末は接続・ロック解除のときに読み直します）。',
      );
  };

  return {
    async start() {
      known = await readSafely();
    },
    observe() {
      if (closed) return;
      if (running !== null) {
        again = true;
        return;
      }
      running = (async () => {
        try {
          do {
            again = false;
            await check();
          } while (again && !closed);
        } finally {
          running = null;
        }
      })();
    },
    async idle() {
      while (running !== null) await running;
    },
    close() {
      closed = true;
    },
  };
}
