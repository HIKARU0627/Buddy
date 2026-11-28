// 記録しない会話の独立した確認と最小の操作記録（B06-07a-2 の 2d、ADR 0192。設計 03 記録しない会話の境界、ADR 0040・0045）。
//
// 記録しない区切りの間の外部変更を、会話の本文を保存しない独立した確認へ切り出す。確認の中身は Core が解決した確定済みの
// 変更（契約の OperationIntent）と内容の hash の 2 欄（ADR 0045、U67）。保存境界の保持者（StorageModeGate）が domain の
// 遷移（external_change_requested・confirmation_approved・confirmation_declined）を当て、返った命令をここで行う。
//
// - show_independent_confirmation: 確認を RAM に持つ（DB・ログに書かない）。終える・ロック・忘却・停止で捨てる。
// - record_minimal_operation: 画面での一度の承認の後に、最小の操作記録を DB に書く。operations.record_kind は
//   private_minimal、workflow_id は null（会話・依頼・区切りへたどれる値を持たない。0010 の制約）。確定済みの変更は
//   暗号化して operation_versions に置き（J5 で完了から 7 日後に消える。ADR 0040）、承認は画面の承認として記録する
//   （preview_id は記録のために新しく作った値。確認の ID は DB に書かない。U506）。区切りの ID・世代・発言・応答は書かない。書けたら通常の操作と同じ状態機械（実行担当）で続く
//   （送出・照合・結果不明の扱いは通常と同じ。結果不明を自動で再送しない）。
//
// 暫定（ADR 0192）:
// - 切り出すのはラベルの変更（mail.labels.change）だけ。返信の下書きは本文が本人の発言そのものなので切り出さず、決まった文で
//   断る（U502）。用事・メモ・記憶（LocalCommand）は切り出さない（U64）。
// - 確認を画面に出して承認を受ける経路（契約・API・画面。ADR 0197、U503）はできたが、口を開くかは本人の判断で、製品の
//   組み立てでは PRIVATE_CONFIRMATION_SCREEN_OPEN を false のまま、記録しない間の外部変更は今までどおり決まった文で断る。
//   試験の組み立てだけがこの口を開く。開く条件は ADR 0197 に書いた。
// - 確認には、頼んだ端末（RAM だけ。U600）と、画面で対象のメールを見分けるための表示用の値（口座の表示名・件名・差出人・
//   受信日時。提供元から読んだ値で RAM だけ）を添えて持つ。
// - 記録の書き込みに失敗したら、確認は承認済みのまま（再送は同じ結果を返す）で、自動でやり直さない（U505）。

import { randomUUID } from 'node:crypto';
import type {
  PrivateConfirmationView,
  PrivateMinimalRecord,
  StorageBoundaryRejection,
  StorageOrigin,
} from '@buddy/domain';
import { intentContentHash, sealOperationIntent } from '@buddy/storage';
import type {
  CreateOperationCommand,
  DataKeyProvider,
  DbCommand,
  DbSubmission,
} from '@buddy/storage';
import type { ApiContract } from './api-contract.js';
import type { StorageModeGate } from './storage-gate.js';

// 確認を画面に出して承認を受ける口（ADR 0197、U503）。経路（契約・API・画面）はできたが、開くかは本人の判断で、閉じたまま
// にする（忘却の公開ゲートと同じ扱い）。閉じている間、記録しない会話の外部変更は決まった文で断る（ADR 0190 の U483 のまま）。
// 開く条件は ADR 0197 の「口を開く条件」。
export const PRIVATE_CONFIRMATION_SCREEN_OPEN: boolean = false;

// 記録しない会話から独立した確認へ切り出す操作の種類（暫定。U502）。
export const PRIVATE_CONFIRMABLE_KINDS: readonly string[] = [
  'mail.labels.change',
];

