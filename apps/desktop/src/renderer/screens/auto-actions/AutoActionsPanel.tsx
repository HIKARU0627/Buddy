// 自動実行の欄（B13-05、ADR 0154。設計 03「取り消しと安全停止」、J12）。標準の端末画面（従来の窓）の本体に置く。
// 頭に取得状態と最終取得（経過）。次に安全停止の欄: 止まっていれば理由と停止からの経過と「自動実行を再開する」（画面の
// 中でもう一度確かめてから送る）、動いていればその一行、確かめられていなければその一行。最後に自動で行った操作の行:
// 種類・実行からの経過・取り消しの状態（取り消せるなら期限までの残り）と「取り消す」。本文は中枢も返さないので出さない。
// 未取得・取得の失敗を「自動で行った操作はありません」「動いています」と言わない。理由のコード・API の名前は出さない。
import { Button } from '@heroui/react';
import type { DesktopAutoActionEntry } from '@buddy/contracts';
import { InlineNotice } from '../../components/InlineNotice.js';
import { Section } from '../../components/Section.js';
import { StatusText } from '../../components/StatusText.js';
import {
  AUTO_ACTION_KIND_LABELS,
  AUTO_ACTION_LABELS,
  FETCH_LABELS,
  SAFETY_PLACE,
  canUndo,
  elapsedText,
  safetyShown,
  UNDO_EFFECT_LABELS,
  undoStateText,
} from '../../state/auto-action-state.js';
import type {
  AutoActionActions,
  AutoActionViewState,
} from '../../state/auto-action-state.js';
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

function noticeAt(state: AutoActionViewState, place: string | null) {
  return state.notice !== null && state.notice.place === place
    ? state.notice
    : null;
}

function SafetyBlock({
  state,
  actions,
  now,
}: {
  readonly state: AutoActionViewState;
  readonly actions: AutoActionActions;
  readonly now: number;
}) {
  const shown = safetyShown(state.view, now);
  const notice = noticeAt(state, SAFETY_PLACE);
  const busy = state.busy !== null;
  const mine = state.busy === SAFETY_PLACE;
  if (shown.kind !== 'stopped')
    return (
      <div className="flex flex-col gap-1.5" data-safety={shown.kind}>
        {state.view === null ||
        (state.view.fetch === 'unavailable' &&
          shown.kind === 'unknown') ? null : (
          <StatusText
            className="text-sm"
            line={
              shown.kind === 'running'
                ? {
                    tone: 'success',
                    mark: 'dot',
                    text: AUTO_ACTION_LABELS.running,
                  }
                : {
                    tone: 'neutral',
                    mark: 'circle',
                    text: AUTO_ACTION_LABELS.safetyUnknown,
                  }
            }
          />
        )}
        {notice === null ? null : (
          <InlineNotice tone={notice.tone} text={notice.text} />
        )}
      </div>
    );
  const confirming = state.confirming === shown.ref;
  return (
    <div
      role="group"
      aria-label={AUTO_ACTION_LABELS.stoppedTitle}
      data-safety="stopped"
      className="flex flex-col gap-2 rounded-md border border-danger-soft-foreground p-3"
    >
      <StatusText
        className="text-sm font-semibold"
        line={{
          tone: 'danger',
          mark: 'warning',
          text: AUTO_ACTION_LABELS.stoppedTitle,
        }}
      />
      {shown.reason === null ? null : <p className="text-sm">{shown.reason}</p>}
      {shown.stoppedText === null ? null : (
        <p className="text-xs tabular-nums text-muted">{`${AUTO_ACTION_LABELS.stoppedAt} ${shown.stoppedText}`}</p>
      )}
      {confirming ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm">{AUTO_ACTION_LABELS.resumeConfirm}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy}
              onPress={actions.cancelResume}
            >
              {AUTO_ACTION_LABELS.cancel}
            </Button>
            <Button
              size="sm"
              variant="primary"
              isDisabled={busy}
              onPress={actions.resume}
            >
              {mine
                ? AUTO_ACTION_LABELS.resuming
                : AUTO_ACTION_LABELS.resumeSubmit}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="secondary"
            isDisabled={busy}
            onPress={actions.startResume}
          >
            {AUTO_ACTION_LABELS.resume}
          </Button>
        </div>
      )}
      {notice === null ? null : (
        <InlineNotice tone={notice.tone} text={notice.text} />
      )}
    </div>
  );
}

