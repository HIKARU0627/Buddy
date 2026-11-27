// デスクトップの main の流れの表示先（「このPCに出す」）の経路（UI-05 の段階 5、ADR 0193。設計 07 §2・§5、ADR 0032・
// 0046・0068・0188）。
//
// - 表示先の正本は中枢。main は中枢の流れの経路（GET・POST /v1/stream/handoff）を読む・呼ぶだけで、画面へは状態欄の
//   display_target（この端末・他の端末）として渡す。端末の ID・表示先の版・会話の ID は main だけが持ち、画面へ渡さない
//   （応答の session_id は流れに会話を見せない固定の印で、読まない。UI-01）。
// - 読む時: 接続した（live になった）・ロックを解除した・表示のリースの状態が変わった（取れた・失った）・移動の結果が
//   分からなかった・移動が拒否された。読めなかったら前の値のまま（読めなかったことを「他の端末」の証拠にしない）。
// - 移す（handoff）は本人の画面操作だけ（受付は core-link が admitDesktopRequest で確かめる）。移す先はこの端末だけで、
//   中枢の今の版（expected_route_revision）を直前に読んで添える。読めなければ送らない。結果が分からなければ送り直さず、
//   読み直して本人がもう一度押す。版が合わない（他の端末が先に移した。409）ときも自動では送り直さない（本人が今の表示先を
//   見て決める）。
// - 世代（ロック・切断）: reset で値を捨て、非同期の読み取り・移動は世代を照合して、またいだ結果を反映しない。
// - ログは理由のコードだけ（端末の ID・版は出さない）。
// Electron に依存しない（node:test で試験する）。
import type { HandoffState } from '@buddy/contracts';
import { STREAM_UNDECIDED_ID } from '@buddy/domain';
import type { ClientConnection } from '@buddy/client';
import type { DesktopContract } from './contract.js';
import type { BridgeOutcome } from './operation-bridge.js';

// 中枢が表示先を決めていないときの display_device_id（全て 0 の ID。Core と同じ domain の定数）。
const UNDECIDED = STREAM_UNDECIDED_ID;

export type DisplayTarget = 'this_device' | 'other_device';

export interface DisplayRouteHost {
  readonly contract: DesktopContract;
  readonly connection: () => ClientConnection | null;
  // 表示のリースを今持っているか（表示先が未決定のとき、持っている端末はこの端末に出していると言える）。
  readonly leaseHeld: () => boolean;
  // 画面に出す値が変わった（状態欄を作り直して通知する）。
  readonly changed: () => void;
  readonly log: (code: string) => void;
}

interface RouteView {
  readonly revision: string;
  // 決まっていなければ null。
  readonly deviceId: string | null;
}

const fail = (
  reason: Extract<BridgeOutcome<never>, { ok: false }>['reason'],
): Extract<BridgeOutcome<never>, { ok: false }> => ({ ok: false, reason });

export class DisplayRouteBridge {
  readonly #host: DisplayRouteHost;
  #route: RouteView | null = null;
  // 表示の権限の世代（ロック・切断で進める）。
  #gen = 0;
  // 読み取りの通し番号。後から始めた読み取り・移動の結果より古い読み取りの結果を反映しない。
  #seq = 0;
  #applied = 0;

  constructor(host: DisplayRouteHost) {
    this.#host = host;
  }

  // 状態欄の表示先。中枢から読めていなければ null（不明）。表示先が未決定なら、表示のリースを持っている間だけこの端末
  // （端末ごとに表示のリースを渡す今までの動き。U473）。決まっていれば、その端末がこの端末か。
  get target(): DisplayTarget | null {
    const route = this.#route;
    if (route === null) return null;
    if (route.deviceId === null)
      return this.#host.leaseHeld() ? 'this_device' : null;
    return route.deviceId === this.#ownDeviceId()
      ? 'this_device'
      : 'other_device';
  }

  // ロック・切断: 値を捨て、またいだ結果を反映しない。
  reset(): void {
    this.#gen += 1;
    this.#set(null, ++this.#seq);
  }

