// 家計簿の欄（ADR 0162。API は ADR 0161）。標準の端末画面（従来の窓）の本体に置く。
// 頭に取得状態と最終取得（経過）。次に選んでいる月の合計（支出・収入・収支・振替・件数）と分類ごとの支出。次に記録の行:
// 日付・時刻・店名・金額・向き・支払い手段・出所と、分類の選択（向きが同じ分類だけ）と「削除する」（画面の中で
// もう一度確かめてから送る）。最後に月ごとの合計（今月から 11 か月前まで）で、押すとその月の記録を出す。
// 未取得・取得の失敗を「記録はありません」と言わない。理由のコード・API の名前・記録の ID は出さない。
import { Button } from '@heroui/react';
import type {
  DesktopHouseholdEntry,
  HouseholdRecurringSummary,
  HouseholdCategoryId,
  HouseholdMonthSummary,
  HouseholdMonthTotals,
} from '@buddy/contracts';
import { InlineNotice } from '../../components/InlineNotice.js';
import { Section } from '../../components/Section.js';
import { StatusText } from '../../components/StatusText.js';
import {
  DIRECTION_LABELS,
  FETCH_LABELS,
  HOUSEHOLD_LABELS,
  IMPORT_PLACE,
  INTAKE_PLACE,
  SOURCE_LABELS,
  canChange,
  categoryChoices,
  categoryLabel,
  dayText,
  elapsedText,
  importResultText,
  monthText,
  monthsSeenText,
  yenText,
} from '../../state/household-state.js';
import type {
  HouseholdActions,
  HouseholdViewState,
} from '../../state/household-state.js';
import type { StatusLine } from '../../tones.js';

const FETCH_LINES: Readonly<Record<string, StatusLine>> = {
  loaded: { tone: 'success', mark: 'dot', text: FETCH_LABELS.loaded },
  stale: { tone: 'warning', mark: 'warning', text: FETCH_LABELS.stale },
  unavailable: {
    tone: 'neutral',
    mark: 'circle',
    text: FETCH_LABELS.unavailable,
  },
};

function noticeAt(state: HouseholdViewState, place: string | null) {
  return state.notice !== null && state.notice.place === place
    ? state.notice
    : null;
}

