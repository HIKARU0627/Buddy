// 3 つの窓の画面の切り替え（UI-02 の試作・UI-04、ADR 0032）。preload が渡した窓の役割で、キャンバス・状態の層・入力バーの
// どれを描くかを決める。役割で使えるチャネルは main が決め、画面は役割の表にある要求だけを送る。
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DesktopBudgetEntry,
  DesktopOperationEntry,
} from '@buddy/contracts';
import type { BuddyDesktopApi } from '../../desktop-api.js';
import { request } from '../../desktop-api.js';
import { shownConnection } from '../../state/connection-state.js';
import { messageFor } from '../../state/desktop-state.js';
import {
  operationsShown,
  panelShownFor,
  privacyMarks,
  statusItems,
  stopShortcutKeys,
  stopShortcutMark,
} from '../../state/status-panel-state.js';
import { useNow } from '../../state/use-desktop-state.js';
import {
  useCanvasViewport,
  useRoleWindowState,
  useWindowFocused,
  useWindowWidth,
} from '../../state/use-role-window-state.js';
import { useBudgetState } from '../../state/use-budget-state.js';
import { useWorkState } from '../../state/use-work-state.js';
import { BudgetItems } from '../budget/BudgetItems.js';
import { WorkOperations, usePreviewFocus } from '../work/WorkPanel.js';
import {
  canSummonCanvas,
  canvasContentShown,
  contentShown,
  inputBarEnabled,
  inputDraftAfter,
  statusTabView,
} from '../../state/window-role-state.js';
import type { RendererWindowRole } from '../../state/window-role-state.js';
import { canSubmit, submitResult } from '../../state/input-bar-state.js';
import { CanvasBoard } from './CanvasBoard.js';
import { CanvasGround } from './CanvasGround.js';
import { InputBar } from './InputBar.js';
import { StatusPanel } from './StatusPanel.js';
import { StatusTab } from './StatusTab.js';

function CanvasWindow({ api }: { readonly api: BuddyDesktopApi }) {
  const { state, canvasUserOp } = useRoleWindowState(api, 'canvas');
  const focused = useWindowFocused();
  const viewport = useCanvasViewport();
  const shown = canvasContentShown(state.status);
  // ロック中・停止中は CanvasGround が中身を描かない（配置・選択・ドラッグも捨てる）。操作は前に出ている間だけ。
  // 作業領域の外の幅は main が送る値（desktop.canvas_work_area）を使い、受け取る前は window.screen から求める。
  return (
    <CanvasGround front={focused} shown={shown}>
      <CanvasBoard
        view={state.canvas}
        front={focused && shown}
        viewport={viewport.size}
        insets={state.canvasInsets ?? viewport.insets}
        onUserOp={canvasUserOp}
      />
    </CanvasGround>
  );
}

// 操作がないときの空の配列（描画のたびに新しい配列を作らない）。
const NO_OPERATIONS: readonly DesktopOperationEntry[] = [];
const NO_BUDGET_ITEMS: readonly DesktopBudgetEntry[] = [];

