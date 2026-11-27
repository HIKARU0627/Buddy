// 気づきの欄（B11-05、ADR 0132。設計 01 気づき、設計 11 §4）。標準の端末画面（従来の窓）の本体に置く。
// 頭に最終取得時刻（本人のタイムゾーン）・取得状態・新着の件数。見出し（今日・明日・今週・それ以降・期限不明）ごとに行を
// 並べ、初回取り込みの過去の期限は折りたたむ。行は題・期限（日付だけなら「日付のみの期限」）・種類・状態と注記
// （メールは「対応済みかは未確認」、一部未読、自動実行の操作）。操作は「開く」「今回は扱わない」「再通知」（明日・来週・
// 日時を指定）。未取得・取得の失敗を「気づきはありません」と言わない。理由のコード・API の名前は出さない。
// 「根拠を見る」「相談する」は後の段階（ADR 0132 の残論点）。
import {
  Button,
  Chip,
  Disclosure,
  FieldError,
  Input,
  Label,
  TextField,
} from '@heroui/react';
import type { DesktopCandidateEntry } from '@buddy/contracts';
import { InlineNotice } from '../../components/InlineNotice.js';
import { Section } from '../../components/Section.js';
import { StatusText } from '../../components/StatusText.js';
import {
  CANDIDATE_LABELS,
  FETCH_LABELS,
  KIND_LABELS,
  STATE_LABELS,
  candidateSections,
  deadlineText,
  headerOf,
  rowActions,
  rowNotes,
  snoozePreview,
} from '../../state/candidate-state.js';
import type {
  CandidateActions,
  CandidateSection,
  CandidateViewState,
} from '../../state/candidate-state.js';
import type { StatusLine } from '../../tones.js';
import { FRAME_CLASS } from '../../shapes.js';

const FETCH_LINES: Readonly<Record<string, StatusLine>> = {
  loaded: { tone: 'success', mark: 'dot', text: FETCH_LABELS.loaded },
  stale: { tone: 'warning', mark: 'warning', text: FETCH_LABELS.stale },
  unavailable: {
    tone: 'neutral',
    mark: 'circle',
    text: FETCH_LABELS.unavailable,
  },
};

function SnoozeChoices({
  entry,
  state,
  actions,
  now,
  busy,
}: {
  readonly entry: DesktopCandidateEntry;
  readonly state: CandidateViewState;
  readonly actions: CandidateActions;
  readonly now: number;
  readonly busy: boolean;
}) {
  const draft = state.snooze;
  if (draft === null || draft.ref !== entry.ref) return null;
  const zone = state.view?.zone ?? null;
  const tomorrow = snoozePreview('tomorrow', now, zone);
  const nextWeek = snoozePreview('next_week', now, zone);
  return (
    <div
      role="group"
      aria-label={`${CANDIDATE_LABELS.snooze}（${entry.title}）`}
      className={`flex flex-col gap-2 p-3 ${FRAME_CLASS}`}
    >
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          isDisabled={busy}
          onPress={() => actions.snooze(entry.ref, 'tomorrow')}
        >
          {tomorrow === null
            ? CANDIDATE_LABELS.snoozeTomorrow
            : `${CANDIDATE_LABELS.snoozeTomorrow} ${tomorrow}`}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          isDisabled={busy}
          onPress={() => actions.snooze(entry.ref, 'next_week')}
        >
          {nextWeek === null
            ? CANDIDATE_LABELS.snoozeNextWeek
            : `${CANDIDATE_LABELS.snoozeNextWeek} ${nextWeek}`}
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <TextField
          className="min-w-52"
          value={draft.input}
          onChange={(value) => actions.setSnoozeInput(value)}
          isInvalid={draft.problem !== null}
          isDisabled={busy}
        >
          <Label>
            {zone === null
              ? CANDIDATE_LABELS.snoozeAtInput
              : `${CANDIDATE_LABELS.snoozeAtInput}（${zone}）`}
          </Label>
          <Input variant="secondary" type="datetime-local" />
          <FieldError>{draft.problem}</FieldError>
        </TextField>
        <Button
          size="sm"
          variant="primary"
          isDisabled={busy}
          onPress={() => actions.snooze(entry.ref, 'at')}
        >
          {CANDIDATE_LABELS.snoozeSubmit}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          isDisabled={busy}
          onPress={actions.cancelSnooze}
        >
          {CANDIDATE_LABELS.cancel}
        </Button>
      </div>
    </div>
  );
}

