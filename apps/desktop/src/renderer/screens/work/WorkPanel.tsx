// 会話・変更の確認・処理状況の画面（B04-05、設計 01 承認画面の必須内容・いつも見える状態、08 §3、ADR 0024・0031）。
// 骨格は Section（見出しと区切り線）。上から「会話」→「変更の確認」（確認を開いている間だけ）→「確認が必要な操作」→
// 「処理中」→「終わった操作」。承認・取消・再試行は、ボタンを押すと main が OS の確認ダイアログを 1 回だけ出す
// （本人の判断 2026-10-22 D2 と、取消・再試行への適用）。結果が分からない操作には「照合」か「状態を確かめる」だけを出し、
// 再送のボタンは出さない（自動でも送り直さない）。
// 1 画面に primary は 1 つ: 確認を開いている間は「承認する」、それ以外は「送る」。
// 行の見出しは操作の内容（用事の題名・メールの件名）で、操作の種類は補足。ボタンの読み上げの名前に対象を含める。
// 確認を開いたら見出しへフォーカスを移し、閉じたら元の行のボタン（なければ「確認が必要な操作」の見出し）へ戻す。
// 状態と操作は引数で受け取り、限定 API を直接呼ばない。画面に来るのは main の参照と表示用の値だけ。
import { useEffect, useRef } from 'react';
import {
  Button,
  Description,
  FieldError,
  Label,
  TextArea,
  TextField,
} from '@heroui/react';
import type {
  DesktopOperationEntry,
  DesktopOperationPreview,
} from '@buddy/contracts';
import { InlineNotice } from '../../components/InlineNotice.js';
import { Section } from '../../components/Section.js';
import { StatusText } from '../../components/StatusText.js';
import {
  OPERATION_KIND_LABELS,
  SERVICE_LABELS,
  changeRows,
  entryActions,
  groupOperations,
  impactLines,
  operationNote,
  operationStatus,
  rowSubtitle,
  rowTitle,
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
  draftAccount: '下書きの保存先',
  target: '対象のメール',
  draftTarget: '返信元のメール',
  targetList: '登録先の一覧',
  subject: '件名',
  sender: '差出人',
  receivedAt: '受信日時',
  changes: '変更の前後',
  creates: '新しく作成する内容',
  body: '本文',
  impact: '影響',
  approve: '承認する',
  approveNote:
    '「承認する」を押すと、確認のダイアログが開きます。そこで「承認する」を選ぶと、中枢へ送ります。',
  approving: '確認のダイアログで、承認するか選んでください…',
  notApprovable:
    '口座か対象のメールを確認できないため、承認できません。接続を確かめて、少し待ってから、もう一度「内容を確認」を押してください。',
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
  check: '状態を確かめる',
  busy: '送っています…',
  headColumn: '項目',
  contentColumn: '内容',
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

// ボタンの読み上げの名前（見える文字に対象を足す。「内容を確認（牛乳を買う）」）。
export function actionLabel(verb: string, entry: DesktopOperationEntry) {
  return `${verb}（${rowTitle(entry)}）`;
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
  const latest = [...state.messages]
    .reverse()
    .find((message) => message.role === 'buddy');
  const notice = state.turnNotice;
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
      {/* 新しい回答・聞き返しを、最新の追加分だけ控えめに読み上げる（履歴全体は読み上げない）。 */}
      <p role="status" aria-live="polite" className="sr-only">
        {latest === undefined ? '' : latest.text}
      </p>
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
            isInvalid={notice?.field === true}
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
            {/* 入力の問題（空・長すぎ）だけ欄の下に出す。通信の失敗は入力の誤りではないので、別の通知にする。 */}
            <FieldError>
              {notice?.field === true ? notice.text : null}
            </FieldError>
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
          {notice !== null && notice.field !== true ? (
            <InlineNotice tone={notice.tone} text={notice.text} />
          ) : null}
          {state.sending ? (
            <p role="status" className="text-sm text-muted">
              {WORK_LABELS.sending}
            </p>
          ) : null}
        </form>
      ) : null}
    </Section>
  );
}

const CREATE_KINDS: ReadonlySet<string> = new Set([
  'mail.draft.create',
  'task.create',
]);

