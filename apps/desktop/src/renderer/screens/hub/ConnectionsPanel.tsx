// 中枢の画面の「連携アカウント」のタブ（B08-02 P3・B09-05、ADR 0142。設計 01 接続・端末、設計 04 接続・権限／
// 取得する対象）。連携の接続ごとに、提供元・状態・許可されている権限と、取得する対象と範囲（今選んでいる
// カレンダー・フォルダー／ラベル、期間、添付の種類と大きさ）を示し、対象を外すことと範囲の変更を保存できる。
// Microsoft の接続は、アカウント種別・委任・拒否の理由と使える範囲・カテゴリの扱いも示す（設計 04、ADR 0072）。
// - 対象の表示名は契約にないため、ID のまま出す（推測で名前を作らない）。
// - 新しい対象はここでは足せない（接続時に決まる。B03-04）。その旨を欄に書く。
// - 未取得・取得の失敗を「連携しているアカウントはまだありません」と言わない（設計 01）。
// - 接続の作成・接続解除・追加権限はこの画面の操作ではない（B03-04。設計 01 の接続・端末の操作のうち、
//   この画面が受け持つのは対象選択だけ）。
// 状態と操作は引数で受け取り、限定 API を直接呼ばない。理由のコード・API の名前は出さない。
import { useState } from 'react';
import {
  Button,
  Checkbox,
  FieldError,
  Input,
  Label,
  TextField,
} from '@heroui/react';
import type { DesktopConnectionEntry } from '@buddy/contracts';
import { FETCH_SCOPE_LIMITS } from '@buddy/domain';
import { InlineNotice } from '../../components/InlineNotice.js';
import { Section } from '../../components/Section.js';
import { StatusText } from '../../components/StatusText.js';
import {
  ACCESS_LABELS,
  ATTACHMENT_KIND_LABELS,
  CONNECTION_FETCH_LABELS,
  CONNECTION_LABELS,
  CONNECTION_STATUS_LABELS,
  CONTAINER_LABELS,
  GRAPH_ACCOUNT_KIND_LABELS,
  GRAPH_CATEGORY_LABELS,
  GRAPH_DELEGATION_LABELS,
  GRAPH_REJECTION_LABELS,
  PROVIDER_LABELS,
  draftChanged,
  draftFromTargets,
  draftToTargets,
} from '../../state/connections-state.js';
import type {
  ConnectionActions,
  ConnectionsViewState,
  TargetsDraft,
} from '../../state/connections-state.js';
import type { StatusLine } from '../../tones.js';

const FETCH_LINES: Readonly<Record<string, StatusLine>> = {
  loaded: {
    tone: 'success',
    mark: 'dot',
    text: CONNECTION_FETCH_LABELS.loaded,
  },
  stale: {
    tone: 'warning',
    mark: 'warning',
    text: CONNECTION_FETCH_LABELS.stale,
  },
  unavailable: {
    tone: 'neutral',
    mark: 'circle',
    text: CONNECTION_FETCH_LABELS.unavailable,
  },
};

const intIn = (value: string, min: number, max: number): boolean =>
  /^[0-9]+$/.test(value.trim()) && Number(value) >= min && Number(value) <= max;

function toggle<T>(values: readonly T[], value: T, on: boolean): T[] {
  return on ? [...values, value] : values.filter((item) => item !== value);
}

function IdChoices({
  label,
  ids,
  selected,
  disabled,
  onToggle,
}: {
  readonly label: string;
  readonly ids: readonly string[];
  readonly selected: readonly string[];
  readonly disabled: boolean;
  readonly onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm font-medium">{label}</legend>
      {ids.length === 0 ? (
        <p className="text-sm text-muted">選んでいる{label}はありません。</p>
      ) : (
        ids.map((id) => (
          <Checkbox
            key={id}
            isSelected={selected.includes(id)}
            isDisabled={disabled}
            onChange={(on) => onToggle(id, on)}
          >
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              <Label className="break-all">{id}</Label>
            </Checkbox.Content>
          </Checkbox>
        ))
      )}
    </fieldset>
  );
}