function CandidateRow({
  entry,
  state,
  actions,
  now,
}: {
  readonly entry: DesktopCandidateEntry;
  readonly state: CandidateViewState;
  readonly actions: CandidateActions;
  readonly now: number;
}) {
  const zone = state.view?.zone ?? null;
  const busy = state.busy !== null;
  const mine = state.busy === entry.ref;
  const notice =
    state.notice !== null && state.notice.ref === entry.ref
      ? state.notice
      : null;
  const notes = rowNotes(entry);
  const allowed = rowActions(entry);
  const waiting = entry.delivery_unknown;
  return (
    <li
      data-kind={entry.kind}
      data-state={entry.state}
      className="flex flex-col gap-1.5 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Chip size="sm" color="default" variant="secondary">
          {KIND_LABELS[entry.kind]}
        </Chip>
        <span
          className={`text-xs ${entry.state === 'new' ? 'font-semibold' : 'text-muted'}`}
        >
          {STATE_LABELS[entry.state]}
        </span>
        <span className="ml-auto text-xs tabular-nums text-muted">
          {deadlineText(entry.deadline, zone)}
        </span>
      </div>
      <p className="text-sm font-semibold">{entry.title}</p>
      {notes.length === 0 ? null : (
        <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {waiting ? (
        <StatusText
          className="text-sm"
          line={{
            tone: 'danger',
            mark: 'warning',
            text: CANDIDATE_LABELS.unknown,
          }}
        />
      ) : allowed.length === 0 ? null : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {allowed.includes('open') ? (
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy}
              aria-label={`${CANDIDATE_LABELS.open}（${entry.title}）`}
              onPress={() => actions.open(entry.ref)}
            >
              {mine ? CANDIDATE_LABELS.busy : CANDIDATE_LABELS.open}
            </Button>
          ) : null}
          {allowed.includes('snooze') ? (
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy}
              aria-label={`${CANDIDATE_LABELS.snooze}（${entry.title}）`}
              onPress={() => actions.startSnooze(entry.ref)}
            >
              {CANDIDATE_LABELS.snooze}
            </Button>
          ) : null}
          {allowed.includes('dismiss') ? (
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy}
              aria-label={`${CANDIDATE_LABELS.dismiss}（${entry.title}）`}
              onPress={() => actions.dismiss(entry.ref)}
            >
              {mine ? CANDIDATE_LABELS.busy : CANDIDATE_LABELS.dismiss}
            </Button>
          ) : null}
        </div>
      )}
      {waiting || !allowed.includes('snooze') ? null : (
        <SnoozeChoices
          entry={entry}
          state={state}
          actions={actions}
          now={now}
          busy={busy}
        />
      )}
      {notice === null ? null : (
        <InlineNotice tone={notice.tone} text={notice.text} />
      )}
    </li>
  );
}

function Rows({
  section,
  state,
  actions,
  now,
}: {
  readonly section: CandidateSection;
  readonly state: CandidateViewState;
  readonly actions: CandidateActions;
  readonly now: number;
}) {
  return (
    <ul
      aria-label={section.label ?? CANDIDATE_LABELS.section}
      className="flex flex-col divide-y divide-separator"
    >
      {section.entries.map((entry) => (
        <CandidateRow
          key={entry.ref}
          entry={entry}
          state={state}
          actions={actions}
          now={now}
        />
      ))}
    </ul>
  );
}

function SectionBlock({
  section,
  state,
  actions,
  now,
}: {
  readonly section: CandidateSection;
  readonly state: CandidateViewState;
  readonly actions: CandidateActions;
  readonly now: number;
}) {
  const title =
    section.label === null
      ? null
      : `${section.label}（${section.entries.length}\u00a0件）`;
  if (section.collapsed && title !== null)
    return (
      <Disclosure data-heading={section.heading ?? undefined}>
        <Disclosure.Heading>
          <Disclosure.Trigger className="flex w-full items-center justify-between text-sm">
            <span className="font-semibold">{title}</span>
            <Disclosure.Indicator />
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body>
            <Rows section={section} state={state} actions={actions} now={now} />
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    );
  return (
    <div data-heading={section.heading ?? undefined} className="flex flex-col">
      {title === null ? null : (
        <h3 className="text-sm font-semibold text-muted">{title}</h3>
      )}
      <Rows section={section} state={state} actions={actions} now={now} />
    </div>
  );
}

export function CandidatesPanel({
  state,
  actions,
  now,
}: {
  readonly state: CandidateViewState;
  readonly actions: CandidateActions;
  // 画面の時計（再通知の選択肢に添える時刻の基準）。
  readonly now: number;
}) {
  const header = headerOf(state.view);
  const view = state.view;
  const grouped = view === null ? null : candidateSections(view);
  const headNotice =
    state.notice !== null && state.notice.ref === null ? state.notice : null;
  return (
    <Section
      id="candidates-heading"
      title={
        header.newCount === null || header.newCount === 0
          ? CANDIDATE_LABELS.section
          : `${CANDIDATE_LABELS.section}（${CANDIDATE_LABELS.newCount} ${header.newCount}\u00a0件）`
      }
      action={
        <Button
          size="sm"
          variant="ghost"
          isDisabled={state.reading}
          onPress={actions.refresh}
        >
          {state.reading ? CANDIDATE_LABELS.reading : CANDIDATE_LABELS.refresh}
        </Button>
      }
    >
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <StatusText line={FETCH_LINES[header.fetch] as StatusLine} />
        {header.fetchedText === null ? null : (
          <span className="tabular-nums">{`${CANDIDATE_LABELS.lastFetched} ${header.fetchedText}`}</span>
        )}
        {header.newCount === null ? null : (
          <span className="tabular-nums">{`${CANDIDATE_LABELS.newCount} ${header.newCount}\u00a0件`}</span>
        )}
      </p>
      {headNotice === null ? null : (
        <InlineNotice tone={headNotice.tone} text={headNotice.text} />
      )}
      {view === null || grouped === null ? null : view.fetch ===
        'unavailable' ? null : grouped.sections.length === 0 ? (
        <p className="text-sm text-muted">{CANDIDATE_LABELS.empty}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {grouped.headed ? null : (
            <p className="text-xs text-muted">{CANDIDATE_LABELS.zoneMissing}</p>
          )}
          {grouped.sections.map((section) => (
            <SectionBlock
              key={section.heading ?? 'all'}
              section={section}
              state={state}
              actions={actions}
              now={now}
            />
          ))}
        </div>
      )}
      {view?.truncated === true ? (
        <p className="text-xs text-muted">{CANDIDATE_LABELS.truncated}</p>
      ) : null}
    </Section>
  );
}
