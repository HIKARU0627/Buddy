// 記憶の忘却の Core の経路（B06-07b-2、設計 03 忘却と再取り込み、08 §6、ADR 0044・0054・0061・0180）。
//
// 計画と実行を分ける（2026-11-01 Q2: 忘却は画面で確認してから実行する）。
// - plan: forget.graph（閉包に触れる部分だけの系譜。ADR 0061）を読み、台帳の鍵で HMAC を求めて domain の planForget で
//   計画を作り、本人が確かめる形（forgetPlanView）にして返す。この時点では何も消さない。計画は RAM にだけ置き、要求した
//   端末に結び付け、10 分で無効にする（U383）。
// - execute: 本人が確かめた計画を、作り直さずに forget.apply へ渡す。DB worker が同じ transaction の中で今の系譜から計画を
//   作り直して照合し、台帳の世代が変わった・派生物が増えたときは何も消さずに拒否する。その場合は計画を捨て、端末に
//   取り直しを求める（自動では作り直して実行しない。本人が見た計画と違う物を消さない）。結果が分からないときも計画を捨て、
//   自動では送り直さない。
// - 忘却の公開ゲート（U112）: 本人が使える入口に出すのは、消える指示を見せる画面（UI-10、#180）ができてから。ゲートは
//   既定で閉じ、開けるのは UI-10 の PR だけ（2026-10-31 Q1）。設定ファイル・環境変数・API からは開けない（U382）。
//   ゲートが閉じている間は計画も実行もしない（期限切れの削除・復元の忘却の適用は忘却の入口ではないので関わらない）。
// - 台帳の鍵（ledger_hmac_key）がなければ計画を作らない（U384）。鍵をここで作ると、復旧キーで包まれず、復元した中枢が
//   同じ HMAC を求められなくなる（ADR 0040・0055）。
// 結果・知らせ・ログに本文・検索語・HMAC を入れない（ID・件数・世代だけ）。

import { randomUUID } from 'node:crypto';
import type {
  ForgetExecuteResult,
  ForgetLedgerNotice,
  ForgetPlanView,
  RetentionNotice,
  RetentionNoticeItem,
} from '@buddy/contracts';
import { chunkNoticeItems, forgetPlanView, planForget } from '@buddy/domain';
import type { ForgetPlan, MemorySource, NoticeItemDraft } from '@buddy/domain';
import type { ForgetApplyValue, SourceHmacValue } from '@buddy/storage';
import { applyForgetAndSyncLedger } from './forget-ledger.js';
import type { ForgetLedgerStore } from './forget-ledger.js';
import { isNoticeItemId } from './notice-sink.js';
import type { NoticeSink } from './notice-sink.js';

// 忘却の公開ゲート（U112・U382）。忘却の画面（UI-10、#180）の PR だけがこの値を変える。型は boolean にして、
// 閉じた値に依存した分岐の省略（定数の畳み込み）を型の上で起こさない。
export const FORGET_PUBLIC_GATE_OPEN: boolean = false;

// 計画の有効期間（U383）。
export const FORGET_PLAN_TTL_MS = 10 * 60_000;

// DB worker の拒否のうち、計画が古くなったことを表すもの（計画を取り直せば進める）。
const REPLAN_REASONS: ReadonlySet<string> = new Set([
  'forgetting_generation_changed',
  'forget_plan_stale',
  'target_not_found',
]);

export type ForgetPlanFailure =
  // 忘却の公開ゲートが閉じている。
  | 'forget_gate_closed'
  // 台帳の HMAC の鍵がない・読めない（バックアップの設定の前など）。
  | 'ledger_key_unavailable'
  // 対象の記憶がない（消えた・期限で削除された）。
  | 'target_not_found'
  // 系譜が読めない・計画が作れない（知らない種類の辺・HMAC の形など）。
  | 'plan_unavailable'
  // 計画の一覧が上限を超える（途中までを見せない）。
  | 'plan_too_large';

export type ForgetExecuteFailure =
  | 'forget_gate_closed'
  // 計画がない・別の端末の計画・期限切れで捨てた。
  | 'plan_not_found'
  | 'plan_expired'
  // 要求の世代が計画の世代と違う（画面が別の計画を見ている）。
  | 'generation_mismatch'
  // 台帳の世代が変わった・系譜が増えた・対象が消えた。何も消していない。計画を取り直す。
  | 'replan_required'
  // 計画の照合以外の理由で拒否された（何も消していない）。
  | 'apply_rejected'
  // COMMIT の成否が分からない。自動では送り直さない。
  | 'outcome_unknown';

export type ForgetPlanOutcome =
  | { readonly ok: true; readonly view: ForgetPlanView }
  | {
      readonly ok: false;
      readonly reason: ForgetPlanFailure;
      readonly reasons: readonly string[];
    };

export type ForgetExecuteOutcome =
  | {
      readonly ok: true;
      readonly result: ForgetExecuteResult;
      // 台帳の別ファイルの同期の結果（written・unchanged、または失敗の理由）。応答には出さない。
      readonly ledger_file: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: ForgetExecuteFailure;
      readonly reasons: readonly string[];
    };