function NumberField({
  label,
  value,
  invalid,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly invalid: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <TextField
      className="min-w-52"
      value={value}
      onChange={onChange}
      isInvalid={invalid}
      isDisabled={disabled}
    >
      <Label>{label}</Label>
      <Input variant="secondary" inputMode="numeric" />
      {invalid ? (
        <FieldError>{CONNECTION_LABELS.rangeProblem}</FieldError>
      ) : null}
    </TextField>
  );
}

function ConnectionCard({
  entry,
  state,
  actions,
  paused,
}: {
  readonly entry: DesktopConnectionEntry;
  readonly state: ConnectionsViewState;
  readonly actions: ConnectionActions;
  readonly paused: boolean;
}) {
  // 下書きは保存値から始める。保存値が変わったら（保存できた・読み直した）、カードを作り直して下書きを合わせる
  // （親が key に保存値を含める）。
  const [draft, setDraft] = useState<TargetsDraft>(() =>
    draftFromTargets(entry.targets),
  );
  const busy = state.busy !== null;
  const held = entry.delivery_unknown;
  const disabled = paused || busy || held;
  const targets = draftToTargets(draft);
  const changed = draftChanged(entry.targets, draft);
  const notice =
    state.notice !== null && state.notice.ref === entry.ref
      ? state.notice
      : null;
  const graph = entry.graph_account;
  return (
    <div className="flex flex-col gap-3 border-t border-separator pt-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold">
          {PROVIDER_LABELS[entry.provider]}
        </h3>
        <span className="text-sm">
          {CONNECTION_STATUS_LABELS[entry.status]}
        </span>
        <span className="text-xs text-muted">
          {ACCESS_LABELS[entry.access]}
        </span>
      </div>
      {graph === null ? null : (
        <dl className="flex flex-col gap-1 text-sm leading-6">
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted">{CONNECTION_LABELS.account}</dt>
            <dd>
              {GRAPH_ACCOUNT_KIND_LABELS[graph.account_kind]}（
              {GRAPH_DELEGATION_LABELS[graph.delegation]}）
            </dd>
          </div>
          {graph.rejection_reason === null ? null : (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-muted">{CONNECTION_LABELS.rejection}</dt>
              <dd>{GRAPH_REJECTION_LABELS[graph.rejection_reason]}</dd>
            </div>
          )}
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted">カテゴリ</dt>
            <dd>{GRAPH_CATEGORY_LABELS[graph.category_updates]}</dd>
          </div>
        </dl>
      )}
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{CONNECTION_LABELS.scopes}</p>
        {entry.granted_scopes.length === 0 ? (
          <p className="text-sm text-muted">{CONNECTION_LABELS.noScopes}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {entry.granted_scopes.map((scope) => (
              <li key={scope} className="break-all text-xs text-muted">
                {scope}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium">{CONNECTION_LABELS.targets}</p>
        <IdChoices
          label={CONNECTION_LABELS.calendars}
          ids={entry.targets.calendar_ids}
          selected={draft.calendarIds}
          disabled={disabled}
          onToggle={(id, on) =>
            setDraft({
              ...draft,
              calendarIds: toggle(draft.calendarIds, id, on),
            })
          }
        />
        <IdChoices
          label={CONTAINER_LABELS[entry.provider]}
          ids={entry.targets.mail_container_ids}
          selected={draft.mailContainerIds}
          disabled={disabled}
          onToggle={(id, on) =>
            setDraft({
              ...draft,
              mailContainerIds: toggle(draft.mailContainerIds, id, on),
            })
          }
        />
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm font-medium">
            {CONNECTION_LABELS.attachmentKinds}
          </legend>
          {(['pdf', 'text'] as const).map((kind) => (
            <Checkbox
              key={kind}
              isSelected={draft.attachmentKinds.includes(kind)}
              isDisabled={disabled}
              onChange={(on) =>
                setDraft({
                  ...draft,
                  attachmentKinds: toggle(draft.attachmentKinds, kind, on),
                })
              }
            >
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <Label>{ATTACHMENT_KIND_LABELS[kind]}</Label>
              </Checkbox.Content>
            </Checkbox>
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-3">
          <NumberField
            label={CONNECTION_LABELS.mailLookback}
            value={draft.mailLookbackDays}
            invalid={
              !intIn(
                draft.mailLookbackDays,
                1,
                FETCH_SCOPE_LIMITS.mailLookbackDays,
              )
            }
            disabled={disabled}
            onChange={(value) =>
              setDraft({ ...draft, mailLookbackDays: value })
            }
          />
          <NumberField
            label={CONNECTION_LABELS.calendarPast}
            value={draft.calendarPastDays}
            invalid={
              !intIn(
                draft.calendarPastDays,
                0,
                FETCH_SCOPE_LIMITS.calendarPastDays,
              )
            }
            disabled={disabled}
            onChange={(value) =>
              setDraft({ ...draft, calendarPastDays: value })
            }
          />
          <NumberField
            label={CONNECTION_LABELS.calendarFuture}
            value={draft.calendarFutureDays}
            invalid={
              !intIn(
                draft.calendarFutureDays,
                0,
                FETCH_SCOPE_LIMITS.calendarFutureDays,
              )
            }
            disabled={disabled}
            onChange={(value) =>
              setDraft({ ...draft, calendarFutureDays: value })
            }
          />
          <NumberField
            label={CONNECTION_LABELS.attachmentMax}
            value={draft.attachmentMaxBytes}
            invalid={
              !intIn(
                draft.attachmentMaxBytes,
                1,
                FETCH_SCOPE_LIMITS.attachmentMaxBytes,
              )
            }
            disabled={disabled}
            onChange={(value) =>
              setDraft({ ...draft, attachmentMaxBytes: value })
            }
          />
        </div>
        {held ? (
          <InlineNotice
            tone="warning"
            text={`${CONNECTION_LABELS.unknown}。一覧が更新されるまで、この連携は変更できません。`}
          />
        ) : null}
        <div>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={disabled || !changed || targets === null}
            onPress={() => {
              if (targets !== null) actions.update(entry.ref, targets);
            }}
          >
            {state.busy === entry.ref
              ? CONNECTION_LABELS.busy
              : CONNECTION_LABELS.save}
          </Button>
        </div>
        {notice === null ? null : (
          <InlineNotice tone={notice.tone} text={notice.text} />
        )}
      </div>
    </div>
  );
}

export function ConnectionsPanel({
  state,
  actions,
  paused = false,
}: {
  readonly state: ConnectionsViewState;
  readonly actions: ConnectionActions;
  // 中枢との接続を待っている間（最後の表示は残さず、操作だけ止める）。
  readonly paused?: boolean;
}) {
  const view = state.view;
  const headNotice =
    state.notice !== null && state.notice.ref === null ? state.notice : null;
  const fetch = view?.fetch ?? 'unavailable';
  return (
    <Section
      id="connections-heading"
      title={CONNECTION_LABELS.section}
      action={
        <Button
          size="sm"
          variant="ghost"
          isDisabled={state.reading}
          onPress={actions.refresh}
        >
          {state.reading
            ? CONNECTION_LABELS.reading
            : CONNECTION_LABELS.refresh}
        </Button>
      }
    >
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <StatusText line={FETCH_LINES[fetch] as StatusLine} />
      </p>
      {headNotice === null ? null : (
        <InlineNotice tone={headNotice.tone} text={headNotice.text} />
      )}
      {view === null || view.fetch === 'unavailable' ? null : view.entries
          .length === 0 ? (
        <p className="text-sm text-muted">{CONNECTION_LABELS.empty}</p>
      ) : (
        <>
          <p className="max-w-prose text-xs leading-5 text-muted">
            {CONNECTION_LABELS.addNote}
          </p>
          <div className="flex flex-col gap-4">
            {view.entries.map((entry) => (
              <ConnectionCard
                key={`${entry.ref}:${JSON.stringify(entry.targets)}`}
                entry={entry}
                state={state}
                actions={actions}
                paused={paused}
              />
            ))}
          </div>
        </>
      )}
    </Section>
  );
}
