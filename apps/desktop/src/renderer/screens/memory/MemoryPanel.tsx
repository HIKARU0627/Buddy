// 忘却の画面（UI-10、Issue #180。設計 03 忘却と再取り込み、ADR 0024・0054・0180・0181・0183）。標準の端末画面（従来の窓）の
// 本体に置く。
// - 左: 記憶の一覧。種類の見出しの下に行（本文・由来の件数・期限・見直し待ちの印）と「忘却の計画を作る」。
// - 右: 選んだ記憶の忘却の計画。「消える物」「消える指示」「残る物」の順に件数と対象の行。計画は中枢が作り、画面は見せるだけ。
//   「消える指示」は指示ごとの本文と範囲の行（U433、ADR 0185）。本文は省略せず折り返して全部出す（200 文字まで）。中枢が
//   本文を読めなかった指示は ⚠ と「本文を読めない指示」の行にし、一緒に消えることを書く。
// - 下: 確認の帯（件数・計画の時点の忘却の回数・期限・「忘れる（確認へ）」）。実行のボタンはこの帯の中だけに置く。押すと main が
//   OS の確認ダイアログを 1 回出す。
// 忘却の公開ゲートが閉じている・中枢が 503 を返した間は、計画・実行のボタンを無効にし、理由を欄の頭に出す（ADR 0183。
// ADR 0024 の約束 7 の例外）。結果が分からないときは「消えたかもしれません」と出し、自動では送り直さない。
// 理由のコード・API の名前・「世代」の語は出さない。
import type { ReactNode } from 'react';
import { Button, Chip } from '@heroui/react';
import type {
  DesktopForgetPlanView,
  DesktopMemoryEntry,
} from '@buddy/contracts';
import { InlineNotice } from '../../components/InlineNotice.js';
import { Section } from '../../components/Section.js';
import { StatusMark, StatusText } from '../../components/StatusText.js';
import { FRAME_CLASS, FRAME_DANGER_CLASS } from '../../shapes.js';
import {
  BAND_PLACE,
  DIRECTIVE_SCOPE_LABELS,
  HEAD_PLACE,
  MEMORY_KIND_LABELS,
  MEMORY_LABELS,
  ORIGIN_LABELS,
  PLAN_PLACE,
  bandSummary,
  deadlineText,
  expiryText,
  forgetAvailability,
  generationText,
  groupByKind,
  keptLines,
  removedLines,
  shownPlan,
  sourceText,
} from '../../state/memory-state.js';
import type {
  ForgetAvailability,
  MemoryActions,
  MemoryViewState,
} from '../../state/memory-state.js';
import { elapsedText } from '../../state/auto-action-state.js';
import type { StatusLine } from '../../tones.js';

const NB = ' ';
const GATE_NOTE_ID = 'memory-forget-gate-note';

const FETCH_LINES: Readonly<Record<string, StatusLine>> = {
  loaded: { tone: 'success', mark: 'dot', text: '取得できています' },
  stale: {
    tone: 'warning',
    mark: 'warning',
    text: '最新の取得に失敗しました。前回の内容を表示しています',
  },
  unavailable: {
    tone: 'neutral',
    mark: 'circle',
    text: 'まだ取得できていません',
  },
};

function noticeAt(state: MemoryViewState, place: string) {
  return state.notice !== null && state.notice.place === place
    ? state.notice
    : null;
}

function GateNote({
  availability,
}: {
  readonly availability: ForgetAvailability;
}) {
  if (availability === 'open') return null;
  return (
    <p
      id={GATE_NOTE_ID}
      data-forget={availability}
      className="flex max-w-prose items-start gap-1.5 text-sm leading-6"
    >
      <span className="flex shrink-0">
        <StatusMark line={{ tone: 'neutral', mark: 'circle', text: '' }} />
      </span>
      <span>
        {availability === 'closed'
          ? MEMORY_LABELS.closed
          : MEMORY_LABELS.unavailable}
      </span>
    </p>
  );
}