export interface ForgetServiceOptions {
  readonly store: ForgetLedgerStore;
  // 台帳の別ファイルのパス（データディレクトリの FORGET_LEDGER_FILE）。
  readonly ledgerPath: string;
  // 忘却の公開ゲート。製品は FORGET_PUBLIC_GATE_OPEN を読む関数を渡す。
  readonly gate: () => boolean;
  // 台帳用の HMAC（ADR 0040 の用途別の鍵）。鍵がない・読めなければ null。
  readonly sourceHmac: () => Promise<((source: MemorySource) => string) | null>;
  readonly notices?: NoticeSink;
  // UTC の Unix ミリ秒。
  readonly now: () => number;
  readonly newId?: () => string;
  readonly log?: (message: string) => void;
}

interface StoredPlan {
  readonly plan_id: string;
  readonly device_id: string;
  readonly target: MemorySource;
  readonly plan: ForgetPlan;
  readonly source_hmacs: readonly SourceHmacValue[];
  readonly previous_generation: string;
  readonly expires_at: number;
  result: ForgetExecuteResult | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export class ForgetService {
  readonly #options: ForgetServiceOptions;
  readonly #plans = new Map<string, StoredPlan>();
  // 実行は 1 つずつ（同じ計画の二重の実行・世代の取り違えを避ける）。
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: ForgetServiceOptions) {
    this.#options = options;
  }

  #newId(): string {
    return (this.#options.newId ?? randomUUID)();
  }