export interface PrivateConfirmationDeskOptions {
  readonly gate: Pick<
    StorageModeGate,
    'confirmation' | 'dropConfirmations' | 'pendingConfirmations'
  >;
  readonly store: { submit(command: DbCommand): DbSubmission };
  readonly keyStore: DataKeyProvider;
  // 忘却台帳の世代（命令の forgetting_generation。保存層が transaction の中で今の値と照合する）。
  readonly forgettingGeneration: () => Promise<string>;
  readonly contract: ApiContract;
  readonly now: () => number;
  readonly newId?: () => string;
  // 最小の操作記録を書けた後に、実行担当へ渡す（通常の承認の後と同じ。OperationRunner.afterApproval）。
  readonly afterRecord?: (operationId: string) => void;
  readonly log?: (message: string) => void;
}

// 画面で対象のメールを見分けるための表示用の値（確認を出したときに提供元から読んだ値。RAM だけで、DB・ログに書かない）。
// 読めない項目は null（画面は対象を確認できないと言い、承認へ進ませない）。
export interface PrivateConfirmationDisplay {
  readonly account_label: string | null;
  readonly target: {
    readonly subject: string | null;
    readonly sender: string | null;
    readonly received_at: string | null;
  } | null;
}

export const NO_PRIVATE_DISPLAY: PrivateConfirmationDisplay = {
  account_label: null,
  target: null,
};

// 確認に添える値（頼んだ端末と表示用の値）。どちらも RAM だけ。
export interface PrivateConfirmationContext {
  // 確認を頼んだ発言の端末（認証した要求の端末）。承認・断るはこの端末だけ（U600）。null は端末が分からない（試験の直接の
  // 呼び出し）で、画面の経路からは承認できない。
  readonly device_id: string | null;
  readonly display: PrivateConfirmationDisplay;
}

// 確認の今の扱い（画面の経路が端末と内容を照合するために読む）。区切りの世代・操作の ID は Core の中だけで使う。
export interface PrivateConfirmationOwner {
  readonly state: 'pending' | 'approved' | 'declined';
  readonly device_id: string | null;
  readonly content_version: string;
  readonly content_hash: string;
  readonly segment_generation: string;
  readonly operation_id: string;
}

export type PrivateConfirmationRequest =
  | {
      readonly ok: true;
      readonly confirmation_id: string;
      readonly segment_generation: string;
    }
  | {
      readonly ok: false;
      readonly reason: StorageBoundaryRejection | 'closed' | 'not_confirmable';
      readonly errors: readonly string[];
    };

// 画面での承認（ADR 0045 の承認の形。route は screen だけで、時刻は Core が付ける）。確認を出した区切りの世代・操作の ID・
// 内容版・内容の hash は、画面が見た確認の値をそのまま返す（今の確認と 1 つでも違えば承認しない）。
export interface PrivateApprovalInput {
  readonly confirmation_id: string;
  readonly device_id: string;
  readonly segment_generation: string;
  readonly operation_id: string;
  readonly content_version: string;
  readonly content_hash: string;
}

export type PrivateApprovalOutcome =
  // 最小の操作記録を書き、実行担当へ渡した。
  | { readonly kind: 'recorded'; readonly operation_id: string }
  // 承認を受けたが、記録を書けなかった（外部変更は作っていない）。
  | { readonly kind: 'record_failed'; readonly reasons: readonly string[] }
  // 記録の書き込みの結果が分からない（DB の確定が不確か）。自動で書き直さない。
  | { readonly kind: 'record_unknown' }
  // 承認しなかった（知らない確認・形の違い・内容の違い・閉じた後など）。記録も外部変更も作らない。
  | {
      readonly kind: 'refused';
      readonly reason: StorageBoundaryRejection | 'closed';
      readonly errors: readonly string[];
    };

export type PrivateDeclineOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: StorageBoundaryRejection | 'closed';
    };

export interface PrivateConfirmationHeld {
  // 承認を待つ確認（RAM）。
  readonly pending: number;
  // この記録しない区切りで承認した確認の結果の控え（RAM。同じ承認の再送に同じ結果を返す）。
  readonly decided: number;
}

type DecidedOutcome = Exclude<PrivateApprovalOutcome, { kind: 'refused' }>;

// 画面の経路の受付の控えの上限（区切りの間）。
const MAX_RECEIPTS = 256;