function MemoryRow({
  entry,
  state,
  actions,
  inPlan,
  selected,
  available,
}: {
  readonly entry: DesktopMemoryEntry;
  readonly state: MemoryViewState;
  readonly actions: MemoryActions;
  readonly inPlan: boolean;
  readonly selected: boolean;
  readonly available: boolean;
}) {
  const source = sourceText(entry);
  const deadline = deadlineText(entry);
  const notice = noticeAt(state, entry.ref);
  const mine = state.busy === entry.ref;
  return (
    <li
      data-memory-status={entry.status}
      data-in-plan={inPlan ? 'true' : 'false'}
      aria-current={selected ? 'true' : undefined}
      className="flex flex-col gap-1.5 px-3 py-2.5"
    >
      <p className="text-sm leading-6">{entry.text}</p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        {entry.status === 'review_pending' ? (
          <StatusText
            className="font-semibold text-foreground"
            line={{
              tone: 'warning',
              mark: 'warning',
              text: MEMORY_LABELS.reviewPending,
            }}
          />
        ) : null}
        {deadline === null ? null : (
          <span className="tabular-nums">{deadline}</span>
        )}
        <span>{ORIGIN_LABELS[entry.origin]}</span>
        {source === null ? null : <span>{source}</span>}
      </div>
      {selected ? (
        <StatusText
          className="text-xs"
          line={{
            tone: 'neutral',
            mark: 'square',
            text: '右に、この記憶を忘れる計画を出しています',
          }}
        />
      ) : null}
      {inPlan && !selected ? (
        <StatusText
          className="text-xs"
          line={{
            tone: 'danger',
            mark: 'warning',
            text: 'この計画で一緒に消えます',
          }}
        />
      ) : null}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="secondary"
          isDisabled={!available || state.busy !== null}
          {...(available ? {} : { 'aria-describedby': GATE_NOTE_ID })}
          aria-label={`${MEMORY_LABELS.makePlan}（${entry.text}）`}
          onPress={() => actions.plan(entry.ref)}
        >
          {mine ? MEMORY_LABELS.planning : MEMORY_LABELS.makePlan}
        </Button>
      </div>
      {notice === null ? null : (
        <InlineNotice tone={notice.tone} text={notice.text} />
      )}
    </li>
  );
}

function MemoryList({
  state,
  actions,
  plan,
  available,
}: {
  readonly state: MemoryViewState;
  readonly actions: MemoryActions;
  readonly plan: DesktopForgetPlanView | null;
  readonly available: boolean;
}) {
  const view = state.view;
  if (view === null || view.fetch === 'unavailable') return null;
  if (view.entries.length === 0)
    return <p className="text-sm text-muted">{MEMORY_LABELS.empty}</p>;
  const inPlan = new Set(plan?.removed.memory_refs ?? []);
  return (
    <div className="flex flex-col gap-4">
      {groupByKind(view.entries).map((group) => (
        <section
          key={group.kind}
          aria-labelledby={`memory-kind-${group.kind}`}
          className="flex flex-col gap-1"
        >
          <h4
            id={`memory-kind-${group.kind}`}
            className="flex items-center gap-2 text-sm font-semibold"
          >
            {MEMORY_KIND_LABELS[group.kind]}
            <Chip size="sm" color="default" variant="secondary">
              {`${group.entries.length}${NB}件`}
            </Chip>
          </h4>
          <ul
            aria-label={MEMORY_KIND_LABELS[group.kind]}
            className={`flex flex-col divide-y divide-separator ${FRAME_CLASS}`}
          >
            {group.entries.map((entry) => (
              <MemoryRow
                key={entry.ref}
                entry={entry}
                state={state}
                actions={actions}
                inPlan={inPlan.has(entry.ref)}
                selected={plan?.target_ref === entry.ref}
                available={available}
              />
            ))}
          </ul>
        </section>
      ))}
      {view.truncated ? (
        <p className="text-xs text-muted">{MEMORY_LABELS.truncated}</p>
      ) : null}
    </div>
  );
}