  #log(message: string): void {
    this.#options.log?.(message);
  }

  #prune(now: number): void {
    for (const [id, stored] of this.#plans)
      if (now >= stored.expires_at) this.#plans.delete(id);
  }

  // 有効な計画の数（試験・診断用）。
  pendingPlans(): number {
    this.#prune(this.#options.now());
    return [...this.#plans.values()].filter((stored) => stored.result === null)
      .length;
  }

  async plan(input: {
    readonly device_id: string;
    readonly memory_id: string;
  }): Promise<ForgetPlanOutcome> {
    const fail = (
      reason: ForgetPlanFailure,
      reasons: readonly string[] = [],
    ): ForgetPlanOutcome => ({ ok: false, reason, reasons });
    if (!this.#options.gate()) return fail('forget_gate_closed');
    const keyed = await this.#options.sourceHmac();
    if (keyed === null) return fail('ledger_key_unavailable');
    const target: MemorySource = {
      source_kind: 'memory',
      source_id: input.memory_id,
    };
    const read = await this.#options.store.memory({
      kind: 'forget.graph',
      target,
      instruction_turn_id: null,
    });
    if (!read.ok) return fail('plan_unavailable', read.reasons);
    if (!read.value.target_exists) return fail('target_not_found');
    // 計画が求めた HMAC だけを控え、実行のときに DB worker へ渡す（worker は鍵を持たない。ADR 0054）。
    const recorded = new Map<string, SourceHmacValue>();
    const planned = planForget({
      target,
      instruction_turn_id: null,
      executing_operation_id: null,
      graph: read.value.graph,
      sourceHmac: (source) => {
        const hmac = keyed(source);
        recorded.set(`${source.source_kind}\u0000${source.source_id}`, {
          source_kind: source.source_kind,
          source_id: source.source_id,
          hmac,
        });
        return hmac;
      },
    });
    if (!planned.ok) return fail('plan_unavailable', planned.reasons);
    const view = forgetPlanView(
      planned.plan,
      new Set(read.value.graph.operations.map((row) => row.operation_id)),
    );
    if (!view.ok) return fail('plan_too_large', view.reasons);
    const now = this.#options.now();
    this.#prune(now);
    const stored: StoredPlan = {
      plan_id: this.#newId(),
      device_id: input.device_id,
      target,
      plan: planned.plan,
      source_hmacs: [...recorded.values()],
      previous_generation: read.value.forgetting_generation,
      expires_at: now + FORGET_PLAN_TTL_MS,
      result: null,
    };
    this.#plans.set(stored.plan_id, stored);
    const parts = view.view;
    return {
      ok: true,
      view: {
        schema: 'buddy.forget-plan-view.v1',
        plan_id: stored.plan_id,
        target: { source_kind: 'memory', source_id: input.memory_id },
        forgetting_generation: stored.previous_generation,
        expires_at: iso(stored.expires_at),
        removed: {
          // 種類は 13 個で重ならない（domain の FORGET_REMOVED_KINDS）ので、契約の 1〜13 件に収まる。
          counts: parts.removed_counts.map((item) => ({
            ...item,
          })) as unknown as ForgetPlanView['removed']['counts'],
          memory_ids: [...parts.removed_memory_ids] as [string, ...string[]],
          directive_ids: [...parts.removed_directive_ids],
        },
        kept: {
          operations: parts.kept_operations.map((item) => ({
            operation_id: item.operation_id,
            state:
              item.state as ForgetPlanView['kept']['operations'][number]['state'],
          })),
          lineage_only: parts.kept_lineage_only,
        },
        blocked_source_count: parts.blocked_source_count,
      },
    };
  }

  execute(input: {
    readonly device_id: string;
    readonly plan_id: string;
    readonly forgetting_generation: string;
  }): Promise<ForgetExecuteOutcome> {
    const run = this.#chain.then(() => this.#execute(input));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #execute(input: {
    readonly device_id: string;
    readonly plan_id: string;
    readonly forgetting_generation: string;
  }): Promise<ForgetExecuteOutcome> {
    const fail = (
      reason: ForgetExecuteFailure,
      reasons: readonly string[] = [],
    ): ForgetExecuteOutcome => ({ ok: false, reason, reasons });
    if (!this.#options.gate()) return fail('forget_gate_closed');
    const stored = this.#plans.get(input.plan_id);
    if (stored === undefined || stored.device_id !== input.device_id)
      return fail('plan_not_found');
    const now = this.#options.now();
    if (now >= stored.expires_at) {
      this.#plans.delete(stored.plan_id);
      return fail('plan_expired');
    }
    if (input.forgetting_generation !== stored.previous_generation)
      return fail('generation_mismatch');
    // 同じ計画の実行の再送には、同じ結果を返す（二度は消さない）。
    if (stored.result !== null)
      return { ok: true, result: stored.result, ledger_file: null };
    const applied = await applyForgetAndSyncLedger(
      this.#options.store,
      {
        kind: 'forget.apply',
        target: stored.target,
        instruction_turn_id: null,
        plan: stored.plan,
        source_hmacs: stored.source_hmacs,
        entry_id: this.#newId(),
        previous_generation: stored.previous_generation,
        new_ledger_id: this.#newId(),
        now,
      },
      this.#options.ledgerPath,
      new Date(now),
    );
    if (!applied.result.ok) {
      // 拒否・成否不明のどちらでも、この計画はもう使わない（成否不明の計画を再び送らない）。
      this.#plans.delete(stored.plan_id);
      if (applied.result.outcome === 'unknown')
        return fail('outcome_unknown', applied.result.reasons);
      return applied.result.reasons.some((reason) => REPLAN_REASONS.has(reason))
        ? fail('replan_required', applied.result.reasons)
        : fail('apply_rejected', applied.result.reasons);
    }
    const value = applied.result.value;
    const result: ForgetExecuteResult = {
      schema: 'buddy.forget-execute-result.v1',
      plan_id: stored.plan_id,
      forgetting_generation: value.forgetting_generation,
    };
    stored.result = result;
    if (
      applied.file !== null &&
      applied.file !== 'written' &&
      applied.file !== 'unchanged'
    )
      this.#log(
        `忘却は確定しましたが、台帳のファイルを書けませんでした（${applied.file}）。次の起動で DB に合わせて書き直します。`,
      );
    this.#publish(value, now);
    return { ok: true, result, ledger_file: applied.file };
  }

  // 知らせ（運び方は UI-05。U40）。配信の失敗は忘却の失敗にしない。
  #publish(value: ForgetApplyValue, now: number): void {
    const sink = this.#options.notices;
    if (sink === undefined) return;
    const send = (notice: RetentionNotice | ForgetLedgerNotice): void => {
      try {
        const sent = sink.publish(notice);
        if (sent instanceof Promise)
          sent.catch(() =>
            this.#log(
              '忘却の知らせを渡せませんでした（忘却には影響しません）。',
            ),
          );
      } catch {
        this.#log('忘却の知らせを渡せませんでした（忘却には影響しません）。');
      }
    };
    const groups: readonly [
      'forgotten' | 'derived_from_forgotten',
      readonly NoticeItemDraft[],
    ][] = [
      ['forgotten', value.notice.forgotten],
      ['derived_from_forgotten', value.notice.derived_from_forgotten],
    ];
    for (const [reason, drafts] of groups)
      for (const chunk of chunkNoticeItems(
        drafts.filter((item) => isNoticeItemId(item.item_id)),
      )) {
        const [first, ...rest] = chunk.map((item): RetentionNoticeItem => ({
          item_kind: item.item_kind,
          item_id: item.item_id,
        }));
        if (first === undefined) continue;
        send({
          schema: 'buddy.retention-notice.v1',
          notice_id: this.#newId(),
          occurred_at: iso(now),
          kind: 'forgotten',
          reason,
          forgetting_generation: value.forgetting_generation,
          items: [first, ...rest],
        });
      }
    send({
      schema: 'buddy.forget-ledger-notice.v1',
      notice_id: this.#newId(),
      occurred_at: iso(now),
      kind: 'ledger_advanced',
      ledger_id: value.ledger_id,
      forgetting_generation: value.forgetting_generation,
      entry_hash: value.entry_hash,
    });
  }
}

export function createForgetService(
  options: ForgetServiceOptions,
): ForgetService {
  return new ForgetService(options);
}