const ownerOf = (
  state: PrivateConfirmationOwner['state'],
  shown: {
    readonly view: PrivateConfirmationView;
    readonly segment_generation: string;
    readonly context: PrivateConfirmationContext;
  },
): PrivateConfirmationOwner => ({
  state,
  device_id: shown.context.device_id,
  content_version: shown.view.operation.content_version,
  content_hash: shown.view.content_hash,
  segment_generation: shown.segment_generation,
  operation_id: shown.view.operation.operation_id,
});

export class PrivateConfirmationDesk {
  readonly #options: PrivateConfirmationDeskOptions;
  readonly #newId: () => string;
  readonly #log: (message: string) => void;
  // 確認の ID → 画面に出す確認（RAM だけ）。
  readonly #views = new Map<
    string,
    {
      readonly view: PrivateConfirmationView;
      readonly segment_generation: string;
      readonly context: PrivateConfirmationContext;
    }
  >();
  // 承認した確認の ID → 結果（RAM だけ。区切りを出ると捨てる）。
  readonly #decided = new Map<string, DecidedOutcome>();
  // 承認した・断った確認の ID → 頼んだ端末と内容（RAM だけ。区切りを出ると捨てる）。画面の経路が、再送を同じ端末・同じ内容に
  // 限るために読む。
  readonly #settled = new Map<string, PrivateConfirmationOwner>();
  // 画面の経路の受付の控え（接続範囲と request_id から作った鍵 → 照合値と応答。RAM だけ。区切りを出ると捨てる）。同じ要求の
  // 再送には同じ応答を返し、同じ request_id で内容が違えば断る（approvals の受付と同じ扱い。U604）。
  readonly #receipts = new Map<
    string,
    { readonly hash: string; readonly response: object }
  >();

  constructor(options: PrivateConfirmationDeskOptions) {
    this.#options = options;
    this.#newId = options.newId ?? randomUUID;
    this.#log = options.log ?? (() => undefined);
  }