function TargetRows({
  preview,
}: {
  readonly preview: DesktopOperationPreview;
}) {
  const draft = preview.operation_kind === 'mail.draft.create';
  const mail = preview.target_detail;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm leading-6">
      <dt className="text-muted">{WORK_LABELS.kind}</dt>
      <dd className="min-w-0 break-words font-semibold">
        {OPERATION_KIND_LABELS[preview.operation_kind] ??
          preview.operation_kind}
      </dd>
      <dt className="text-muted">
        {draft ? WORK_LABELS.draftAccount : WORK_LABELS.account}
      </dt>
      <dd className="min-w-0 break-words">
        {preview.account_label === null
          ? (SERVICE_LABELS[preview.service] ?? preview.service)
          : `${preview.account_label}（${SERVICE_LABELS[preview.service] ?? preview.service}）`}
      </dd>
      {mail === null ? (
        preview.target === null ? null : (
          <>
            <dt className="text-muted">
              {preview.operation_kind === 'task.create'
                ? WORK_LABELS.targetList
                : WORK_LABELS.target}
            </dt>
            <dd className="min-w-0 break-words font-mono">{preview.target}</dd>
          </>
        )
      ) : (
        <>
          <dt className="text-muted">
            {draft ? WORK_LABELS.draftTarget : WORK_LABELS.target}
          </dt>
          <dd className="min-w-0 break-words">
            <span className="font-semibold">
              {mail.subject ?? '（件名を読めていません）'}
            </span>
          </dd>
          <dt className="text-muted">{WORK_LABELS.sender}</dt>
          <dd className="min-w-0 break-words">
            {mail.sender ?? '（読めていません）'}
          </dd>
          <dt className="text-muted">{WORK_LABELS.receivedAt}</dt>
          <dd className="min-w-0 break-words tabular-nums">
            {mail.received_at ?? '（読めていません）'}
          </dd>
        </>
      )}
    </dl>
  );
}

