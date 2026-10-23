// デスクトップの main のキャンバスの経路（UI-03、ADR 0032）。キャンバスのモード（開発用のフラグ）のときだけ使う。
//
// - 発言: 入力バーの desktop.turn_submit を、会話ではなく流れ（POST /v1/stream/turns）へ送る。区切り・会話の ID は
//   中枢が選ぶので送らない。画面へ返すのは文字の結果だけ（操作の参照は OperationBridge の参照の規則のまま）。
// - 記述: 中枢の canvas の知らせ（版だけ）・接続・ロック解除のたびに、GET /v1/canvas で今の記述を取る。正本は中枢で、
//   main は取った記述を Ajv（CanvasDocument）と domain（canvasDocumentErrors）の両方で検査してから使う。どちらかに
//   反すれば捨て、前に渡した版が残る（画面の記述は変えない）。
// - 画面へ渡す記述: 表示対象の参照（予定・メールの ID）は、main が作った不透明な参照に置き換える。中枢の識別子は
//   main の中にだけ持ち、画面・ログに出さない。記述はキャンバスの窓だけに通知する（役割の表）。
// - ユーザーの操作（UI-06）: 画面が描いている版を添えて POST /v1/canvas/user-ops へ送る。物の名前（キャンバスの中だけの
//   名前）とマスだけで、中枢の識別子・本文は送らない。古い版で物が変わっていれば canvas_conflict にして記述を取り直す。
// - 世代（ロック・停止・切断・世代の変化）: reset で記述と参照を捨て、画面へ「空」を通知する。非同期の取得・発言は各 await の
//   後に世代・取得の順・ロック状態を照合する（ADR 0031 と同じ。またいだ応答は何も変えない）。取得は後に始めたものだけが
//   有効で、古い応答で新しい記述を戻さない。版は戻さない（同じ世代の中で小さい版を受けない）。
// Electron に依存しない（node:test で試験する）。
import type {
  CanvasContent,
  CanvasContentResponse,
  CanvasDocument,
  CanvasUserOp,
  CanvasUserOpResponse,
  DesktopCanvasView,
  DesktopTurnResult,
  StreamTurnResponse,
} from '@buddy/contracts';
import type { ClientConnection } from '@buddy/client';
import { canvasContentErrors, canvasDocumentErrors } from '@buddy/domain';
import type { DesktopIpcRejectReason } from '@buddy/domain';
import type { DesktopContract } from './contract.js';
import type { BridgeOutcome } from './operation-bridge.js';

// 物の中身の読み取りの結果（UI-07）。この値だけが本文を運び、画面へは desktop.canvas_content の応答でだけ返す。
export interface CanvasContentValue {
  readonly canvas_revision: string;
  readonly item_id: string;
  readonly open_index: number | null;
  readonly content: CanvasContent;
}

export interface CanvasHost {
  readonly contract: DesktopContract;
  readonly connection: () => ClientConnection | null;
  // 不透明な参照（UUID v4 の形）を作る。
  readonly newRef: () => string;
  // ロック解除済みか（ロック中・不明は取得も発言の結果の反映もしない）。
  readonly unlocked: () => boolean;
  // 端末の今の入出力の状態（送る直前に確かめる）。permitted は停止していないこと。
  readonly io: () => { readonly permitted: boolean; readonly epoch: string };
  // 画面（キャンバスの窓）へ記述を渡す。null は描いている物をすべて捨てる。
  readonly publish: (canvas: DesktopCanvasView | null) => void;
  // 発言の文字の結果を画面に出す値にする（OperationBridge と同じ規則）。
  readonly turnResult: (turn: StreamTurnResponse) => DesktopTurnResult;
  readonly log: (code: string) => void;
}

const fail = (
  reason: DesktopIpcRejectReason,
): { readonly ok: false; readonly reason: DesktopIpcRejectReason } => ({
  ok: false,
  reason,
});

const newer = (a: string, b: string): boolean => BigInt(a) > BigInt(b);

export class CanvasBridge {
  readonly #host: CanvasHost;
  // 表示の権限の世代。reset で進める。
  #gen = 0;
  // 取得の順。取得を始めるたびに進め、最後に始めたものだけを使う。
  #fetchSeq = 0;
  #view: DesktopCanvasView | null = null;
  // 最後に見た入出力の世代（io_epoch）。停止（世代が進む）をまたいだ記述は使わない。
  #epoch: string | null = null;
  // 最後に見た入出力の許可（停止していないか）。null は未確認。
  #permitted: boolean | null = null;
  // 進行中の取得（試験が通知の処理の完了を待つため。idle）。
  readonly #inflight = new Set<Promise<void>>();
  // 画面に渡した参照 → 中枢の識別子（main の中だけ。物を開くときに main が解決する。UI-07 以降）。
  #refs = new Map<string, { readonly kind: string; readonly id: string }>();

