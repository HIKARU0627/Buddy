// デスクトップの main のキャンバスの経路（UI-03、ADR 0032）。キャンバスのモード（開発用のフラグ）のときだけ使う。
//
// - 発言: 入力バーの desktop.turn_submit を、会話ではなく流れ（POST /v1/stream/turns）へ送る。区切り・会話の ID は
//   中枢が選ぶので送らない。画面へ返すのは文字の結果だけ（操作の参照は OperationBridge の参照の規則のまま）。
// - 記述: 中枢の canvas の知らせ（版だけ）・接続・ロック解除のたびに、GET /v1/canvas で今の記述を取る。正本は中枢で、
//   main は取った記述を Ajv（CanvasDocument）と domain（canvasDocumentErrors）の両方で検査してから使う。どちらかに
//   反すれば捨て、前に渡した版が残る（画面の記述は変えない）。
// - 画面へ渡す記述: 表示対象の参照（予定・メールの ID）は、main が作った不透明な参照に置き換える。中枢の識別子は
//   main の中にだけ持ち、画面・ログに出さない。記述はキャンバスの窓だけに通知する（役割の表）。
// - 世代（ロック・切断・世代の変化）: reset で記述と参照を捨て、画面へ「空」を通知する。非同期の取得・発言は各 await の
//   後に世代・取得の順・ロック状態を照合する（ADR 0031 と同じ。またいだ応答は何も変えない）。取得は後に始めたものだけが
//   有効で、古い応答で新しい記述を戻さない。版は戻さない（同じ世代の中で小さい版を受けない）。
// Electron に依存しない（node:test で試験する）。
import type {
  CanvasDocument,
  DesktopCanvasView,
  DesktopTurnResult,
  StreamTurnResponse,
} from '@buddy/contracts';
import type { ClientConnection } from '@buddy/client';
import { canvasDocumentErrors } from '@buddy/domain';
import type { DesktopIpcRejectReason } from '@buddy/domain';
import type { DesktopContract } from './contract.js';
import type { BridgeOutcome } from './operation-bridge.js';

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

  // 中枢から版の知らせ（本文なし）が届いた。持っている版より新しければ取りに行く。
  onRevision(revision: string): void {
    if (!this.#host.unlocked()) return;
    if (this.#view !== null && !newer(revision, this.#view.canvas_revision))
      return;
    void this.refresh();
  }

  // 中枢から今の記述を取り、検査を通ったときだけ画面へ渡す。読み取りだけで、中枢の記述は変えない。
  async refresh(): Promise<void> {
    const connection = this.#host.connection();
    if (connection === null || !this.#host.unlocked()) return;
    const gen = this.#gen;
    const seq = ++this.#fetchSeq;
    const outcome = await connection.request({
      method: 'GET',
      path: '/v1/canvas',
    });
    // 世代をまたいだ・後から始めた取得がある・ロックした: 何も変えない。
    if (gen !== this.#gen || seq !== this.#fetchSeq || !this.#host.unlocked())
      return;
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
