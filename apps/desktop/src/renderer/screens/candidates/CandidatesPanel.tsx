// 気づきの欄（B11-05、ADR 0132。設計 01 気づき、設計 11 §4）。標準の端末画面（従来の窓）の本体に置く。
// 頭に最終取得時刻（本人のタイムゾーン）・取得状態・新着の件数。見出し（今日・明日・今週・それ以降・期限不明）ごとに行を
// 並べ、初回取り込みの過去の期限は折りたたむ。行は題・期限（日付だけなら「日付のみの期限」）・種類・状態と注記
// （メールは「対応済みかは未確認」、一部未読、自動実行の操作）。操作は「開く」「今回は扱わない」「再通知」（明日・来週・
// 日時を指定）。未取得・取得の失敗を「気づきはありません」と言わない。理由のコード・API の名前は出さない。
// 「根拠を見る」（ADR 0201）: 押すたびに中枢が許可範囲から取り直した根拠（引用・未読・抄録）を行の下に出す。確かめられない
// ときは「未確認」とだけ出し、推測で埋めない。引用は行を開いている間だけで、保存しない。「相談する」は後の段階（ADR 0132）。
// 自動実行の操作が結び付いた行には「この気づきから自動で行った操作」の欄（ADR 0199）: 種類・実行からの経過・取り消しの
// 状態と「取り消す」（自動実行の欄と同じ経路）。取り消せない行は押せないボタンと理由を出す。一覧に無い操作は件数だけ。
// 頭の下に「新しい気づきを OS の通知で知らせる」の選択（ADR 0196。既定は切）。設定を読めていない間は選択を置かない。
import {
  Button,
  Checkbox,
  Chip,
  Description,
  Disclosure,
  FieldError,
  Input,
  Label,
  TextField,
} from '@heroui/react';
import type {
  DesktopAutoActionEntry,
  DesktopCandidateEntry,
} from '@buddy/contracts';
import { InlineNotice } from '../../components/InlineNotice.js';
import { Section } from '../../components/Section.js';
import { StatusText } from '../../components/StatusText.js';
import {
  CANDIDATE_LABELS,
  EVIDENCE_LABELS,
  FETCH_LABELS,
  KIND_LABELS,
  STATE_LABELS,
  candidateSections,
  deadlineText,
  evidenceLines,
  headerOf,
  rowActions,
  rowNotes,
  snoozePreview,
  unlistedText,
} from '../../state/candidate-state.js';
import {
  AUTO_ACTION_KIND_LABELS,
  AUTO_ACTION_LABELS,
  UNDO_EFFECT_LABELS,
  canUndo,
  elapsedText,
  undoStateText,
} from '../../state/auto-action-state.js';
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

// OS の通知の入・切（ADR 0073・0196）。選んだらすぐ中枢へ送る（版は main が持つ）。送っている間・断られて読み直している間は
// 押させない。
function AlertSetting({
  state,
  actions,
}: {
  readonly state: CandidateViewState;
  readonly actions: CandidateActions;
}) {
  const alert = state.view?.alert ?? null;
  if (alert === null)
    return state.view === null ? null : (
      <p className="text-xs text-muted" data-candidate-alert="unavailable">
        {CANDIDATE_LABELS.alertUnavailable}
      </p>
    );
  return (
    <div
      className={`px-3 py-2.5 ${FRAME_CLASS}`}
      data-candidate-alert={alert.os_notification}
    >
      <Checkbox
        isSelected={alert.os_notification === 'on'}
        isDisabled={state.alertBusy}
        onChange={(selected) => actions.setAlert(selected ? 'on' : 'off')}
      >
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <Label>
            {state.alertBusy
              ? `${CANDIDATE_LABELS.alert}（${CANDIDATE_LABELS.alertBusy}）`
              : CANDIDATE_LABELS.alert}
          </Label>
        </Checkbox.Content>
        <Description className="text-xs leading-5 text-muted">
          {CANDIDATE_LABELS.alertDescription}
        </Description>
      </Checkbox>
    </div>
  );
}

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

// 取り消しの状態のうち、押せないボタンで「今は取り消せない」ことを見せるもの（取り消し中・取り消し済みは文言だけ）。
const UNDO_BLOCKED: ReadonlySet<DesktopAutoActionEntry['undo_state']> = new Set(
  ['available', 'unavailable', 'expired', 'target_changed'],
);

