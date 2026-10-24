// 予算の確認の一覧（B07-05、ADR 0039。設計 05 F02、01 設定・運用・承認画面）。状態の層のパネルの「確認が必要な操作」と同じ
// 場所に出す。超過枠の承認・M 超過の確認・不明な費用の手での精算を、行ごとに出す。
// 説明の文章は置かず、並べ方で伝える: 種類の札・枠・予算月・期限を 1 行目に、金額を大きく並べ、金額の関係は帯で見せる
// （超過枠の承認は「最大負担」が「超過枠の残り」のどれだけを占めるか、M 超過は「最大負担」を超えた分を別の色と ⚠ で）。
// 承認・確認・精算は、ボタンを押すと main が OS の確認ダイアログを 1 回だけ出す（本人の判断 2026-10-23）。画面が持つのは
// main が作った参照（ref）と表示用の値だけ。理由のコード・API の名前は出さない。
// CSP（style-src 'self'）のため style 属性は使わない。帯の幅は 5% きざみのクラスの表から選ぶ。
import { Button, FieldError, Input, Label, TextField } from '@heroui/react';
import type { DesktopBudgetEntry } from '@buddy/contracts';
import { InlineNotice } from '../../components/InlineNotice.js';
import { Section } from '../../components/Section.js';
import { StatusText } from '../../components/StatusText.js';
import {
  BUDGET_LABELS,
  KIND_LABELS,
  budgetBar,
  entryExpired,
  expiryText,
  inputOf,
  manualProblems,
  moneyText,
  occurredText,
  ordinalText,
  originText,
  overAmount,
  poolText,
} from '../../state/budget-state.js';
import type {
  BudgetActions,
  BudgetBar,
  BudgetViewState,
} from '../../state/budget-state.js';

// 帯の幅（5% きざみ。literal の class だけが CSS に入る）。
const WIDTH: Readonly<Record<number, string>> = {
  0: 'w-0',
  5: 'w-[5%]',
  10: 'w-[10%]',
  15: 'w-[15%]',
  20: 'w-[20%]',
  25: 'w-[25%]',
  30: 'w-[30%]',
  35: 'w-[35%]',
  40: 'w-[40%]',
  45: 'w-[45%]',
  50: 'w-[50%]',
  55: 'w-[55%]',
  60: 'w-[60%]',
  65: 'w-[65%]',
  70: 'w-[70%]',
  75: 'w-[75%]',
  80: 'w-[80%]',
  85: 'w-[85%]',
  90: 'w-[90%]',
  95: 'w-[95%]',
  100: 'w-full',
};

export function barStep(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent / 5) * 5));
}

// ボタンの読み上げの名前（見える文字に枠と金額を足す。「承認する（llm・XTS 40.00）」）。
export function itemLabel(verb: string, entry: DesktopBudgetEntry): string {
  const when = occurredText(entry);
  const order = ordinalText(entry);
  return `${verb}（${poolText(entry)}・${moneyText(entry.max_liability)}${when === null ? '' : `・${when}`}${order === null ? '' : `・${order}`}）`;
}

