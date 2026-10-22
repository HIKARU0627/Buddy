// 会話・変更の確認・処理状況の画面（B04-05、設計 01 承認画面の必須内容・いつも見える状態、08 §3、ADR 0024・0031）。
// 骨格は Section（見出しと区切り線）。上から「会話」→「変更の確認」（確認を開いている間だけ）→「確認が必要な操作」→
// 「処理中」→「終わった操作」。承認は「承認する」を押すと main が OS の確認ダイアログを 1 回だけ出す
// （本人の判断 2026-10-22 D2）。結果が分からない操作には「照合」を出し、再送のボタンは出さない（自動でも送り直さない）。
// 1 画面に primary は 1 つ: 確認を開いている間は「承認する」、それ以外は「送る」。
// 状態と操作は引数で受け取り、限定 API を直接呼ばない。画面に来るのは main の参照と表示用の値だけ。
import {
  Button,
  Description,
  FieldError,
  Label,
  TextArea,
  TextField,
} from '@heroui/react';
import type { DesktopOperationEntry } from '@buddy/contracts';
import { InlineNotice } from '../../components/InlineNotice.js';
import { Section } from '../../components/Section.js';
import { StatusText } from '../../components/StatusText.js';
import {
  OPERATION_KIND_LABELS,
  SERVICE_LABELS,
  TARGET_LABELS,
  changeRows,
  entryActions,
  groupOperations,
  impactLines,
  operationNote,
  operationStatus,
} from '../../state/work-state.js';
import type {
  Notice,
  WorkActions,
  WorkViewState,
} from '../../state/work-state.js';

export const WORK_LABELS = {
  conversation: '会話',
  inputLabel: '話しかける',
  inputHint:
    '例: 「今日の予定を見せて」「「牛乳を買う」を用事に登録して」。Ctrl か ⌘ を押しながら Enter でも送れます。',
  send: '送る',
  sending: '送っています…',
  empty: 'まだ会話はありません。',
  you: 'あなた',
  buddy: 'Buddy',
  clarification: '聞き返し',
  preview: '変更の確認',
  previewIntro:
    '次の変更を承認するか決めてください。承認するまで、何も実行しません。',
  previewLoading: '内容を確かめています…',
  kind: '操作の種類',
  account: 'アカウント',
  target: '対象',
  changes: '変更の前後',
  impact: '影響',
  approve: '承認する',
  approveNote:
    '「承認する」を押すと、確認のダイアログが開きます。そこで「承認する」を選ぶと、中枢へ送ります。',
  approving: '確認のダイアログで、承認するか選んでください…',
  close: '閉じる',
  attention: '確認が必要な操作',
  running: '処理中の操作',
  finished: '終わった操作',
  noAttention: '確認が必要な操作はありません。',
  noOperations: '操作はまだありません。',
  openPreview: '内容を確認',
  cancel: '取り消す',
  reconcile: '照合',
  retry: '再試行',
  busy: '送っています…',
  headColumn: '項目',
  beforeColumn: '変更前',
  afterColumn: '変更後',
  stopped:
    '入出力が止まっているため、発言と承認はできません。上の「再開」を押すと、また使えます。',
  disconnected:
    '中枢に接続していないため、発言と承認はできません。接続が戻ると、また使えます。',
} as const;

export function hiddenFinishedNote(count: number): string {
  return `ほか${count}\u00a0件の終わった操作は、ここには出していません。`;
}

function Conversation({
  state,
  actions,
  canSend,
  blocked,
  previewOpen,
}: {
  readonly state: WorkViewState;
  readonly actions: WorkActions;
  readonly canSend: boolean;
  readonly blocked: string | null;
  readonly previewOpen: boolean;
}) {
  return (
    <Section id="conversation-heading" title={WORK_LABELS.conversation}>
      {state.messages.length === 0 ? (
        <p className="text-sm text-muted">{WORK_LABELS.empty}</p>
      ) : (
        <ol
          aria-label="会話の履歴"
          className="flex flex-col gap-4 text-sm leading-6"
        >
          {state.messages.map((message) => (
            <li key={message.id} className="flex flex-col gap-0.5">
              <span className="text-xs text-muted">
                {message.role === 'user'
                  ? WORK_LABELS.you
                  : message.clarification
                    ? `${WORK_LABELS.buddy}（${WORK_LABELS.clarification}）`
                    : WORK_LABELS.buddy}
              </span>
              <span className="max-w-prose whitespace-pre-wrap break-words">
                {message.text}
              </span>
            </li>
          ))}
        </ol>
      )}
      {blocked !== null ? (
        <p role="status" className="max-w-prose text-sm leading-6 text-muted">
          {blocked}
        </p>
      ) : canSend ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            actions.submit();
          }}
        >
          <TextField
            value={state.draft}
            onChange={actions.setDraft}
            isInvalid={state.turnNotice !== null}
            isDisabled={state.sending}
          >
            <Label>{WORK_LABELS.inputLabel}</Label>
            <TextArea
              variant="secondary"
              rows={2}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  (event.ctrlKey || event.metaKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  actions.submit();
                }
              }}
            />
            <Description>{WORK_LABELS.inputHint}</Description>
            <FieldError>{state.turnNotice?.text}</FieldError>
          </TextField>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              variant={previewOpen ? 'secondary' : 'primary'}
              isDisabled={state.sending}
            >
              {state.sending ? WORK_LABELS.sending : WORK_LABELS.send}
            </Button>
          </div>
          {/* 失敗は入力欄の下の FieldError に出す（欄が無効のときだけここに出す）。 */}
          {state.sending ? (
            <p role="status" className="text-xs text-muted">
              {WORK_LABELS.sending}
            </p>
          ) : null}
        </form>
      ) : null}
    </Section>
  );
}

