// 記録しない会話の独立した確認の画面の状態（ADR 0197、U503。ADR 0045 の確認の画面）。React と DOM に依存しない純粋な関数と
// 小さな店で、node:test で試験する。
//
// - 確認の一覧は main が参照つきで通知する値（connection.private_confirmations）で、ここは持たない。記録しない会話の間だけ
//   main が出す。画面が持つのは参照（ref）と表示用の値だけ（確認の ID・内容の hash は main が持つ）。
// - 承認・断るは本人の画面操作。承認は main が OS の確認ダイアログを 1 回だけ出す。送っている行はもう押させない。
// - 結果（承認した・記録できなかった・結果が分からない・断った・拒否）は欄の下に 1 つだけ出す（行は一覧から消えるので）。
// - 出せない間（ロック・切断・記録しない会話の外）は、送っている印と結果の文言を捨てる。世代をまたいだ応答は反映しない。
import type {
  DesktopIpcRequest,
  DesktopIpcResponse,
  DesktopPrivateConfirmationEntry,
} from '@buddy/contracts';
import { request } from '../desktop-api.js';
import { PRIVATE_CONFIRMATION_LABELS, rejectMessage } from '../labels.js';
import type { Notice } from './work-state.js';

export interface PrivateConfirmationRow {
  readonly ref: string;
  readonly title: string;
  // 対象のメールを見分ける行（件名・差出人）。確かめられなければ空。
  readonly target: readonly string[];
  // 何をどう変えるか（付ける・外すラベル）。
  readonly changes: readonly string[];
  readonly approvable: boolean;
  // 結果を確かめている（main が送れない）。
  readonly held: boolean;
}

// 行に出す値（main から受け取った値だけ）。
export function privateConfirmationRows(
  entries: readonly DesktopPrivateConfirmationEntry[],
): PrivateConfirmationRow[] {
  const L = PRIVATE_CONFIRMATION_LABELS;
  return entries.map((entry) => {
    const target: string[] = [];
    if (entry.target?.subject != null)
      target.push(`${L.subject}: ${entry.target.subject}`);
    if (entry.target?.sender != null)
      target.push(`${L.sender}: ${entry.target.sender}`);
    const changes: string[] = [];
    if (entry.labels_add.length > 0)
      changes.push(`${L.add}: ${entry.labels_add.join('、')}`);
    if (entry.labels_remove.length > 0)
      changes.push(`${L.remove}: ${entry.labels_remove.join('、')}`);
    return {
      ref: entry.ref,
      title: L.operation,
      target,
      changes,
      approvable: entry.approvable,
      held: entry.delivery_unknown,
    };
  });
}

// 承認できるか（送っていない・保留でない・確かめられた・入出力が止まっていない）。断るは止まっていてもできる。
export function canApprove(
  row: PrivateConfirmationRow,
  busy: boolean,
  stopped: boolean,
): boolean {
  return row.approvable && !row.held && !busy && !stopped;
}

export function canDecline(
  row: PrivateConfirmationRow,
  busy: boolean,
): boolean {
  return !row.held && !busy;
}

// 承認の読み上げの名前（見える文字に何を変えるかを足す）。
export function decisionLabel(
  verb: string,
  row: PrivateConfirmationRow,
): string {
  const what = row.changes.join('・');
  return `${verb}（${row.title}${what === '' ? '' : `・${what}`}）`;
}

// 応答から欄の下の文言を作る。
export function decisionNotice(response: DesktopIpcResponse): Notice {
  const L = PRIVATE_CONFIRMATION_LABELS;
  if (response.outcome === 'rejected')
    return {
      tone: 'warning',
      text: rejectMessage(
        'desktop.private_confirmation_decide',
        response.reason,
      ),
    };
  if (
    response.channel === 'desktop.private_confirmation_decide' &&
    'result' in response
  )
    switch (response.result) {
      case 'recorded':
        return { tone: 'success', text: L.recorded };
      case 'declined':
        return { tone: 'success', text: L.declined };
      case 'record_failed':
        return { tone: 'warning', text: L.recordFailed };
      case 'record_unknown':
        return { tone: 'warning', text: L.recordUnknown };
    }
  return {
    tone: 'warning',
    text: rejectMessage(
      'desktop.private_confirmation_decide',
      'invalid_request',
    ),
  };
}

export interface PrivateConfirmationViewState {
  // 送っている行の参照。
  readonly busy: readonly string[];
  // 最後の結果の文言（欄の下に 1 つ）。
  readonly notice: Notice | null;
}

const EMPTY: PrivateConfirmationViewState = { busy: [], notice: null };

export interface PrivateConfirmationActions {
  readonly decide: (ref: string, decision: 'approve' | 'decline') => void;
}

// 承認・断るを送る小さな店（WorkStore・BudgetStore と同じ形: 世代をまたいだ応答は捨てる）。
export class PrivateConfirmationStore {
  readonly #api: {
    invoke(request: DesktopIpcRequest): Promise<DesktopIpcResponse>;
  };
  #state: PrivateConfirmationViewState = EMPTY;
  #gen = 0;
  readonly #listeners = new Set<() => void>();
  readonly actions: PrivateConfirmationActions;

  constructor(api: {
    invoke(request: DesktopIpcRequest): Promise<DesktopIpcResponse>;
  }) {
    this.#api = api;
    this.actions = {
      decide: (ref, decision) => this.#decide(ref, decision),
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly snapshot = (): PrivateConfirmationViewState => this.#state;

  // 出せない間（ロック・切断・記録しない会話の外）: 送っている印と文言を捨て、送った要求の応答を反映しない。
  hide(): void {
    this.#gen += 1;
    this.#set(EMPTY);
  }

  #set(next: PrivateConfirmationViewState): void {
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  #decide(ref: string, decision: 'approve' | 'decline'): void {
    if (this.#state.busy.includes(ref)) return;
    const gen = this.#gen;
    this.#set({ busy: [...this.#state.busy, ref], notice: null });
    const done = (notice: Notice) => {
      if (gen !== this.#gen) return;
      this.#set({
        busy: this.#state.busy.filter((candidate) => candidate !== ref),
        notice,
      });
    };
    this.#api
      .invoke(request('desktop.private_confirmation_decide', { ref, decision }))
      .then(
        (response) => done(decisionNotice(response)),
        () =>
          done({
            tone: 'warning',
            text: rejectMessage(
              'desktop.private_confirmation_decide',
              'outcome_unknown',
            ),
          }),
      );
  }
}

// 島の数え方に足す確認の数（承認を待つ確認。結果を確かめている確認も本人の対応が要るので数える）。
export function privateAttentionCount(
  entries: readonly DesktopPrivateConfirmationEntry[] | undefined,
): number {
  return entries?.length ?? 0;
}