function Value({
  label,
  value,
  danger = false,
  end = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly danger?: boolean;
  readonly end?: boolean;
}) {
  return (
    <div className={`flex flex-col ${end ? 'items-end' : ''}`}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd
        className={`text-base font-semibold tabular-nums ${danger ? 'text-danger-soft-foreground' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}

function Bar({
  bar,
  label,
}: {
  readonly bar: BudgetBar;
  readonly label: string;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      data-bar-base={barStep(bar.base)}
      data-bar-overflow={barStep(bar.overflow)}
      className="flex h-2 w-full overflow-hidden rounded-full bg-default"
    >
      <span className={`${WIDTH[barStep(bar.base)]} bg-accent`} />
      {bar.overflow > 0 ? (
        <span className={`${WIDTH[barStep(bar.overflow)]} bg-danger`} />
      ) : null}
    </div>
  );
}

function ManualFields({
  entry,
  state,
  actions,
  busy,
}: {
  readonly entry: DesktopBudgetEntry;
  readonly state: BudgetViewState;
  readonly actions: BudgetActions;
  readonly busy: boolean;
}) {
  const input = inputOf(state, entry.ref);
  const problems = manualProblems(input);
  const checked = state.checked.includes(entry.ref);
  return (
    <div className="flex flex-wrap items-start gap-3">
      <TextField
        className="min-w-44 flex-1"
        value={input.reconciliationId}
        onChange={(value) => actions.setReconciliationId(entry.ref, value)}
        isInvalid={checked && problems.reconciliationId !== null}
        isDisabled={busy}
      >
        <Label>{BUDGET_LABELS.reconciliation}</Label>
        <Input variant="secondary" className="font-mono" />
        <FieldError>{problems.reconciliationId}</FieldError>
      </TextField>
      <TextField
        className="w-36"
        value={input.amount}
        onChange={(value) => actions.setAmount(entry.ref, value)}
        isInvalid={checked && problems.amount !== null}
        isDisabled={busy}
      >
        <Label>{`${BUDGET_LABELS.actualInput}（${entry.max_liability.currency}）`}</Label>
        <Input
          variant="secondary"
          className="tabular-nums"
          inputMode="decimal"
        />
        <FieldError>{problems.amount}</FieldError>
      </TextField>
    </div>
  );
}

function ItemRow({
  entry,
  state,
  actions,
  stopped,
  now,
}: {
  readonly entry: DesktopBudgetEntry;
  readonly state: BudgetViewState;
  readonly actions: BudgetActions;
  // この端末の入出力が止まっている（承認と M 超過の確認は支出を許すので出さない。見送りと精算は出す）。
  readonly stopped: boolean;
  readonly now: number;
}) {
  const busy = state.busy.includes(entry.ref);
  const notice = state.notices[entry.ref];
  const expiry = expiryText(entry, now);
  const expired = entryExpired(entry, now);
  const bar = budgetBar(entry);
  const over = overAmount(entry);
  const money = moneyText(entry.max_liability);
  const showApprove = entry.kind === 'overage_approval' && !stopped && !expired;
  const showReject = entry.kind === 'overage_approval' && !expired;
  const showReview = entry.kind === 'overrun_review' && !stopped;
  const showSettle = entry.kind === 'manual_settlement';
  const waiting = entry.delivery_unknown;
  return (
    <li data-kind={entry.kind} className="flex flex-col gap-2.5 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="rounded-md border border-separator px-1.5 py-0.5 text-xs font-semibold">
          {KIND_LABELS[entry.kind]}
        </span>
        <span className="text-xs font-semibold">{poolText(entry)}</span>
        <span className="text-xs tabular-nums text-muted">
          {entry.budget_month}
        </span>
        {expiry === null ? null : (
          <span
            className={`ml-auto text-xs tabular-nums ${expired ? 'text-danger-soft-foreground' : 'text-muted'}`}
          >
            {expiry}
          </span>
        )}
      </div>
      {occurredText(entry) === null &&
      originText(entry) === null &&
      entry.profile_id === null &&
      ordinalText(entry) === null ? null : (
        <p className="-mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
          {occurredText(entry) === null ? null : (
            <span className="tabular-nums">{occurredText(entry)}</span>
          )}
          {originText(entry) === null ? null : <span>{originText(entry)}</span>}
          {entry.profile_id === null ? null : (
            <span className="font-mono">{entry.profile_id}</span>
          )}
          {ordinalText(entry) === null ? null : (
            <span className="font-semibold text-foreground">
              {ordinalText(entry)}
            </span>
          )}
        </p>
      )}
      {entry.kind === 'overage_approval' && entry.overage_remaining !== null ? (
        <>
          <dl className="flex items-end justify-between gap-4">
            <Value label={BUDGET_LABELS.maxLiability} value={money} />
            <Value
              end
              label={BUDGET_LABELS.overageRemaining}
              value={moneyText(entry.overage_remaining)}
            />
          </dl>
          {bar === null ? null : (
            <Bar
              bar={bar}
              label={`${BUDGET_LABELS.maxLiability} ${money} / ${BUDGET_LABELS.overageRemaining} ${moneyText(entry.overage_remaining)}`}
            />
          )}
        </>
      ) : null}
      {entry.kind === 'overrun_review' && entry.actual_gross !== null ? (
        <>
          <dl className="flex items-end justify-between gap-4">
            <Value label={BUDGET_LABELS.maxLiability} value={money} />
            <Value
              label={BUDGET_LABELS.actual}
              value={moneyText(entry.actual_gross)}
            />
            {over === null ? null : (
              <Value
                end
                danger
                label={BUDGET_LABELS.over}
                value={`+${moneyText(over)}`}
              />
            )}
          </dl>
          {bar === null ? null : (
            <Bar
              bar={bar}
              label={`${BUDGET_LABELS.maxLiability} ${money} / ${BUDGET_LABELS.actual} ${moneyText(entry.actual_gross)}`}
            />
          )}
        </>
      ) : null}
      {entry.kind === 'manual_settlement' ? (
        <>
          <dl className="flex items-end justify-between gap-4">
            <Value label={BUDGET_LABELS.maxLiability} value={money} />
          </dl>
          {waiting ? null : (
            <ManualFields
              entry={entry}
              state={state}
              actions={actions}
              busy={busy}
            />
          )}
        </>
      ) : null}
      {waiting ? (
        <StatusText
          className="text-sm"
          line={{
            tone: 'danger',
            mark: 'warning',
            text: BUDGET_LABELS.unknown,
          }}
        />
      ) : null}
      {!waiting && (showApprove || showReject || showReview || showSettle) ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {showReject ? (
            <Button
              variant="secondary"
              size="sm"
              isDisabled={busy}
              aria-label={itemLabel(BUDGET_LABELS.reject, entry)}
              onPress={() => actions.decide(entry.ref, 'reject')}
            >
              {BUDGET_LABELS.reject}
            </Button>
          ) : null}
          {showApprove ? (
            <Button
              variant="primary"
              size="sm"
              isDisabled={busy}
              aria-label={itemLabel(BUDGET_LABELS.approve, entry)}
              onPress={() => actions.decide(entry.ref, 'approve')}
            >
              {busy ? BUDGET_LABELS.busy : BUDGET_LABELS.approve}
            </Button>
          ) : null}
          {showReview ? (
            <Button
              variant="secondary"
              size="sm"
              isDisabled={busy}
              aria-label={itemLabel(BUDGET_LABELS.review, entry)}
              onPress={() => actions.review(entry.ref)}
            >
              {busy ? BUDGET_LABELS.busy : BUDGET_LABELS.review}
            </Button>
          ) : null}
          {showSettle ? (
            <Button
              variant="secondary"
              size="sm"
              isDisabled={busy}
              aria-label={itemLabel(BUDGET_LABELS.settle, entry)}
              onPress={() => actions.settle(entry.ref)}
            >
              {busy ? BUDGET_LABELS.busy : BUDGET_LABELS.settle}
            </Button>
          ) : null}
        </div>
      ) : null}
      {notice === undefined ? null : (
        <InlineNotice tone={notice.tone} text={notice.text} />
      )}
    </li>
  );
}

// 本人の確認が要る予算の項目の一覧。項目がなければ何も描かない（空の見出しを出さない）。
export function BudgetItems({
  items,
  state,
  actions,
  stopped,
  now,
}: {
  readonly items: readonly DesktopBudgetEntry[];
  readonly state: BudgetViewState;
  readonly actions: BudgetActions;
  readonly stopped: boolean;
  readonly now: number;
}) {
  if (items.length === 0) return null;
  return (
    <Section id="budget-heading" title={BUDGET_LABELS.section}>
      <ul
        aria-label={BUDGET_LABELS.section}
        className="flex flex-col divide-y divide-separator"
      >
        {items.map((entry) => (
          <ItemRow
            key={entry.ref}
            entry={entry}
            state={state}
            actions={actions}
            stopped={stopped}
            now={now}
          />
        ))}
      </ul>
    </Section>
  );
}