function ChangeTable({
  preview,
}: {
  readonly preview: DesktopOperationPreview;
}) {
  const create = CREATE_KINDS.has(preview.operation_kind);
  const rows = changeRows(preview);
  const short = rows.filter((row) => !row.long);
  const long = rows.filter((row) => row.long);
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">
        {create ? WORK_LABELS.creates : WORK_LABELS.changes}
      </h3>
      {short.length === 0 ? null : (
        <table className="w-full table-fixed border-collapse text-left text-sm leading-6">
          <caption className="sr-only">
            {create ? WORK_LABELS.creates : WORK_LABELS.changes}
          </caption>
          <thead>
            <tr className="border-b border-separator text-xs text-muted">
              <th scope="col" className="w-1/4 py-1 pr-2 font-normal">
                {WORK_LABELS.headColumn}
              </th>
              {create ? (
                <th scope="col" className="py-1 font-normal">
                  {WORK_LABELS.contentColumn}
                </th>
              ) : (
                <>
                  <th scope="col" className="w-[37%] py-1 pr-2 font-normal">
                    {WORK_LABELS.beforeColumn}
                  </th>
                  <th scope="col" className="py-1 font-normal">
                    {WORK_LABELS.afterColumn}
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-separator">
            {short.map((row) => (
              <tr key={row.field} className="align-top">
                <th scope="row" className="py-1.5 pr-2 font-normal text-muted">
                  {row.name}
                </th>
                {create ? null : (
                  <td className="break-words py-1.5 pr-2 text-muted">
                    {row.before}
                  </td>
                )}
                <td
                  className={`break-words py-1.5 ${create ? '' : 'font-semibold'}`}
                >
                  {row.after}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* 本文は全幅の独立した欄に、通常の太さで出す（表の右の細い列に押し込まない）。 */}
      {long.map((row) => (
        <div key={row.field} className="flex flex-col gap-1">
          <h4 className="text-sm text-muted">{row.name}</h4>
          <p className="max-w-prose whitespace-pre-wrap break-words rounded-lg border border-separator px-3 py-2 text-sm leading-6">
            {row.after}
          </p>
        </div>
      ))}
    </div>
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
    <Section id="preview-heading" title={WORK_LABELS.preview} focusable>
      {preview === null ? (
        <p role="status" className="text-sm text-muted">
          {WORK_LABELS.previewLoading}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="max-w-prose text-sm leading-6">
            {WORK_LABELS.previewIntro}
          </p>
          <TargetRows preview={preview} />
          <ChangeTable preview={preview} />
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">{WORK_LABELS.impact}</h3>
            <ul className="flex max-w-prose list-disc flex-col gap-1 pl-5 text-sm leading-6">
              {impactLines(preview.operation_kind).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-2">
            {preview.approvable ? null : (
              <InlineNotice tone="warning" text={WORK_LABELS.notApprovable} />
            )}
            <div className="flex flex-wrap items-center gap-2">
              {preview.approvable ? (
                <Button
                  variant="primary"
                  onPress={actions.approve}
                  isDisabled={open.approving}
                >
                  {WORK_LABELS.approve}
                </Button>
              ) : null}
              {open.approving ? null : (
                <Button
                  variant={preview.approvable ? 'ghost' : 'secondary'}
                  onPress={actions.closePreview}
                >
                  {WORK_LABELS.close}
                </Button>
              )}
            </div>
            {!preview.approvable ? null : open.approving ? (
              <p role="status" className="text-sm text-muted">
                {WORK_LABELS.approving}
              </p>
            ) : (
              <p className="max-w-prose text-sm leading-6 text-muted">
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
  // この端末の入出力が止まっている（承認の準備・再試行を出さない。取消と照合は止まっていても使える）。
  readonly stopped: boolean;
}) {
  const available = entryActions(entry);
  const note = operationNote(entry);
  const subtitle = rowSubtitle(entry);
  // 確認を開いている操作の文言は、確認の欄に出す（行と二重に出さない）。
  const notice: Notice | undefined =
    state.preview?.ref === entry.ref ? undefined : state.notices[entry.ref];
  const busy = state.busy.includes(entry.ref);
  const showPreview =
    !stopped && available.preview && state.preview?.ref !== entry.ref;
  const showCancel = available.cancel;
  const showReconcile = available.reconcile;
  const showRetry = !stopped && available.retry;
  const showCheck = available.check;
  return (
    <li className="flex flex-col gap-1.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="break-words text-sm font-semibold">
            {rowTitle(entry)}
          </span>
          {subtitle === null ? null : (
            <span className="break-words text-xs text-muted">{subtitle}</span>
          )}
          <StatusText className="text-sm" line={operationStatus(entry)} />
        </div>
        {showPreview ||
        showCancel ||
        showReconcile ||
        showRetry ||
        showCheck ? (
          <div className="flex flex-wrap items-center gap-2">
            {showPreview ? (
              <Button
                id={`preview-button-${entry.ref}`}
                variant="secondary"
                size="sm"
                aria-label={actionLabel(WORK_LABELS.openPreview, entry)}
                onPress={() => actions.preview(entry.ref)}
              >
                {WORK_LABELS.openPreview}
              </Button>
            ) : null}
            {showCheck ? (
              <Button
                variant="secondary"
                size="sm"
                isDisabled={busy}
                aria-label={actionLabel(WORK_LABELS.check, entry)}
                onPress={() => actions.check(entry.ref)}
              >
                {busy ? WORK_LABELS.busy : WORK_LABELS.check}
              </Button>
            ) : null}
            {showReconcile ? (
              <Button
                variant="secondary"
                size="sm"
                isDisabled={busy}
                aria-label={actionLabel(WORK_LABELS.reconcile, entry)}
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
                aria-label={actionLabel(WORK_LABELS.retry, entry)}
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
                aria-label={actionLabel(WORK_LABELS.cancel, entry)}
                onPress={() => actions.cancel(entry.ref)}
              >
                {WORK_LABELS.cancel}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {note === null ? null : (
        <p className="max-w-prose text-sm leading-6 text-muted">{note}</p>
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
      <Section id="attention-heading" title={WORK_LABELS.attention} focusable>
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

// 確認を開いたら見出しへ、閉じたら元の行のボタン（なければ「確認が必要な操作」の見出し）へフォーカスを移す。
function useFocusRestore(openRef: string | null, loaded: boolean) {
  const lastRef = useRef<string | null>(null);
  const focusedRef = useRef<string | null>(null);
  useEffect(() => {
    if (openRef !== null && loaded && focusedRef.current !== openRef) {
      focusedRef.current = openRef;
      lastRef.current = openRef;
      document.getElementById('preview-heading')?.focus();
      return;
    }
    if (openRef === null && lastRef.current !== null) {
      const previous = lastRef.current;
      lastRef.current = null;
      focusedRef.current = null;
      (
        document.getElementById(`preview-button-${previous}`) ??
        document.getElementById('attention-heading')
      )?.focus();
    }
  }, [openRef, loaded]);
}

// 確認を開いている操作（一覧にあれば）と、確認を開いた・閉じたときのフォーカスの移動。WorkPanel と状態の層のパネルが
// 呼び、結果を WorkOperations に渡す（フォーカスの移動は呼び出し側の画面が持つ。UI-04 のレビュー）。
export function usePreviewFocus(
  state: WorkViewState,
  operations: readonly DesktopOperationEntry[],
): DesktopOperationEntry | undefined {
  const previewEntry = operations.find(
    (entry) => entry.ref === state.preview?.ref,
  );
  const previewOpen = state.preview !== null && previewEntry !== undefined;
  useFocusRestore(
    previewOpen ? (state.preview?.ref ?? null) : null,
    state.preview !== null && state.preview.preview !== null,
  );
  return previewEntry;
}

// 確認が必要な操作の一覧と、確認の欄（変更の確認）。従来の窓の WorkPanel と、3 つの窓の組み立ての状態の層のパネル
// （UI-04、ADR 0032）が同じ部品を使う（承認・取消・再試行・照合は、どちらも main の OS の確認ダイアログで 1 回）。
// 中枢に接続している間だけ描く（呼び出し側が決める）。
export function WorkOperations({
  state,
  actions,
  operations,
  stopped,
  previewEntry,
}: {
  readonly state: WorkViewState;
  readonly actions: WorkActions;
  readonly operations: readonly DesktopOperationEntry[];
  // この端末の入出力が止まっている（承認の準備・再試行を出さない。取消と照合は止まっていても使える）。
  readonly stopped: boolean;
  // 確認を開いている操作（usePreviewFocus の戻り値）。
  readonly previewEntry: DesktopOperationEntry | undefined;
}) {
  return (
    <OperationSections
      state={state}
      actions={actions}
      operations={operations}
      stopped={stopped}
      previewEntry={previewEntry}
    />
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
  const previewEntry = usePreviewFocus(state, operations);
  const previewOpen = state.preview !== null && previewEntry !== undefined;
  return (
    <>
      <Conversation
        state={state}
        actions={actions}
        canSend={connected && !stopped}
        blocked={blocked}
        previewOpen={previewOpen && state.preview?.preview?.approvable === true}
      />
      {connected ? (
        <WorkOperations
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