function SummaryBlock({
  month,
  summary,
}: {
  readonly month: string;
  readonly summary: HouseholdMonthSummary;
}) {
  const figures: readonly [string, number][] = [
    [HOUSEHOLD_LABELS.expense, summary.expense_yen],
    [HOUSEHOLD_LABELS.income, summary.income_yen],
    [HOUSEHOLD_LABELS.balance, summary.balance_yen],
    [HOUSEHOLD_LABELS.transfer, summary.transfer_yen],
  ];
  return (
    <div className="flex flex-col gap-3" data-month={month}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        {figures.map(([label, amount]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="font-semibold tabular-nums">{yenText(amount)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted tabular-nums">{`${String(summary.entry_count)}\u00a0${HOUSEHOLD_LABELS.count}`}</p>
      {summary.expense_by_category.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">
            {HOUSEHOLD_LABELS.byCategory}
          </h3>
          <ul
            aria-label={HOUSEHOLD_LABELS.byCategory}
            className="flex flex-col gap-0.5 text-sm"
          >
            {summary.expense_by_category.map((item) => (
              <li
                key={item.category}
                data-category={item.category}
                className="flex justify-between gap-2"
              >
                <span>{categoryLabel(item.category)}</span>
                <span className="tabular-nums">{yenText(item.total_yen)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function EntryRow({
  entry,
  state,
  actions,
}: {
  readonly entry: DesktopHouseholdEntry;
  readonly state: HouseholdViewState;
  readonly actions: HouseholdActions;
}) {
  const notice = noticeAt(state, entry.ref);
  const mine = state.busy === entry.ref;
  const enabled = canChange(state, entry);
  const confirming = state.confirming === entry.ref;
  const name =
    entry.merchant ?? entry.memo ?? DIRECTION_LABELS[entry.direction];
  const selectId = `household-category-${entry.ref}`;
  const choices = categoryChoices(entry.direction);
  return (
    <li
      data-direction={entry.direction}
      data-category={entry.category}
      className="flex flex-col gap-1.5 py-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-xs tabular-nums text-muted">
          {dayText(entry)}
        </span>
        <span className="min-w-0 break-words text-sm font-semibold">
          {name}
        </span>
        <span className="ml-auto text-sm font-semibold tabular-nums">
          {entry.direction === 'expense'
            ? yenText(entry.amount_yen)
            : `${DIRECTION_LABELS[entry.direction]} ${yenText(entry.amount_yen)}`}
        </span>
      </div>
      <p className="text-xs text-muted">
        {[
          entry.payment,
          SOURCE_LABELS[entry.source_kind],
          entry.merchant !== null ? entry.memo : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' ・ ')}
      </p>
      {entry.delivery_unknown ? (
        <StatusText
          className="text-sm"
          line={{
            tone: 'danger',
            mark: 'warning',
            text: HOUSEHOLD_LABELS.unknown,
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label
            htmlFor={selectId}
            className="flex items-center gap-2 text-xs text-muted"
          >
            {HOUSEHOLD_LABELS.category}
            <select
              id={selectId}
              value={entry.category}
              disabled={!enabled || choices.length < 2}
              onChange={(event) =>
                actions.changeCategory(
                  entry.ref,
                  event.currentTarget.value as HouseholdCategoryId,
                )
              }
              className="rounded-md border border-separator bg-transparent px-2 py-1 text-sm text-foreground"
            >
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          {mine && !confirming ? (
            <span className="text-xs text-muted">
              {HOUSEHOLD_LABELS.changing}
            </span>
          ) : null}
          {confirming ? null : (
            <Button
              size="sm"
              variant="ghost"
              isDisabled={!enabled}
              aria-label={`${HOUSEHOLD_LABELS.delete}（${dayText(entry)} ${name}）`}
              onPress={() => actions.startDelete(entry.ref)}
            >
              {HOUSEHOLD_LABELS.delete}
            </Button>
          )}
        </div>
      )}
      {confirming ? (
        <div
          role="group"
          aria-label={HOUSEHOLD_LABELS.delete}
          className="flex flex-col gap-2 rounded-md border border-danger-soft-foreground p-3"
        >
          <p className="text-sm">{HOUSEHOLD_LABELS.deleteConfirm}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              isDisabled={mine}
              onPress={actions.cancelDelete}
            >
              {HOUSEHOLD_LABELS.cancel}
            </Button>
            <Button
              size="sm"
              variant="danger"
              isDisabled={mine}
              onPress={actions.confirmDelete}
            >
              {mine ? HOUSEHOLD_LABELS.deleting : HOUSEHOLD_LABELS.deleteSubmit}
            </Button>
          </div>
        </div>
      ) : null}
      {notice === null ? null : (
        <InlineNotice tone={notice.tone} text={notice.text} />
      )}
    </li>
  );
}

function MonthList({
  months,
  current,
  selected,
  state,
  actions,
}: {
  readonly months: readonly HouseholdMonthTotals[];
  readonly current: string | null;
  readonly selected: string | null;
  readonly state: HouseholdViewState;
  readonly actions: HouseholdActions;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold">{HOUSEHOLD_LABELS.months}</h3>
      <ul
        aria-label={HOUSEHOLD_LABELS.months}
        className="flex flex-col divide-y divide-separator text-sm"
      >
        {months.map((item) => {
          const label =
            item.month === current
              ? `${monthText(item.month)}（${HOUSEHOLD_LABELS.thisMonth}）`
              : monthText(item.month);
          return (
            <li
              key={item.month}
              data-month={item.month}
              className="flex flex-wrap items-center justify-between gap-2 py-1.5"
            >
              <Button
                size="sm"
                variant={item.month === selected ? 'secondary' : 'ghost'}
                isDisabled={state.reading || item.month === selected}
                {...(item.month === selected
                  ? { 'aria-current': 'true' as const }
                  : {})}
                onPress={() => actions.selectMonth(item.month)}
              >
                {label}
              </Button>
              <span className="text-xs tabular-nums text-muted">
                {`${HOUSEHOLD_LABELS.expense} ${yenText(item.expense_yen)} ・ ${HOUSEHOLD_LABELS.income} ${yenText(item.income_yen)}`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// 利用通知の取り込みの入・切（ADR 0163）。読めていなければ出さない（入・切を推測で見せない）。
function IntakeBlock({
  state,
  actions,
}: {
  readonly state: HouseholdViewState;
  readonly actions: HouseholdActions;
}) {
  const intake = state.view?.mail_intake ?? null;
  if (intake === null) return null;
  const notice = noticeAt(state, INTAKE_PLACE);
  const mine = state.busy === INTAKE_PLACE;
  return (
    <div className="flex flex-col gap-1.5" data-intake={intake}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusText
          className="text-sm"
          line={
            intake === 'on'
              ? {
                  tone: 'success',
                  mark: 'dot',
                  text: HOUSEHOLD_LABELS.intakeOn,
                }
              : {
                  tone: 'neutral',
                  mark: 'circle',
                  text: HOUSEHOLD_LABELS.intakeOff,
                }
          }
        />
        <Button
          size="sm"
          variant="secondary"
          isDisabled={state.busy !== null}
          onPress={() => actions.setIntake(intake === 'on' ? 'off' : 'on')}
        >
          {mine
            ? HOUSEHOLD_LABELS.intakeChanging
            : intake === 'on'
              ? HOUSEHOLD_LABELS.intakeStop
              : HOUSEHOLD_LABELS.intakeResume}
        </Button>
      </div>
      {intake === 'off' ? (
        <p className="text-xs text-muted">
          {HOUSEHOLD_LABELS.intakeResumeNote}
        </p>
      ) : null}
      {notice === null ? null : (
        <InlineNotice tone={notice.tone} text={notice.text} />
      )}
    </div>
  );
}

// 定期の支出と固定費の目安（ADR 0165）。中枢が 12 か月の記録から毎回計算した値を出す。
function RecurringBlock({
  recurring,
}: {
  readonly recurring: HouseholdRecurringSummary;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-sm font-semibold">
        {HOUSEHOLD_LABELS.recurringTitle}
      </h3>
      <p className="text-xs text-muted">{HOUSEHOLD_LABELS.recurringNote}</p>
      {recurring.items.length === 0 ? (
        <p className="text-sm text-muted">{HOUSEHOLD_LABELS.recurringEmpty}</p>
      ) : (
        <>
          <p className="text-sm">
            {`${HOUSEHOLD_LABELS.recurringTotal} `}
            <span className="font-semibold tabular-nums">
              {yenText(recurring.monthly_total_yen)}
            </span>
          </p>
          <ul
            aria-label={HOUSEHOLD_LABELS.recurringTitle}
            className="flex flex-col gap-0.5 text-sm"
          >
            {recurring.items.map((item) => (
              <li
                key={`${item.merchant}|${item.last_on}`}
                className="flex flex-wrap justify-between gap-2"
              >
                <span className="min-w-0 break-words">
                  {`${item.merchant}（${categoryLabel(item.category)}）`}
                </span>
                <span className="tabular-nums">
                  {`${yenText(item.typical_yen)} ・ ${monthsSeenText(item.months_seen)}`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// 書き出しの取り込み（ADR 0164）。ファイルは main が OS のファイル選択で本人に選ばせる。結果は最後の取り込みの件数。
function ImportBlock({
  state,
  actions,
}: {
  readonly state: HouseholdViewState;
  readonly actions: HouseholdActions;
}) {
  const notice = noticeAt(state, IMPORT_PLACE);
  const mine = state.busy === IMPORT_PLACE;
  const result = state.view?.last_import ?? null;
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-sm font-semibold">{HOUSEHOLD_LABELS.importTitle}</h3>
      <p className="text-xs text-muted">{HOUSEHOLD_LABELS.importNote}</p>
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="secondary"
          isDisabled={state.busy !== null}
          onPress={actions.importExport}
        >
          {mine ? HOUSEHOLD_LABELS.importing : HOUSEHOLD_LABELS.importButton}
        </Button>
      </div>
      {result === null ? null : (
        <InlineNotice
          tone={result.outcome === 'done' ? 'success' : 'warning'}
          text={importResultText(result)}
        />
      )}
      {notice === null ? null : (
        <InlineNotice tone={notice.tone} text={notice.text} />
      )}
    </div>
  );
}

export function HouseholdPanel({
  state,
  actions,
  now,
}: {
  readonly state: HouseholdViewState;
  readonly actions: HouseholdActions;
  // 画面の時計（最終取得の経過の基準）。
  readonly now: number;
}) {
  const view = state.view;
  const fetch = view?.fetch ?? 'unavailable';
  const fetchedText = elapsedText(view?.fetched_at ?? null, now);
  const headNotice = noticeAt(state, null);
  const loaded = view !== null && view.fetch !== 'unavailable';
  const entries =
    view === null
      ? []
      : [...view.entries].sort((a, b) => a.position - b.position);
  return (
    <Section
      id="household-heading"
      title={HOUSEHOLD_LABELS.section}
      action={
        <Button
          size="sm"
          variant="ghost"
          isDisabled={state.reading}
          onPress={actions.refresh}
        >
          {state.reading ? HOUSEHOLD_LABELS.reading : HOUSEHOLD_LABELS.refresh}
        </Button>
      }
    >
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <StatusText line={FETCH_LINES[fetch] as StatusLine} />
        {fetchedText === null ? null : (
          <span className="tabular-nums">{`${HOUSEHOLD_LABELS.lastFetched} ${fetchedText}`}</span>
        )}
      </p>
      {headNotice === null ? null : (
        <InlineNotice tone={headNotice.tone} text={headNotice.text} />
      )}
      {loaded ? <IntakeBlock state={state} actions={actions} /> : null}
      {!loaded || view.month === null || view.summary === null ? null : (
        <>
          <h3 className="text-sm font-semibold">
            {view.month === view.current_month
              ? `${monthText(view.month)}（${HOUSEHOLD_LABELS.thisMonth}）`
              : monthText(view.month)}
          </h3>
          <SummaryBlock month={view.month} summary={view.summary} />
          {view.truncated ? (
            <InlineNotice tone="warning" text={HOUSEHOLD_LABELS.truncated} />
          ) : null}
          {view.unreadable > 0 ? (
            <InlineNotice
              tone="warning"
              text={`読めない記録が\u00a0${String(view.unreadable)}\u00a0件あります（合計には入れていません）。`}
            />
          ) : null}
          {entries.length === 0 ? (
            <p className="text-sm text-muted">{HOUSEHOLD_LABELS.empty}</p>
          ) : (
            <ul
              aria-label={HOUSEHOLD_LABELS.entries}
              className="flex flex-col divide-y divide-separator"
            >
              {entries.map((entry) => (
                <EntryRow
                  key={entry.ref}
                  entry={entry}
                  state={state}
                  actions={actions}
                />
              ))}
            </ul>
          )}
        </>
      )}
      {!loaded || view.recurring === null ? null : (
        <RecurringBlock recurring={view.recurring} />
      )}
      {loaded ? <ImportBlock state={state} actions={actions} /> : null}
      {!loaded || view.months.length === 0 ? null : (
        <MonthList
          months={view.months}
          current={view.current_month}
          selected={view.month}
          state={state}
          actions={actions}
        />
      )}
    </Section>
  );
}