function PlanPart({
  title,
  total,
  children,
}: {
  readonly title: string;
  readonly total: number;
  readonly children: ReactNode;
}) {
  const id = `memory-plan-${title}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5">
      <h4 id={id} className="flex items-center gap-2 text-sm font-semibold">
        {title}
        <span className="text-xs font-normal tabular-nums text-muted">{`${total}${NB}件`}</span>
      </h4>
      {children}
    </section>
  );
}

function DirectiveList({ plan }: { readonly plan: DesktopForgetPlanView }) {
  const directives = plan.removed.directives;
  if (directives.length === 0)
    return <p className="text-sm text-muted">{MEMORY_LABELS.noDirectives}</p>;
  return (
    <>
      <p className="max-w-prose text-sm leading-6">
        {MEMORY_LABELS.directivesLead}
      </p>
      <ul
        aria-label={MEMORY_LABELS.directives}
        className={`flex flex-col divide-y divide-separator ${FRAME_CLASS}`}
      >
        {directives.map((directive) => (
          <li
            key={directive.ref}
            data-directive={directive.text === null ? 'unreadable' : 'text'}
            className="flex min-w-0 flex-col gap-1 px-3 py-2"
          >
            {directive.text === null ? (
              <>
                <StatusText
                  className="text-sm font-semibold"
                  line={{
                    tone: 'warning',
                    mark: 'warning',
                    text: MEMORY_LABELS.directiveUnreadable,
                  }}
                />
                <p className="text-xs leading-5 text-muted">
                  {MEMORY_LABELS.directiveUnreadableBody}
                </p>
              </>
            ) : (
              <p className="min-w-0 break-words text-sm leading-6">
                {directive.text}
              </p>
            )}
            <p className="text-xs text-muted">
              {DIRECTIVE_SCOPE_LABELS[directive.scope]}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

function PlanView({
  plan,
  state,
}: {
  readonly plan: DesktopForgetPlanView;
  readonly state: MemoryViewState;
}) {
  const entries = state.view?.entries ?? [];
  const byRef = new Map(entries.map((entry) => [entry.ref, entry]));
  const removed = removedLines(plan);
  const kept = keptLines(plan);
  const removedCount = plan.removed.counts
    .filter((entry) => entry.kind !== 'user_directive')
    .reduce((sum, entry) => sum + entry.count, 0);
  const keptCount = plan.kept.operation_states.length + plan.kept.lineage_only;
  return (
    <div className="flex flex-col gap-4" data-plan={plan.ref}>
      <PlanPart title={MEMORY_LABELS.removed} total={removedCount}>
        <ul className="flex flex-col gap-0.5 text-sm">
          {removed.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {plan.removed.memory_refs.length === 0 ? null : (
          <ul
            aria-label="消える記憶"
            className={`flex flex-col divide-y divide-separator ${FRAME_CLASS}`}
          >
            {plan.removed.memory_refs.map((ref) => (
              <li key={ref} className="px-3 py-2 text-sm leading-6">
                {byRef.get(ref)?.text ?? '（一覧にない記憶）'}
              </li>
            ))}
          </ul>
        )}
        {plan.removed.unlisted_memory_count === 0 ? null : (
          <p className="text-xs text-muted">{`一覧に出ていない記憶 ${plan.removed.unlisted_memory_count}${NB}件も消えます。`}</p>
        )}
      </PlanPart>
      <PlanPart
        title={MEMORY_LABELS.directives}
        total={plan.removed.directives.length}
      >
        <DirectiveList plan={plan} />
      </PlanPart>
      <PlanPart title={MEMORY_LABELS.kept} total={keptCount}>
        {keptCount === 0 ? (
          <p className="text-sm text-muted">{MEMORY_LABELS.noKept}</p>
        ) : (
          <ul className="flex flex-col gap-0.5 text-sm">
            {kept.map((line) => (
              <li key={line}>{line}</li>
            ))}
            {plan.kept.lineage_only === 0 ? null : (
              <li>{`記録だけに残る確定内容 ${plan.kept.lineage_only}${NB}件`}</li>
            )}
          </ul>
        )}
        {plan.kept.operation_states.length === 0 ? null : (
          <p className="text-xs text-muted">
            残る操作は、外部への送出だけを止め、状態・承認は変えません。
          </p>
        )}
        {plan.blocked_source_count === 0 ? null : (
          <p className="text-xs text-muted">{`同じ由来（${plan.blocked_source_count}${NB}件）からは、これから保存し直しません。`}</p>
        )}
      </PlanPart>
    </div>
  );
}

function ResultBlock({ state }: { readonly state: MemoryViewState }) {
  const result = state.view?.result ?? null;
  if (result === null) return null;
  if (result.outcome === 'forgotten')
    return (
      <p role="status" data-result="forgotten" className="text-sm">
        <StatusText
          line={{
            tone: 'success',
            mark: 'dot',
            text: `${MEMORY_LABELS.forgotten}（消えた物 ${result.removed_total}${NB}件）`,
          }}
        />
      </p>
    );
  return (
    <div
      role="alert"
      data-result="outcome_unknown"
      className={`flex flex-col gap-1.5 p-3 ${FRAME_DANGER_CLASS}`}
    >
      <StatusText
        className="text-sm font-semibold"
        line={{
          tone: 'danger',
          mark: 'warning',
          text: MEMORY_LABELS.unknownTitle,
        }}
      />
      <p className="text-sm leading-6">{MEMORY_LABELS.unknownBody}</p>
    </div>
  );
}

function ConfirmBand({
  plan,
  state,
  actions,
  now,
  available,
}: {
  readonly plan: DesktopForgetPlanView;
  readonly state: MemoryViewState;
  readonly actions: MemoryActions;
  readonly now: number;
  readonly available: boolean;
}) {
  const expiry = expiryText(plan, now);
  const notice = noticeAt(state, BAND_PLACE);
  const mine = state.busy === BAND_PLACE;
  const usable = available && expiry !== null;
  return (
    <div
      role="group"
      aria-label={MEMORY_LABELS.bandTitle}
      data-band="confirm"
      className={`flex flex-col gap-2 p-3 ${FRAME_DANGER_CLASS}`}
    >
      <p className="text-sm font-semibold tabular-nums">{bandSummary(plan)}</p>
      <p className="text-xs tabular-nums text-muted">{generationText(plan)}</p>
      <p className="text-xs tabular-nums text-muted">
        {expiry === null ? MEMORY_LABELS.expired : `計画の期限: ${expiry}`}
      </p>
      <p className="text-sm leading-6">
        忘れた物は元に戻せません。押すと、もう一度だけ確認が出ます。
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          size="sm"
          variant="secondary"
          isDisabled={state.busy !== null}
          onPress={actions.dismiss}
        >
          {MEMORY_LABELS.dismiss}
        </Button>
        <Button
          size="sm"
          variant="danger"
          isDisabled={!usable || state.busy !== null}
          {...(available ? {} : { 'aria-describedby': GATE_NOTE_ID })}
          onPress={actions.execute}
        >
          {mine ? MEMORY_LABELS.executing : MEMORY_LABELS.execute}
        </Button>
      </div>
      {notice === null ? null : (
        <InlineNotice tone={notice.tone} text={notice.text} />
      )}
    </div>
  );
}

export function MemoryPanel({
  state,
  actions,
  now,
}: {
  readonly state: MemoryViewState;
  readonly actions: MemoryActions;
  // 画面の時計（最終取得の経過・計画の期限の基準）。
  readonly now: number;
}) {
  const view = state.view;
  const fetch = view?.fetch ?? 'unavailable';
  const fetchedText = elapsedText(view?.fetched_at ?? null, now);
  const availability = forgetAvailability(state);
  const available = availability === 'open';
  const plan = shownPlan(state);
  const headNotice = noticeAt(state, HEAD_PLACE);
  const planNotice = noticeAt(state, PLAN_PLACE);
  return (
    <Section
      id="memory-heading"
      title={MEMORY_LABELS.section}
      action={
        <Button
          size="sm"
          variant="ghost"
          isDisabled={state.reading}
          onPress={actions.refresh}
        >
          {state.reading ? MEMORY_LABELS.reading : MEMORY_LABELS.refresh}
        </Button>
      }
    >
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <StatusText line={FETCH_LINES[fetch] as StatusLine} />
        {fetchedText === null ? null : (
          <span className="tabular-nums">{`${MEMORY_LABELS.lastFetched} ${fetchedText}`}</span>
        )}
      </p>
      {view === null || view.fetch === 'unavailable' ? null : (
        <GateNote availability={availability} />
      )}
      {headNotice === null ? null : (
        <InlineNotice tone={headNotice.tone} text={headNotice.text} />
      )}
      <div className="grid gap-6 md:grid-cols-2">
        <section
          aria-labelledby="memory-list-heading"
          className="flex min-w-0 flex-col gap-2"
        >
          <h3 id="memory-list-heading" className="text-sm font-semibold">
            {MEMORY_LABELS.listTitle}
          </h3>
          <MemoryList
            state={state}
            actions={actions}
            plan={plan}
            available={available}
          />
        </section>
        <section
          aria-labelledby="memory-plan-heading"
          className="flex min-w-0 flex-col gap-2"
        >
          <h3 id="memory-plan-heading" className="text-sm font-semibold">
            {MEMORY_LABELS.planTitle}
          </h3>
          <ResultBlock state={state} />
          {planNotice === null ? null : (
            <InlineNotice tone={planNotice.tone} text={planNotice.text} />
          )}
          {plan === null ? (
            <p className="max-w-prose text-sm leading-6 text-muted">
              {MEMORY_LABELS.planNone}
            </p>
          ) : (
            <PlanView plan={plan} state={state} />
          )}
        </section>
      </div>
      {plan === null ? null : (
        <ConfirmBand
          plan={plan}
          state={state}
          actions={actions}
          now={now}
          available={available}
        />
      )}
    </Section>
  );
}