// 状態の層（UI-04）。窓の幅が main の決めたパネルの幅ならパネル、つまみの幅ならつまみだけを描く。
function StatusWindow({ api }: { readonly api: BuddyDesktopApi }) {
  const { state, summonCanvas, setPanel, stop, resume } = useRoleWindowState(
    api,
    'status',
  );
  const now = useNow();
  const width = useWindowWidth();
  const panelOpen = panelShownFor(width);
  const connection = shownConnection(state.connection);
  // 確認が必要な操作の一覧（WorkPanel と同じ持ち方。ロック・切断で内容を捨てる。ADR 0031）。
  const live = operationsShown(state.status, connection);
  const operations = connection?.operations ?? NO_OPERATIONS;
  const work = useWorkState(api, live, operations);
  // 予算の確認（超過枠の承認・M 超過の確認・不明な費用の手での精算。B07-05）。操作の一覧と同じく、ロック・切断で捨てる。
  const budgetItems = connection?.budget_items ?? NO_BUDGET_ITEMS;
  const budget = useBudgetState(api, live, budgetItems);
  const previewEntry = usePreviewFocus(work.state, operations);
  const view = statusTabView(state.status, state.connection);
  const stopped =
    state.status?.visibility === 'shown' && state.status.stop_scope !== 'none';
  // パネルの中の Esc: 確認の欄を開いていれば閉じ、それ以外はパネルをしまう（IME の変換中・ほかの部品が受けた Esc は除く）。
  const previewOpen = work.state.preview !== null;
  const approving = work.state.preview?.approving === true;
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented)
        return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return;
      event.preventDefault();
      if (previewOpen) {
        if (!approving) work.actions.closePreview();
        return;
      }
      setPanel(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [panelOpen, previewOpen, approving, work.actions, setPanel]);
  // パネルをしまったら確認の欄も閉じる（次に出したときは一覧から始める。main は確認のダイアログを閉じている）。
  useEffect(() => {
    if (!panelOpen && previewOpen && !approving) work.actions.closePreview();
  }, [panelOpen, previewOpen, approving, work.actions]);
  const tab = (
    <StatusTab
      view={view}
      privacy={privacyMarks(state.status)}
      panelOpen={panelOpen}
      onTogglePanel={() => setPanel(!panelOpen)}
      canSummon={canSummonCanvas(state.status)}
      onSummon={summonCanvas}
      className={panelOpen ? 'h-[232px] w-14' : 'h-screen w-screen'}
    />
  );
  if (!panelOpen) return tab;
  return (
    <StatusPanel
      tab={tab}
      status={state.status}
      ioLine={view.line}
      items={statusItems(state.status, state.connection, now)}
      message={messageFor(state, ['desktop.io_stop', 'desktop.io_resume'])}
      onStop={stop}
      onResume={resume}
      stopShortcut={stopShortcutMark(api.stopShortcut)}
      stopKeys={stopShortcutKeys(navigator.userAgent)}
      operations={
        live ? (
          <>
            <BudgetItems
              items={budgetItems}
              state={budget.state}
              actions={budget.actions}
              stopped={stopped}
              now={now}
            />
            <WorkOperations
              state={work.state}
              actions={work.actions}
              operations={operations}
              stopped={stopped}
              previewEntry={previewEntry}
            />
          </>
        ) : null
      }
    />
  );
}

function InputWindow({ api }: { readonly api: BuddyDesktopApi }) {
  const { state, summonCanvas } = useRoleWindowState(api, 'input');
  const [draft, setDraft] = useState('');
  // 送っている間（重ねて送らない）と、入力欄の枠で知らせる要注意（聞き返し・拒否・失敗。文字は残す）。
  const [sending, setSending] = useState(false);
  const [attention, setAttention] = useState(false);
  // 送った文字が今の下書きと同じときだけ空にする（送っている間に打ち足した文字を消さない）。
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // ロック中・不明になったら下書きを捨てる（描画は inputDraftAfter で先に隠す）。
  useEffect(() => {
    setDraft((prev) => inputDraftAfter(prev, state.status));
    if (!contentShown(state.status)) setAttention(false);
  }, [state.status]);
  const enabled = inputBarEnabled(state.status);
  const value = inputDraftAfter(draft, state.status);
  const submit = useCallback(() => {
    const text = draftRef.current;
    if (!canSubmit(text, enabled, sending)) return;
    setSending(true);
    setAttention(false);
    api
      .invoke(request('desktop.turn_submit', { text }))
      .then((response) => {
        if (submitResult(response) === 'sent')
          setDraft((current) => (current === text ? '' : current));
        else setAttention(true);
      })
      .catch(() => setAttention(true))
      .finally(() => setSending(false));
  }, [api, enabled, sending]);
  const view = statusTabView(state.status, null);
  return (
    <InputBar
      line={view.line}
      enabled={enabled}
      value={value}
      onChange={(next) => {
        setAttention(false);
        setDraft(next);
      }}
      onSubmit={submit}
      sending={sending}
      attention={attention}
      canSummon={canSummonCanvas(state.status)}
      onSummon={summonCanvas}
    />
  );
}

export function RoleWindow({
  api,
  role,
}: {
  readonly api: BuddyDesktopApi;
  readonly role: Exclude<RendererWindowRole, 'legacy'>;
}) {
  if (role === 'canvas') return <CanvasWindow api={api} />;
  if (role === 'status') return <StatusWindow api={api} />;
  return <InputWindow api={api} />;
}