function Preview({
  state,
  actions,
  entry,
}: {
  readonly state: WorkViewState;
  readonly actions: WorkActions;
  readonly entry: DesktopOperationEntry | undefined;
}) {
  const open = state.preview;
  if (open === null || entry === undefined) return null;
  const preview = open.preview;
  const notice = state.notices[open.ref];
  return (
    <Section id="preview-heading" title={WORK_LABELS.preview}>
      {preview === null ? (
        <p role="status" className="text-sm text-muted">
          {WORK_LABELS.previewLoading}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="max-w-prose text-sm leading-6">
            {WORK_LABELS.previewIntro}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm leading-6">
            <dt className="text-muted">{WORK_LABELS.kind}</dt>
            <dd className="min-w-0 break-words font-semibold">
              {OPERATION_KIND_LABELS[preview.operation_kind] ??
                preview.operation_kind}
            </dd>
            <dt className="text-muted">{WORK_LABELS.account}</dt>
            <dd className="min-w-0 break-words">
              {SERVICE_LABELS[preview.service] ?? preview.service}
            </dd>
            {preview.target === null ? null : (
              <>
                <dt className="text-muted">{WORK_LABELS.target}</dt>
                <dd className="min-w-0 break-words">
                  <span className="text-muted">
                    {TARGET_LABELS[preview.operation_kind] ?? ''}{' '}
                  </span>
                  <span className="font-mono">{preview.target}</span>
                </dd>
              </>
            )}
          </dl>
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">{WORK_LABELS.changes}</h3>
            <table className="w-full table-fixed border-collapse text-left text-sm leading-6">
              <caption className="sr-only">{WORK_LABELS.changes}</caption>
              <thead>
                <tr className="border-b border-separator text-xs text-muted">
                  <th scope="col" className="w-1/5 py-1 pr-2 font-normal">
                    {WORK_LABELS.headColumn}
                  </th>
                  <th scope="col" className="w-2/5 py-1 pr-2 font-normal">
                    {WORK_LABELS.beforeColumn}
                  </th>
                  <th scope="col" className="w-2/5 py-1 font-normal">
                    {WORK_LABELS.afterColumn}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-separator">
                {changeRows(preview).map((row) => (
                  <tr key={row.field} className="align-top">
                    <th
                      scope="row"
                      className="py-1.5 pr-2 font-normal text-muted"
                    >
                      {row.name}
                    </th>
                    <td className="break-words py-1.5 pr-2 text-muted">
                      {row.before}
                    </td>
                    <td
                      className={`break-words py-1.5 font-semibold ${row.long ? 'whitespace-pre-wrap' : ''}`}
                    >
                      {row.after}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">{WORK_LABELS.impact}</h3>
            <ul className="flex max-w-prose list-disc flex-col gap-1 pl-5 text-sm leading-6">
              {impactLines(preview.operation_kind).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onPress={actions.approve}
                isDisabled={open.approving}
              >
                {WORK_LABELS.approve}
              </Button>
              {open.approving ? null : (
                <Button variant="ghost" onPress={actions.closePreview}>
                  {WORK_LABELS.close}
                </Button>
              )}
            </div>
            {open.approving ? (
              <p role="status" className="text-xs text-muted">
                {WORK_LABELS.approving}
              </p>
            ) : (
              <p className="max-w-prose text-xs leading-5 text-muted">
                {WORK_LABELS.approveNote}
              </p>
            )}
          </div>
        </div>
      )}
      {notice === undefined ? null : (
        <InlineNotice tone={notice.tone} text={notice.text} />
      )}
    </Section>
  );
}

function OperationRow({
  entry,
  state,
  actions,
  stopped,
}: {
  readonly entry: DesktopOperationEntry;
  readonly state: WorkViewState;
  readonly actions: WorkActions;
  // この端末の入出力が止まっている（承認の準備を出さない。取消と照合は止まっていても使える）。
  readonly stopped: boolean;
}) {
  const available = entryActions(entry);
  const note = operationNote(entry);
  // 確認を開いている操作の文言は、確認の欄に出す（行と二重に出さない）。
  const notice: Notice | undefined =
    state.preview?.ref === entry.ref ? undefined : state.notices[entry.ref];
  const busy = state.busy.includes(entry.ref);
  const showPreview =
    !stopped && available.preview && state.preview?.ref !== entry.ref;
  const showCancel = available.cancel;
  const showReconcile = available.reconcile;
  // 再試行は、実行されなかったと確定した操作だけ（停止中は出さない）。
  const showRetry = !stopped && available.retry;
  return (
    <li className="flex flex-col gap-1.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-semibold">
            {OPERATION_KIND_LABELS[entry.operation_kind] ??
              entry.operation_kind}
          </span>
          <StatusText className="text-sm" line={operationStatus(entry)} />
        </div>
        {showPreview || showCancel || showReconcile || showRetry ? (
          <div className="flex flex-wrap items-center gap-2">
            {showPreview ? (
              <Button
                variant="secondary"
                size="sm"
                onPress={() => actions.preview(entry.ref)}
              >
                {WORK_LABELS.openPreview}
              </Button>
            ) : null}
            {showReconcile ? (
              <Button
                variant="secondary"
                size="sm"
                isDisabled={busy}
                onPress={() => actions.reconcile(entry.ref)}
              >
                {busy ? WORK_LABELS.busy : WORK_LABELS.reconcile}
              </Button>
            ) : null}
            {showRetry ? (
              <Button
                variant="secondary"
                size="sm"
                isDisabled={busy}
                onPress={() => actions.retry(entry.ref)}
              >
                {busy ? WORK_LABELS.busy : WORK_LABELS.retry}
              </Button>
            ) : null}
            {showCancel ? (
              <Button
                variant="secondary"
                size="sm"
                isDisabled={busy}
                onPress={() => actions.cancel(entry.ref)}
              >
                {WORK_LABELS.cancel}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {note === null ? null : (
        <p className="max-w-prose text-xs leading-5 text-muted">{note}</p>
      )}
      {notice === undefined ? null : (
        <InlineNotice tone={notice.tone} text={notice.text} />
      )}
    </li>
  );
}

function OperationList({
  label,
  entries,
  state,
  actions,
  stopped,
}: {
  readonly label: string;
  readonly entries: readonly DesktopOperationEntry[];
  readonly state: WorkViewState;
  readonly actions: WorkActions;
  readonly stopped: boolean;
}) {
  return (
    <ul aria-label={label} className="flex flex-col divide-y divide-separator">
      {entries.map((entry) => (
        <OperationRow
          key={entry.ref}
          entry={entry}
          state={state}
          actions={actions}
          stopped={stopped}
        />
      ))}
    </ul>
  );
}

export function WorkPanel({
  state,
  actions,
  operations,
  link,
  stopped,
}: {
  readonly state: WorkViewState;
  readonly actions: WorkActions;
  readonly operations: readonly DesktopOperationEntry[];
  // 中枢との接続。connected 以外は発言・承認・取消・照合を出さない。
  readonly link: 'connected' | 'other';
  // この端末の入出力が止まっている（発言と承認だけを止める）。
  readonly stopped: boolean;
}) {
  const connected = link === 'connected';
  const blocked = !connected
    ? WORK_LABELS.disconnected
    : stopped
      ? WORK_LABELS.stopped
      : null;
  const previewEntry = operations.find(
    (entry) => entry.ref === state.preview?.ref,
  );
  const previewOpen = state.preview !== null && previewEntry !== undefined;
  return (
    <>
      <Conversation
        state={state}
        actions={actions}
        canSend={connected && !stopped}
        blocked={blocked}
        previewOpen={previewOpen}
      />
      {connected ? (
        <OperationSections
          state={state}
          actions={actions}
          operations={operations}
          stopped={stopped}
          previewEntry={previewEntry}
        />
      ) : null}
    </>
  );
}

function OperationSections({
  state,
  actions,
  operations,
  stopped,
  previewEntry,
}: {
  readonly state: WorkViewState;
  readonly actions: WorkActions;
  readonly operations: readonly DesktopOperationEntry[];
  readonly stopped: boolean;
  readonly previewEntry: DesktopOperationEntry | undefined;
}) {
  const groups = groupOperations(operations);
  return (
    <>
      <Preview state={state} actions={actions} entry={previewEntry} />
      <Section id="attention-heading" title={WORK_LABELS.attention}>
        {groups.attention.length === 0 ? (
          <p className="text-sm text-muted">
            {operations.length === 0
              ? WORK_LABELS.noOperations
              : WORK_LABELS.noAttention}
          </p>
        ) : (
          <OperationList
            label={WORK_LABELS.attention}
            entries={groups.attention}
            state={state}
            actions={actions}
            stopped={stopped}
          />
        )}
      </Section>
      {groups.running.length === 0 ? null : (
        <Section id="running-heading" title={WORK_LABELS.running}>
          <OperationList
            label={WORK_LABELS.running}
            entries={groups.running}
            state={state}
            actions={actions}
            stopped={stopped}
          />
        </Section>
      )}
      {groups.finished.length === 0 ? null : (
        <Section id="finished-heading" title={WORK_LABELS.finished}>
          <OperationList
            label={WORK_LABELS.finished}
            entries={groups.finished}
            state={state}
            actions={actions}
            stopped={stopped}
          />
          {groups.hiddenFinished === 0 ? null : (
            <p className="text-xs text-muted">
              {hiddenFinishedNote(groups.hiddenFinished)}
            </p>
          )}
        </Section>
      )}
    </>
  );
}