  // 確定済みの変更から独立した確認を出す。由来（記録しない区切りの ID・世代）は処理を始めた時点の値で、保存境界の保持者が
  // 今の区切りと照合する（出た・入り直した後の頼みは確認にしない）。
  async request(
    operation: Readonly<Record<string, unknown>>,
    origin: StorageOrigin,
    context: PrivateConfirmationContext = {
      device_id: null,
      display: NO_PRIVATE_DISPLAY,
    },
  ): Promise<PrivateConfirmationRequest> {
    const action = operation['action'];
    const kind =
      typeof action === 'object' && action !== null
        ? (action as Record<string, unknown>)['kind']
        : undefined;
    if (typeof kind !== 'string' || !PRIVATE_CONFIRMABLE_KINDS.includes(kind))
      return { ok: false, reason: 'not_confirmable', errors: [] };
    if (!this.#options.contract.valid('OperationIntent', operation))
      return { ok: false, reason: 'confirmation_invalid', errors: [] };
    let contentHash: string;
    try {
      contentHash = intentContentHash(operation);
    } catch {
      return { ok: false, reason: 'confirmation_invalid', errors: [] };
    }
    const confirmationId = this.#newId();
    const shown: { generation: string | null } = { generation: null };
    const result = await this.#options.gate.confirmation(
      {
        type: 'external_change_requested',
        confirmation_id: confirmationId,
        origin,
        draft: { operation, content_hash: contentHash },
      },
      (commands) => {
        for (const command of commands)
          if (command.type === 'show_independent_confirmation') {
            this.#views.set(command.confirmation_id, {
              view: command.view,
              segment_generation: command.segment_generation,
              context: {
                device_id: context.device_id,
                display: structuredClone(context.display),
              },
            });
            shown.generation = command.segment_generation;
          }
        return Promise.resolve();
      },
    );
    if (!result.ok)
      return { ok: false, reason: result.reason, errors: result.errors };
    if (shown.generation === null)
      return { ok: false, reason: 'confirmation_invalid', errors: [] };
    return {
      ok: true,
      confirmation_id: confirmationId,
      segment_generation: shown.generation,
    };
  }

  // 承認を待つ確認（画面に出す値）。写しを返す。
  list(): readonly {
    readonly confirmation_id: string;
    readonly segment_generation: string;
    readonly view: PrivateConfirmationView;
    readonly device_id: string | null;
    readonly display: PrivateConfirmationDisplay;
  }[] {
    return [...this.#views].map(([id, entry]) => ({
      confirmation_id: id,
      segment_generation: entry.segment_generation,
      view: structuredClone(entry.view),
      device_id: entry.context.device_id,
      display: structuredClone(entry.context.display),
    }));
  }

  // 確認の今の扱い（承認を待つ・承認した・断った）と、頼んだ端末・内容。知らない・捨てた確認は null。
  owner(confirmationId: string): PrivateConfirmationOwner | null {
    const shown = this.#views.get(confirmationId);
    if (shown !== undefined) return ownerOf('pending', shown);
    return this.#settled.get(confirmationId) ?? null;
  }

  // 画面の経路の受付の控え（U604）。
  receipt(
    key: string,
  ): { readonly hash: string; readonly response: object } | null {
    return this.#receipts.get(key) ?? null;
  }

  remember(key: string, hash: string, response: object): void {
    this.#receipts.set(key, { hash, response: structuredClone(response) });
    // 区切りの間に溜まりすぎないよう、古い順に捨てる（捨てた控えへの再送は、確認の扱いから同じ結果を作り直す）。
    while (this.#receipts.size > MAX_RECEIPTS) {
      const oldest = this.#receipts.keys().next();
      if (oldest.done === true) break;
      this.#receipts.delete(oldest.value);
    }
  }

  // 画面での一度の承認。保存境界の保持者が確認と照合し、通れば最小の操作記録を書く。承認済みの確認への再送は、記録を
  // 書き直さずに最初の結果を返す。
  async approve(input: PrivateApprovalInput): Promise<PrivateApprovalOutcome> {
    // 承認を始めた時点の確認（頼んだ端末と内容）。待つ間にロック・忘却で RAM の確認が捨てられても、保存境界の保持者が承認した
    // 確認なら、画面の経路の再送の照合に使う（ADR 0197、U604）。
    const shownAtStart = this.#views.get(input.confirmation_id);
    const result = await this.#options.gate.confirmation(
      {
        type: 'confirmation_approved',
        confirmation_id: input.confirmation_id,
        approval: {
          route: 'screen',
          device_id: input.device_id,
          approved_at: new Date(this.#options.now()).toISOString(),
          segment_generation: input.segment_generation,
          operation_id: input.operation_id,
          content_version: input.content_version,
          content_hash: input.content_hash,
        },
      },
      // 記録の書き込みと結果の控えは、保存境界の保持者の排他区間の中で行う（同時に届いた同じ承認は、この区間が終わってから
      // 照合されて already_approved になり、控えた結果を返す。待ち行列の後の続きの順序に頼らない）。
      async (commands): Promise<DecidedOutcome> => {
        let outcome: DecidedOutcome = {
          kind: 'record_failed',
          reasons: ['record_missing'],
        };
        for (const command of commands)
          if (command.type === 'record_minimal_operation')
            outcome = await this.#record(command.record);
        const shown = this.#views.get(input.confirmation_id) ?? shownAtStart;
        if (shown !== undefined)
          this.#settled.set(input.confirmation_id, ownerOf('approved', shown));
        this.#views.delete(input.confirmation_id);
        this.#decided.set(input.confirmation_id, outcome);
        return outcome;
      },
    );
    if (result.ok) return result.value;
    const earlier = this.#decided.get(input.confirmation_id);
    if (result.reason === 'already_approved' && earlier !== undefined)
      return earlier;
    return { kind: 'refused', reason: result.reason, errors: result.errors };
  }

  // 取り下げ。承認を待つ確認だけ。記録も外部変更も作らない。
  async decline(confirmationId: string): Promise<PrivateDeclineOutcome> {
    const result = await this.#options.gate.confirmation(
      { type: 'confirmation_declined', confirmation_id: confirmationId },
      () => Promise.resolve(),
    );
    const shown = this.#views.get(confirmationId);
    if (result.ok && shown !== undefined)
      this.#settled.set(confirmationId, ownerOf('declined', shown));
    this.#views.delete(confirmationId);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  // 記録しない区切りを出た・Core を止めた（保存境界の保持者の状態は出るときに空になる）。RAM の確認と結果の控えを捨てる。
  discard(): void {
    this.#views.clear();
    this.#decided.clear();
    this.#settled.clear();
    this.#receipts.clear();
  }

  // ロックの申告・忘却の知らせで記録しない区切りの中身を捨てる（区切りは記録しないのまま）。承認を待つ確認を保存境界の
  // 保持者で取り下げ（後の承認は confirmation_not_found）、RAM の確認を捨てる。
  async drop(): Promise<void> {
    this.#views.clear();
    await this.#options.gate.dropConfirmations();
    this.#views.clear();
  }

  held(): PrivateConfirmationHeld {
    return {
      pending: this.#options.gate.pendingConfirmations(),
      decided: this.#decided.size,
    };
  }

  // 最小の操作記録を書く。hash は Core が封じた値と照合する（domain は形だけを検査する。ADR 0045）。
  async #record(record: PrivateMinimalRecord): Promise<DecidedOutcome> {
    const operation = record.operation;
    const failed = (reason: string): DecidedOutcome => {
      this.#log(
        `記録しない会話の操作 ${operation.operation_id} の最小の操作記録を書けませんでした（${reason}）。外部変更は行いません。`,
      );
      return { kind: 'record_failed', reasons: [reason] };
    };
    if (
      record.record_kind !== 'private_minimal' ||
      record.workflow_id !== null ||
      record.approval.route !== 'screen'
    )
      return failed('record_invalid');
    if (!this.#options.contract.valid('OperationIntent', operation))
      return failed('intent_invalid');
    // 作る操作の内容版は 1（operation.create は版 1 で作る）。
    if (operation.content_version !== '1')
      return failed('content_version_invalid');
    let key;
    try {
      const loaded = await this.#options.keyStore.loadDataKey();
      key = loaded.ok ? loaded.dataKey : null;
    } catch {
      key = null;
    }
    if (key === null) return failed('key_unavailable');
    const sealed = sealOperationIntent(
      key,
      { operationId: operation.operation_id, contentVersion: 1 },
      operation,
      this.#newId(),
    );
    if (!sealed.ok) return failed('seal_failed');
    if (sealed.content_hash !== record.content_hash)
      return failed('content_hash_mismatch');
    let forgetting: string;
    try {
      forgetting = await this.#options.forgettingGeneration();
    } catch {
      return failed('forgetting_generation_unavailable');
    }
    const command: CreateOperationCommand = {
      command_id: this.#newId(),
      kind: 'operation.create',
      operation_id: operation.operation_id,
      expected_state_revision: '0',
      request_revision: null,
      permission_revision: operation.permission_revision,
      forgetting_generation: forgetting,
      connection_id: null,
      request: null,
      workflow_id: null,
      operation_kind: operation.action.kind,
      effect_route: 'remote_mutation',
      content_hash: sealed.content_hash,
      intent: sealed.intent,
      auto_approval: null,
      // preview_id は記録のために新しく作る。確認の ID（記録しない会話の応答で端末へ返した値）は DB に書かない（U506）。
      private_minimal: {
        approval_id: this.#newId(),
        device_id: record.approval.device_id,
        preview_id: this.#newId(),
      },
    };
    let outcome;
    try {
      outcome = await this.#options.store.submit(command).result;
    } catch {
      return { kind: 'record_unknown' };
    }
    if (outcome.outcome === 'durable') {
      this.#log(
        `記録しない会話の操作 ${operation.operation_id} の最小の操作記録を書きました。`,
      );
      this.#options.afterRecord?.(operation.operation_id);
      return { kind: 'recorded', operation_id: operation.operation_id };
    }
    if (outcome.outcome === 'unknown') {
      this.#log(
        `記録しない会話の操作 ${operation.operation_id} の最小の操作記録の結果が分かりません。自動では書き直しません。`,
      );
      return { kind: 'record_unknown' };
    }
    return outcome.outcome === 'rejected'
      ? failed(outcome.reasons.join(','))
      : failed('not_durable');
  }
}