function AutoActionRow({
  entry,
  state,
  actions,
  now,
}: {
  readonly entry: DesktopAutoActionEntry;
  readonly state: AutoActionViewState;
  readonly actions: AutoActionActions;
  readonly now: number;
}) {
  const kind = AUTO_ACTION_KIND_LABELS[entry.kind];
  const elapsed = elapsedText(entry.completed_at, now);
  const notice = noticeAt(state, entry.ref);
  const busy = state.busy !== null;
  const mine = state.busy === entry.ref;
  return (
    <li
      data-kind={entry.kind}
      data-undo={entry.undo_state}
      className="flex flex-col gap-1.5 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold">{kind}</span>
        {elapsed === null ? null : (
          <span className="ml-auto text-xs tabular-nums text-muted">{`${AUTO_ACTION_LABELS.completed} ${elapsed}`}</span>
        )}
      </div>
      {entry.delivery_unknown ? (
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
          <span className="text-xs text-muted">
            {undoStateText(entry, now)}
          </span>
          {canUndo(entry, now) ? (
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy}
              aria-label={`${AUTO_ACTION_LABELS.undo}（${kind}）`}
              onPress={() => actions.undo(entry.ref)}
            >
              {mine ? AUTO_ACTION_LABELS.undoing : AUTO_ACTION_LABELS.undo}
            </Button>
          ) : null}
        </div>
      )}
      {!entry.delivery_unknown &&
      canUndo(entry, now) &&
      UNDO_EFFECT_LABELS[entry.kind] !== undefined ? (
        <p className="text-xs text-muted">{UNDO_EFFECT_LABELS[entry.kind]}</p>
      ) : null}
      {notice === null ? null : (
        <InlineNotice tone={notice.tone} text={notice.text} />
      )}
    </li>
  );
}

export function AutoActionsPanel({
  state,
  actions,
  now,
}: {
  readonly state: AutoActionViewState;
  readonly actions: AutoActionActions;
  // 画面の時計（経過と期限までの残りの基準）。
  readonly now: number;
}) {
  const view = state.view;
  const fetch = view?.fetch ?? 'unavailable';
  const fetchedText = elapsedText(view?.fetched_at ?? null, now);
  const headNotice = noticeAt(state, null);
  const entries =
    view === null
      ? []
      : [...view.entries].sort((a, b) => a.position - b.position);
  return (
    <Section
      id="auto-actions-heading"
      title={AUTO_ACTION_LABELS.section}
      action={
        <Button
          size="sm"
          variant="ghost"
          isDisabled={state.reading}
          onPress={actions.refresh}
        >
          {state.reading
            ? AUTO_ACTION_LABELS.reading
            : AUTO_ACTION_LABELS.refresh}
        </Button>
      }
    >
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <StatusText line={FETCH_LINES[fetch] as StatusLine} />
        {fetchedText === null ? null : (
          <span className="tabular-nums">{`${AUTO_ACTION_LABELS.lastFetched} ${fetchedText}`}</span>
        )}
      </p>
      {headNotice === null ? null : (
        <InlineNotice tone={headNotice.tone} text={headNotice.text} />
      )}
      <SafetyBlock state={state} actions={actions} now={now} />
      {view === null || view.fetch === 'unavailable' ? null : entries.length ===
        0 ? (
        <p className="text-sm text-muted">{AUTO_ACTION_LABELS.empty}</p>
      ) : (
        <ul
          aria-label={AUTO_ACTION_LABELS.section}
          className="flex flex-col divide-y divide-separator"
        >
          {entries.map((entry) => (
            <AutoActionRow
              key={entry.ref}
              entry={entry}
              state={state}
              actions={actions}
              now={now}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}
