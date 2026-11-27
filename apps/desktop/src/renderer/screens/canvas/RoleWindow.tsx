// キャンバス表示の窓の画面の切り替え（UI-02 の試作・UI-04、ADR 0032・0181）。preload が渡した窓の役割で、キャンバス・
// 状態の層・入力バー・上の中央の島のどれを描くかを決める。役割で使えるチャネルは main が決め、画面は役割の表にある要求
// だけを送る。島と入力バーは窓の地を透明にし、角の外を透かす（U399 の暫定 (a)。窓は main が透明で作る）。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
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
  voiceControlsView,
  voiceStripView,
} from '../../state/status-panel-state.js';
import { useNow } from '../../state/use-desktop-state.js';
import { islandView } from '../../state/island-state.js';
import { useIslandSignals } from '../../state/use-island-signals.js';
import type { Notice } from '../../state/work-state.js';
import {
  useCanvasViewport,
  useInputBarExpanded,
  usePageVisibility,
  useRoleWindowState,
  useWindowFocused,
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
  statusSummaryView,
  transparentSurfaceFor,
} from '../../state/window-role-state.js';
import type { RendererWindowRole } from '../../state/window-role-state.js';
import {
  canSubmit,
  clarificationAfter,
  submitResult,
} from '../../state/input-bar-state.js';
import { CanvasBoard } from './CanvasBoard.js';
import { CanvasGround } from './CanvasGround.js';
import { CanvasIsland, useIslandHold } from './CanvasIsland.js';
import { InputBar } from './InputBar.js';
import { StatusPanel } from './StatusPanel.js';
import { VoiceStrip } from './VoiceStrip.js';

function CanvasWindow({ api }: { readonly api: BuddyDesktopApi }) {
  const { state, canvasUserOp, canvasContent } = useRoleWindowState(
    api,
    'canvas',
  );
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
        loadContent={canvasContent}
      />
    </CanvasGround>
  );
}

// 操作がないときの空の配列（描画のたびに新しい配列を作らない）。
const NO_OPERATIONS: readonly DesktopOperationEntry[] = [];
const NO_BUDGET_ITEMS: readonly DesktopBudgetEntry[] = [];
// 島の窓には行の知らせ（パネルの WorkOperations が持つ）がない。島は結果を待っていた操作の状態の移りだけを結果にする。
const NO_NOTICES: Readonly<Record<string, Notice>> = {};

// 上の中央の島（ADR 0181 の段階 4）。状態の取得・停止・パネルを出すだけ（役割 island。承認・取消・再開は使えない）。
function IslandWindow({ api }: { readonly api: BuddyDesktopApi }) {
  const { state, setPanel, stop } = useRoleWindowState(api, 'island');
  const now = useNow();
  const connection = shownConnection(state.connection);
  // 確認が必要な操作の数と結果は、パネルと同じ条件（ロック解除済み・登録済み・中枢に接続中）で数える。
  const live = operationsShown(state.status, connection);
  const operations = connection?.operations ?? NO_OPERATIONS;
  const signals = useIslandSignals(live, operations, NO_NOTICES);
  const [holdingSince, onHoldChange] = useIslandHold();
  const summary = statusSummaryView(state.status, state.connection);
  return (
    <CanvasIsland
      view={islandView({
        status: state.status,
        connection: state.connection,
        now,
        signals,
        holdingSince,
      })}
      pending={summary.pending}
      summaryLabel={summary.label}
      privacy={privacyMarks(state.status, state.voice)}
      onStop={stop}
      onOpenPanel={() => setPanel(true)}
      onHoldChange={onHoldChange}
    />
  );
}