  constructor(host: CanvasHost) {
    this.#host = host;
  }

  // 今の画面へ渡した記述（読み込み直した窓へ送る）。
  get view(): DesktopCanvasView | null {
    return this.#view;
  }

  // 試験用: 画面へ渡した参照の数。
  get refCount(): number {
    return this.#refs.size;
  }

  // 表示の権限の世代が進んだ（ロック・切断・世代の変化）: 記述・参照を捨て、画面へ空を通知する。
  // 進行中の取得・発言は、世代の照合で何も変えずに終わる。
  reset(): void {
    this.#gen += 1;
    this.#fetchSeq += 1;
    this.#refs = new Map();
    if (this.#view === null) return;
    this.#view = null;
    this.#host.publish(null);
  }

  // 入出力の状態（停止・io_epoch）が変わった。停止中・世代が進んだときは記述と参照を捨てる（ロックと同じ。ADR 0032 の
  // 「停止で隠す」）。再開して記述がなければ取り直す。
  ioChanged(): void {
    const io = this.#host.io();
    const epochChanged = this.#epoch !== null && this.#epoch !== io.epoch;
    // 停止の状態が実際に変わったか（最初の通知は、停止中のときだけ変わったとみなす）。
    const stopChanged =
      this.#permitted === null
        ? !io.permitted
        : this.#permitted !== io.permitted;
    this.#epoch = io.epoch;
    this.#permitted = io.permitted;
    // 入出力と関係のない状態の更新（中枢の最終確認の時刻だけが変わったなど）では何もしない。進行中の取得を捨てず、
    // 取得を増やさない（先の取得が成功しても順序の照合で捨てられ、後の取得が失敗して空になるのを避ける）。
    if (!epochChanged && !stopChanged) return;
    if (!io.permitted || epochChanged) this.reset();
    if (io.permitted && this.#view === null) void this.refresh();
  }

  // 画面が通知を受け取る準備を終えた（キャンバスの窓が読み込み直した・購読を始めた）。今の記述を送り直す。記述がなければ
  // 取り直す。通知が購読より先に来て取り逃した画面を、次の変更まで空のままにしない。
  resend(): void {
    if (this.#view !== null) this.#host.publish(this.#view);
    else void this.refresh();
  }

  // 進行中の取得がすべて終わるまで待つ（試験用。通知の処理の完了と同期する）。
  async idle(): Promise<void> {
    while (this.#inflight.size > 0)
      await Promise.allSettled([...this.#inflight]);
  }

  // 中枢から版の知らせ（本文なし）が届いた。持っている版より新しければ取りに行く。
  onRevision(revision: string): void {
    if (!this.#host.unlocked() || !this.#host.io().permitted) return;
    if (this.#view !== null && !newer(revision, this.#view.canvas_revision))
      return;
    void this.refresh();
  }

  // 中枢から今の記述を取り、検査を通ったときだけ画面へ渡す。読み取りだけで、中枢の記述は変えない。
  refresh(): Promise<void> {
    const run = this.#refresh();
    this.#inflight.add(run);
    const done = () => {
      this.#inflight.delete(run);
    };
    run.then(done, done);
    return run;
  }

  async #refresh(): Promise<void> {
    const connection = this.#host.connection();
    if (connection === null || !this.#host.unlocked()) return;
    // 停止中は取らない。停止をまたいだ（世代が進んだ）記述は捨てる。
    const io = this.#host.io();
    if (!io.permitted) return;
    if (this.#epoch !== null && this.#epoch !== io.epoch) this.reset();
    this.#epoch = io.epoch;
    this.#permitted = true;
    const gen = this.#gen;
    const seq = ++this.#fetchSeq;
    const outcome = await connection.request({
      method: 'GET',
      path: '/v1/canvas',
    });
    // 世代をまたいだ・後から始めた取得がある・ロックした: 何も変えない。
    if (gen !== this.#gen || seq !== this.#fetchSeq || !this.#host.unlocked())
      return;
    const after = this.#host.io();
    if (!after.permitted || after.epoch !== io.epoch) return;
    if (outcome.kind !== 'response' || outcome.status !== 200) {
      // 取れなかった。前の版を残す（捨てるのはロック・切断の世代の変化だけ）。
      this.#host.log('canvas_fetch_failed');
      return;
    }
    const document = this.#checked(outcome.body);
    if (document === null) {
      // 契約か意味の検査に反した。前の版を残し、画面へは渡さない。
      this.#host.log('canvas_document_rejected');
      return;
    }
    // 同じ世代の中で版は戻さない。同じ版は渡し直さない（参照を作り直さない）。
    if (
      this.#view !== null &&
      !newer(document.canvas_revision, this.#view.canvas_revision)
    )
      return;
    this.#adopt(document);
  }

  // Ajv（形式）と domain（意味）の両方を通った記述だけを返す。
  #checked(body: unknown): CanvasDocument | null {
    if (!this.#host.contract.valid('CanvasDocument', body)) return null;
    const document = body as CanvasDocument;
    return canvasDocumentErrors(document).length === 0 ? document : null;
  }

  // 参照を不透明な参照に置き換えて画面へ渡す。
  #adopt(document: CanvasDocument): void {
    const refs = new Map<string, { kind: string; id: string }>();
    const view: DesktopCanvasView = {
      canvas_revision: document.canvas_revision,
      reading_order: [...document.reading_order],
      // ユーザーの置き場所（UI-06）。物の名前とマスだけ。
      ...(document.user_pins === undefined
        ? {}
        : {
            user_pins: document.user_pins.map((pin) => ({
              item_id: pin.item_id,
              cell: { ...pin.cell },
            })),
          }),
      items: document.items.map((item) => ({
        ...item,
        data: {
          more_count: item.data.more_count,
          item_refs: item.data.item_refs.map((entry) => {
            const ref = this.#host.newRef();
            refs.set(ref, { kind: entry.kind, id: entry.id });
            return { kind: entry.kind, ref };
          }),
        },
      })),
    };
    // 画面へ渡す形の最後の確認（中枢の識別子が残っていれば Schema が拒否する）。
    if (!this.#host.contract.valid('DesktopCanvasView', view)) {
      this.#host.log('canvas_view_rejected');
      return;
    }
    this.#refs = refs;
    this.#view = view;
    this.#host.publish(view);
  }

  // ユーザーの操作（キャンバスの窓から。UI-06）。画面が描いている版（expected）を添えて中枢へ記録する。当てた後の版を返す。
  // 画面へ渡していない版（今の版より新しい・記述がない）は送らない。
  async userOp(
    expected: string,
    op: CanvasUserOp,
  ): Promise<BridgeOutcome<string>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    if (!this.#host.unlocked()) return fail('device_locked');
    if (!this.#host.io().permitted) return fail('input_stopped');
    if (this.#view === null || newer(expected, this.#view.canvas_revision))
      return fail('canvas_conflict');
    const outcome = await connection.request({
      method: 'POST',
      path: '/v1/canvas/user-ops',
      body: { expected_canvas_revision: expected, op },
      scoped: true,
      screenOperation: true,
      expectedScopeId: scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    // 送った後に世代が変わった・結果が分からない: 結果不明（自動では送り直さない）。
    if (gen !== this.#gen || outcome.kind === 'unknown')
      return fail('outcome_unknown');
    if (outcome.status === 409) {
      // 古い版への操作で物が変わっていた（捨てた）。今の記述を取り直す。
      void this.refresh();
      return fail('canvas_conflict');
    }
    if (
      outcome.status !== 200 ||
      !this.#host.contract.valid('CanvasUserOpResponse', outcome.body)
    )
      return fail('core_rejected');
    const applied = outcome.body as CanvasUserOpResponse;
    // 版の知らせも届くが、先に取る（画面の送信中の位置を早く解く）。
    void this.refresh();
    return { ok: true, value: applied.canvas_revision };
  }

  // 物の中身（本文）の読み取り（キャンバスの窓から。UI-07）。画面が描いている版（expected）の物について、中枢から許可範囲内で
  // 取り、形式（CanvasContentResponse）と意味（canvasContentErrors）の両方を通ったものだけを返す。本文は呼び出しの間の
  // メモリーにだけ置き、main は保存も記録もしない（中身は応答で画面へ返し、通知・ログに載せない）。openRef は本文を開く行の
  // 不透明な参照（画面に渡した ref）で、main が item_refs の位置にして中枢へ送る（中枢の識別子は画面にも中枢の要求にも
  // 出ない）。画面が描いている版と食い違う（物がない・版が違う・取得の間に版が進んだ）ときは canvas_conflict にして、
  // 取り直しは画面が新しい記述で行う。世代（ロック・停止・切断）が変わったら中身を渡さない。
  async content(
    itemId: string,
    expected: string,
    openRef: string | null,
  ): Promise<BridgeOutcome<CanvasContentValue>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    if (!this.#host.unlocked()) return fail('device_locked');
    if (!this.#host.io().permitted) return fail('input_stopped');
    const view = this.#view;
    if (view === null || expected !== view.canvas_revision)
      return fail('canvas_conflict');
    const item = view.items.find((entry) => entry.item_id === itemId);
    if (item === undefined) return fail('canvas_conflict');
    let openIndex: number | null = null;
    if (openRef !== null) {
      openIndex = item.data.item_refs.findIndex(
        (entry) => entry.ref === openRef,
      );
      // 本文を開けるのはメールだけ。画面に渡した参照でなければ送らない。
      if (openIndex < 0 || item.component !== 'mail_card')
        return fail('canvas_conflict');
    }
    const outcome = await connection.request({
      method: 'POST',
      path: '/v1/canvas/content',
      body: {
        expected_canvas_revision: expected,
        item_id: itemId,
        open_index: openIndex,
      },
      scoped: true,
      expectedScopeId: scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    // 世代が変わった（ロック・停止・切断）: 中身を渡さない。読み取りなので送り直してよいが、自動ではしない。
    if (gen !== this.#gen || !this.#host.unlocked())
      return fail(this.#host.unlocked() ? 'not_connected' : 'device_locked');
    const after = this.#host.io();
    if (!after.permitted) return fail('input_stopped');
    if (outcome.kind === 'unknown') return fail('not_connected');
    if (outcome.status === 409) {
      // 中枢の記述が先に進んでいた（参照の位置がずれる）。今の記述を取り直す。
      void this.refresh();
      return fail('canvas_conflict');
    }
    if (
      outcome.status !== 200 ||
      !this.#host.contract.valid('CanvasContentResponse', outcome.body)
    )
      return fail('core_rejected');
    const response = outcome.body as CanvasContentResponse;
    // 取っている間に画面の記述が進んだ・別の物の中身が返った: 渡さない。
    if (
      this.#view === null ||
      this.#view.canvas_revision !== expected ||
      response.canvas_revision !== expected ||
      response.item_id !== itemId ||
      response.open_index !== openIndex
    )
      return fail('canvas_conflict');
    if (
      canvasContentErrors(response.content, {
        component: item.component,
        refCount: item.data.item_refs.length,
        openIndex,
      }).length > 0
    ) {
      // 契約か意味の検査に反した。画面へは渡さない（ログは理由の種類だけ。中身を出さない）。
      this.#host.log('canvas_content_rejected');
      return fail('core_rejected');
    }
    return {
      ok: true,
      value: {
        canvas_revision: response.canvas_revision,
        item_id: response.item_id,
        open_index: response.open_index,
        content: response.content,
      },
    };
  }

  // 発言（入力バーから）。流れへ送り、文字の結果を返す。キャンバスの記述は版の知らせと取得で渡す
  // （応答の canvas を直接は使わない。正本は中枢で、取得のときに検査する）。
  async submitTurn(text: string): Promise<BridgeOutcome<DesktopTurnResult>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const io = this.#host.io();
    if (!io.permitted) return fail('input_stopped');
    const outcome = await connection.request({
      method: 'POST',
      path: '/v1/stream/turns',
      body: {
        text,
        input_kind: 'text',
        expected_canvas_revision: this.#view?.canvas_revision ?? '0',
      },
      scoped: true,
      expectedScopeId: scope,
    });
    // 送る前に送れなかった（未送信）だけを not_connected にする。送った後に世代が変わったときは、結果を画面へ返さず
    // 結果不明にする（未送信と答えると、同じ発言を別の要求として送り直し、二重に届く）。
    if (outcome.kind === 'not_sent') return fail('not_connected');
    if (gen !== this.#gen) return fail('outcome_unknown');
    // 発言は読み取り・聞き返し・承認待ちの操作の作成・キャンバスの配置だけで外部変更ではない。結果が分からなければ、
    // 自動では送り直さず、本人がもう一度送る。
    if (outcome.kind === 'unknown') return fail('outcome_unknown');
    if (
      outcome.status !== 200 ||
      !this.#host.contract.valid('StreamTurnResponse', outcome.body)
    )
      return fail('core_rejected');
    const turn = outcome.body as StreamTurnResponse;
    // 中枢が記述を変えた（版の知らせも届くが、先に取る）。
    if (turn.canvas !== null) void this.refresh();
    return { ok: true, value: this.#host.turnResult(turn) };
  }
}
