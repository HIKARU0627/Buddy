// 記録しない会話の独立した確認の欄（ADR 0197、U503。ADR 0045 の確認の画面、設計 01 承認画面）。状態の層のパネルと従来の窓の
// 「確認が必要な操作」と同じ場所に出す。何を出すかは純粋な関数（state/private-confirmation-state.ts）が決め、ここは描くだけ。
//
// - 見出し「記録しない会話の確認」と、記録しない間の印（PrivateModeMark。記号と文言）で、記録しない会話の間の確認だと分かる
//   ようにする。1 行目の文で、会話の内容は保存しないことと、承認で最小の記録だけが残ることを伝える。
// - 行は何をどう変えるか（メールのラベルの変更・対象の件名と差出人・付ける／外すラベル）だけ。確認の ID・内容の hash・
//   区切りの世代は持たない。
// - 「承認する」（primary）は本人が押すと main が OS の確認ダイアログを 1 回だけ出す。音声・島・キャンバスからは押せない。
//   対象を確かめられない行・入出力が止まっている間は承認を出さず（押せない理由を文で出す）、「断る」だけにする。
// - 結果は欄の下に 1 つだけ出す（承認・断ると行は一覧から消えるので）。確認がなく結果もなければ何も描かない。行が 0 件の
//   ときは記録しない間の印と 1 行目の文を出さない。記録しない会話の外（保存モードが private でない・不明）では何も描かない
//   （通常の会話の間に本人が保存モードを取り違えないため。U612）。
// CSP（style-src 'self'）のため style 属性は使わない。
import { Button } from '@heroui/react';
import type { DesktopPrivateConfirmationEntry } from '@buddy/contracts';
import { PRIVATE_CONFIRMATION_LABELS } from '../labels.js';
import {
  canApprove,
  canDecline,
  decisionLabel,
  privateConfirmationRows,
} from '../state/private-confirmation-state.js';
import type {
  PrivateConfirmationActions,
  PrivateConfirmationViewState,
} from '../state/private-confirmation-state.js';
import { InlineNotice } from './InlineNotice.js';
import { Section } from './Section.js';
import { PrivateModeMark } from './StorageMode.js';
import { StatusText } from './StatusText.js';

export const PRIVATE_CONFIRMATION_HEADING_ID = 'private-confirmation-heading';

export function PrivateConfirmations({
  entries,
  privateMode,
  state,
  actions,
  stopped,
}: {
  readonly entries: readonly DesktopPrivateConfirmationEntry[];
  // 状態欄の保存モードが記録しない（中枢の値）か。
  readonly privateMode: boolean;
  readonly state: PrivateConfirmationViewState;
  readonly actions: PrivateConfirmationActions;
  // この端末の入出力が止まっている（承認を出さない）。
  readonly stopped: boolean;
}) {
  const L = PRIVATE_CONFIRMATION_LABELS;
  const rows = privateConfirmationRows(entries);
  if (!privateMode) return null;
  if (rows.length === 0 && state.notice === null) return null;
  return (
    <Section
      id={PRIVATE_CONFIRMATION_HEADING_ID}
      title={L.title}
      action={rows.length === 0 ? undefined : <PrivateModeMark />}
    >
      {rows.length === 0 ? null : (
        <p className="max-w-prose text-sm leading-6 text-muted">{L.lead}</p>
      )}
      {rows.length === 0 ? null : (
        <ul
          aria-label={L.title}
          data-private-confirmations=""
          className="flex flex-col divide-y divide-separator"
        >
          {rows.map((row) => {
            const busy = state.busy.includes(row.ref);
            const approve = canApprove(row, busy, stopped);
            return (
              <li
                key={row.ref}
                data-private-confirmation={row.ref}
                className="flex flex-col gap-2 py-3"
              >
                <p className="text-sm font-semibold">{row.title}</p>
                {row.target.length === 0 ? null : (
                  <ul className="flex flex-col text-sm leading-6">
                    {row.target.map((line) => (
                      <li key={line} className="break-words">
                        {line}
                      </li>
                    ))}
                  </ul>
                )}
                <ul className="flex flex-col text-sm leading-6">
                  {row.changes.map((line) => (
                    <li key={line} className="break-words">
                      {line}
                    </li>
                  ))}
                </ul>
                {row.held ? (
                  <StatusText
                    className="text-sm"
                    line={{ tone: 'warning', mark: 'warning', text: L.held }}
                  />
                ) : !row.approvable ? (
                  <StatusText
                    className="text-sm"
                    line={{
                      tone: 'warning',
                      mark: 'warning',
                      text: L.unidentified,
                    }}
                  />
                ) : stopped ? (
                  <StatusText
                    className="text-sm"
                    line={{ tone: 'warning', mark: 'warning', text: L.stopped }}
                  />
                ) : null}
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    isDisabled={!canDecline(row, busy)}
                    aria-label={decisionLabel(L.decline, row)}
                    data-private-decision="decline"
                    onPress={() => actions.decide(row.ref, 'decline')}
                  >
                    {L.decline}
                  </Button>
                  {row.approvable ? (
                    <Button
                      variant="primary"
                      size="sm"
                      isDisabled={!approve}
                      aria-label={decisionLabel(L.approve, row)}
                      data-private-decision="approve"
                      onPress={() => actions.decide(row.ref, 'approve')}
                    >
                      {busy ? L.sending : L.approve}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {state.notice === null ? null : (
        <InlineNotice tone={state.notice.tone} text={state.notice.text} />
      )}
    </Section>
  );
}