// 状態の層（UI-04）。main が窓を表示している間だけパネルを描く（窓はパネルの大きさで作り、しまうと隠す。ADR 0181 の段階 4）。
function StatusWindow({ api }: { readonly api: BuddyDesktopApi }) {
  const {
    state,
    setPanel,
    stop,
    resume,
    continueVoice,
    revokeVoiceConsent,
    controlVoice,
  } = useRoleWindowState(api, 'status');
  const now = useNow();
  const visibility = usePageVisibility();
  const panelOpen = panelShownFor(visibility.state);
  const connection = shownConnection(state.connection);
  // 確認が必要な操作の一覧（WorkPanel と同じ持ち方。ロック・切断で内容を捨てる。ADR 0031）。
  const live = operationsShown(state.status, connection);
  const operations = connection?.operations ?? NO_OPERATIONS;
  const work = useWorkState(api, live, operations);
  // 予算の確認（超過枠の承認・M 超過の確認・不明な費用の手での精算。B07-05）。操作の一覧と同じく、ロック・切断で捨てる。
  const budgetItems = connection?.budget_items ?? NO_BUDGET_ITEMS;
  const budget = useBudgetState(api, live, budgetItems);
  const previewEntry = usePreviewFocus(work.state, operations);
  const view = statusSummaryView(state.status, state.connection);
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
  // 隠している間は描かない。出すたびに描き直し（key）、パネルの滑り込みとフォーカスの移動をやり直す。
  if (!panelOpen) return null;
  return (
    <StatusPanel
      key={visibility.shownCount}
      onClose={() => setPanel(false)}
      status={state.status}
      ioLine={view.line}
      items={statusItems(state.status, state.connection, now)}
      message={messageFor(state, ['desktop.io_stop', 'desktop.io_resume'])}
      onStop={stop}
      onResume={resume}
      stopShortcut={stopShortcutMark(api.stopShortcut)}
      stopKeys={stopShortcutKeys(navigator.userAgent)}
      voice={
        <VoiceStrip
          view={voiceStripView(state.voice)}
          message={messageFor(state, [
            'desktop.voice_continue',
            'desktop.voice_consent_revoke',
            'desktop.voice_control',
          ])}
          onContinue={continueVoice}
          onRevoke={revokeVoiceConsent}
          controls={voiceControlsView(state.voice)}
          onReplyMode={(mode) =>
            controlVoice(mode === 'voice' ? 'reply_in_voice' : 'reply_in_text')
          }
          onStopPlayback={() => controlVoice('stop_playback')}
          onEndConversation={() => controlVoice('end_conversation')}
        />
      }
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
  const expanded = useInputBarExpanded();
  const [draft, setDraft] = useState('');
  // 送っている間（重ねて送らない）と、入力欄の枠で知らせる要注意（聞き返し・拒否・失敗。文字は残す）。
  const [sending, setSending] = useState(false);
  const [attention, setAttention] = useState(false);
  // 聞き返しの文（UI-08）。送信の結果が聞き返しのときだけ、広がった入力バーに出す。
  const [clarification, setClarification] = useState<string | null>(null);
  // 送った文字が今の下書きと同じときだけ空にする（送っている間に打ち足した文字を消さない）。
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // 下書きの世代。送信の後に編集したら進め、古い依頼の聞き返しを新しい下書きの上に出さない。
  const draftVersion = useRef(0);
  const statusRef = useRef(state.status);
  statusRef.current = state.status;
  // ロック中・不明になったら下書きを捨てる（描画は inputDraftAfter で先に隠す）。
  useEffect(() => {
    setDraft((prev) => inputDraftAfter(prev, state.status));
    if (!contentShown(state.status)) {
      draftVersion.current += 1;
      setAttention(false);
      setClarification(null);
    }
  }, [state.status]);
  const enabled = inputBarEnabled(state.status);
  const value = inputDraftAfter(draft, state.status);
  const submit = useCallback(() => {
    const text = draftRef.current;
    if (!canSubmit(text, enabled, sending)) return;
    const version = draftVersion.current;
    setSending(true);
    setAttention(false);
    setClarification(null);
    api
      .invoke(request('desktop.turn_submit', { text }))
      .then((response) => {
        // 送信の後に下書きが変わった・ロック中・不明なら、古い依頼の結果を今の入力欄に反映しない。
        if (
          version !== draftVersion.current ||
          !contentShown(statusRef.current)
        )
          return;
        setClarification(
          clarificationAfter(response, version, draftVersion.current, true),
        );
        if (submitResult(response) === 'sent')
          setDraft((current) => (current === text ? '' : current));
        else setAttention(true);
      })
      .catch(() => setAttention(true))
      .finally(() => setSending(false));
  }, [api, enabled, sending]);
  const view = statusSummaryView(state.status, null);
  return (
    <InputBar
      line={view.line}
      enabled={enabled}
      value={value}
      onChange={(next) => {
        draftVersion.current += 1;
        setAttention(false);
        setClarification(null);
        setDraft(next);
      }}
      onSubmit={submit}
      sending={sending}
      attention={attention}
      canSummon={canSummonCanvas(state.status)}
      onSummon={summonCanvas}
      expanded={expanded}
      clarification={contentShown(state.status) ? clarification : null}
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
  // 描く前に地を決める（透明な窓に、テーマの地の色の四角が一瞬でも出ないように）。
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (transparentSurfaceFor(role))
      root.dataset['windowSurface'] = 'transparent';
    else delete root.dataset['windowSurface'];
  }, [role]);
  if (role === 'canvas') return <CanvasWindow api={api} />;
  if (role === 'status') return <StatusWindow api={api} />;
  if (role === 'island') return <IslandWindow api={api} />;
  return <InputWindow api={api} />;
}