  // 中枢の今の表示先を読む。読めなかった（送れない・結果不明・形の違う応答・拒否）ときは前の値のまま。
  async refresh(): Promise<void> {
    const gen = this.#gen;
    const read = await this.#read();
    if (gen !== this.#gen || read === null) return;
    this.#set(read.view, read.seq);
  }

  // この端末へ表示先を移す（本人の画面操作。受付は呼び出し側が確かめる）。受け付けられたら中枢が返した移動の状態を返す。
  async handoff(): Promise<BridgeOutcome<'moving' | 'completed'>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    const deviceId = connection?.state.deviceId ?? null;
    if (connection === null || scope === null || deviceId === null)
      return fail('not_connected');
    // 直前に中枢の今の版を読む（読めなければ移さない。版は画面が持たない）。
    const read = await this.#read();
    if (gen !== this.#gen) return fail('outcome_unknown');
    if (read === null) return fail('core_rejected');
    this.#set(read.view, read.seq);
    const seq = ++this.#seq;
    const outcome = await connection.request({
      method: 'POST',
      path: '/v1/stream/handoff',
      body: {
        target_device_id: deviceId,
        expected_route_revision: read.view.revision,
      },
      scoped: true,
      screenOperation: true,
      expectedScopeId: scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    // 送った後に世代が変わった（ロック・切断）: 結果を画面へ返さない。移ったかは分からない。
    if (gen !== this.#gen) return fail('outcome_unknown');
    if (outcome.kind === 'unknown') {
      // 移ったか分からない。送り直さず、今の表示先を読み直す（本人がもう一度押すかを決める）。
      this.#host.log('display_handoff_unknown');
      void this.refresh();
      return fail('outcome_unknown');
    }
    const view = this.#view(outcome.body, 202, outcome.status);
    if (view === null) {
      // 中枢が拒否した（版が合わない 409・止まっている端末 409・画面操作でない 403 など）。表示を中枢の値にそろえる。
      this.#host.log(`display_handoff_rejected:${String(outcome.status)}`);
      void this.refresh();
      return fail('core_rejected');
    }
    this.#set(
      { revision: view.route_revision, deviceId: this.#deviceOf(view) },
      seq,
    );
    return { ok: true, value: view.state };
  }

  #ownDeviceId(): string | null {
    return this.#host.connection()?.state.deviceId ?? null;
  }

  #deviceOf(view: HandoffState): string | null {
    return view.display_device_id === UNDECIDED ? null : view.display_device_id;
  }

  // 応答（想定する状態 200・202）が契約に合うときだけ HandoffState を返す。
  #view(body: unknown, expectedStatus: number, status: number) {
    if (
      status !== expectedStatus ||
      !this.#host.contract.valid('HandoffState', body)
    )
      return null;
    return body as HandoffState;
  }

  async #read(): Promise<{ view: RouteView; seq: number } | null> {
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return null;
    const seq = ++this.#seq;
    const outcome = await connection.request({
      method: 'GET',
      path: '/v1/stream/handoff',
      expectedScopeId: scope,
    });
    if (outcome.kind !== 'response') {
      this.#host.log(`display_route_read_failed:${outcome.kind}`);
      return null;
    }
    const view = this.#view(outcome.body, 200, outcome.status);
    if (view === null) {
      this.#host.log(`display_route_read_failed:${String(outcome.status)}`);
      return null;
    }
    return {
      view: { revision: view.route_revision, deviceId: this.#deviceOf(view) },
      seq,
    };
  }

  #set(route: RouteView | null, seq: number): void {
    // 後から始めた読み取り・移動の結果を、先に始めた読み取りの結果で戻さない。
    if (seq < this.#applied) return;
    this.#applied = seq;
    const before = this.target;
    const same =
      route === this.#route ||
      (route !== null &&
        this.#route !== null &&
        route.revision === this.#route.revision &&
        route.deviceId === this.#route.deviceId);
    this.#route = route;
    if (same && before === this.target) return;
    this.#host.changed();
  }

  // 表示のリースの状態が変わった（取れた・失った）。未決定のときの表示先の値が変わるので知らせる。
  leaseChanged(): void {
    this.#host.changed();
  }
}