function LinkedAutoAction({
  candidate,
  auto,
  state,
  actions,
  now,
}: {
  readonly candidate: DesktopCandidateEntry;
  readonly auto: DesktopAutoActionEntry;
  readonly state: CandidateViewState;
  readonly actions: CandidateActions;
  readonly now: number;
}) {
  const kind = AUTO_ACTION_KIND_LABELS[auto.kind];
  const elapsed = elapsedText(auto.completed_at, now);
  const undoable = canUndo(auto, now);
  const mine = state.busy === auto.ref;
  return (
    <li
      data-kind={auto.kind}
      data-undo={auto.undo_state}
      className="flex flex-col gap-1"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm">{kind}</span>
        {elapsed === null ? null : (
          <span className="ml-auto text-xs tabular-nums text-muted">{`${AUTO_ACTION_LABELS.completed} ${elapsed}`}</span>
        )}
      </div>
      {auto.delivery_unknown ? (
        <StatusText
          className="text-sm"
          line={{
            tone: 'danger',
            mark: 'warning',
            text: AUTO_ACTION_LABELS.unknown,
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted">{undoStateText(auto, now)}</span>
          {UNDO_BLOCKED.has(auto.undo_state) ? (
            <Button
              size="sm"
              variant="secondary"
              isDisabled={!undoable || state.busy !== null}
              aria-label={`${AUTO_ACTION_LABELS.undo}（${kind}・${candidate.title}）`}
              onPress={() => actions.undoAutoAction(candidate.ref, auto.ref)}
            >
              {mine ? AUTO_ACTION_LABELS.undoing : AUTO_ACTION_LABELS.undo}
            </Button>
          ) : null}
        </div>
      )}
      {undoable && UNDO_EFFECT_LABELS[auto.kind] !== undefined ? (
        <p className="text-xs text-muted">{UNDO_EFFECT_LABELS[auto.kind]}</p>
      ) : null}
    </li>
  );
}

function LinkedAutoActions({
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
  if (!entry.has_operations) return null;
  const fetch = state.view?.auto_action_fetch ?? 'unavailable';
  return (
    <div
      role="group"
      aria-label={`${CANDIDATE_LABELS.autoActions}（${entry.title}）`}
      data-auto-actions={fetch}
      className={`flex flex-col gap-2 px-3 py-2.5 ${FRAME_CLASS}`}
    >
      <p className="text-xs font-semibold text-muted">
        {CANDIDATE_LABELS.autoActions}
      </p>
      {fetch === 'unavailable' ? (
        <p className="text-xs text-muted">
          {CANDIDATE_LABELS.autoActionsUnread}
        </p>
      ) : fetch === 'stale' ? (
        <p className="text-xs text-muted">
          {CANDIDATE_LABELS.autoActionsStale}
        </p>
      ) : null}
      {entry.auto_actions.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {entry.auto_actions.map((auto) => (
            <LinkedAutoAction
              key={auto.ref}
              candidate={entry}
              auto={auto}
              state={state}
              actions={actions}
              now={now}
            />
          ))}
        </ul>
      )}
      {fetch === 'unavailable' || entry.auto_actions_unlisted === 0 ? null : (
        <p className="text-xs text-muted">
          {unlistedText(entry.auto_actions_unlisted)}
        </p>
      )}
    </div>
  );
}

// 根拠を見る（ADR 0201）。押すたびに取り直し、開いている行の下に出す。
function EvidenceBox({
  entry,
  state,
  actions,
}: {
  readonly entry: DesktopCandidateEntry;
  readonly state: CandidateViewState;
  readonly actions: CandidateActions;
}) {
  const shown =
    state.evidence !== null && state.evidence.ref === entry.ref
      ? state.evidence
      : null;
  if (shown === null) return null;
  const lines = evidenceLines(shown);
  return (
    <div
      data-evidence={shown.loading ? 'loading' : (shown.view?.status ?? 'none')}
      className={`${FRAME_CLASS} flex flex-col gap-1.5 p-3`}
    >
      {lines.tone === 'muted' ? (
        <p role="status" className="text-sm text-muted">
          {lines.text}
        </p>
      ) : (
        <InlineNotice tone={lines.tone} text={lines.text} />
      )}
      {lines.quotes.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted">{EVIDENCE_LABELS.quotes}</p>
          <ul className="flex flex-col gap-1 text-sm">
            {lines.quotes.map((quote, index) => (
              <li key={`${String(index)}:${quote}`} className="break-words">
                「{quote}」
              </li>
            ))}
          </ul>
        </div>
      )}
      {lines.notes.length === 0 ? null : (
        <ul className="flex flex-col gap-0.5 text-xs text-muted">
          {lines.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {lines.excerpt === null ? null : (
        <p className="text-xs text-muted break-words">
          {EVIDENCE_LABELS.excerpt}: {lines.excerpt}
        </p>
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="tertiary"
          aria-label={`${EVIDENCE_LABELS.hide}（${entry.title}）`}
          onPress={() => actions.hideEvidence()}
        >
          {EVIDENCE_LABELS.hide}
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
      <LinkedAutoActions
        entry={entry}
        state={state}
        actions={actions}
        now={now}
      />
      {waiting ? (
        <StatusText
          className="text-sm"
          line={{
            tone: 'danger',
            mark: 'warning',
            text: CANDIDATE_LABELS.unknown,
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            isDisabled={
              state.evidence?.ref === entry.ref && state.evidence.loading
            }
            aria-label={`${EVIDENCE_LABELS.show}（${entry.title}）`}
            onPress={() => actions.showEvidence(entry.ref)}
          >
            {state.evidence?.ref === entry.ref && state.evidence.loading
              ? CANDIDATE_LABELS.reading
              : EVIDENCE_LABELS.show}
          </Button>
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
      <EvidenceBox entry={entry} state={state} actions={actions} />
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
      <AlertSetting state={state} actions={actions} />
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
