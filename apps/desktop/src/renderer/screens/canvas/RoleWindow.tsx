// 3 つの窓の画面の切り替え（UI-02 の試作、ADR 0032）。preload が渡した窓の役割で、キャンバス・状態の層・入力バーの
// どれを描くかを決める。役割で使えるチャネルは main が決め、画面は役割の表にある要求だけを送る。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BuddyDesktopApi } from '../../desktop-api.js';
import { request } from '../../desktop-api.js';
import {
  useRoleWindowState,
  useWindowFocused,
} from '../../state/use-role-window-state.js';
import {
  canSummonCanvas,
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
import { StatusTab } from './StatusTab.js';

function CanvasWindow({ api }: { readonly api: BuddyDesktopApi }) {
  const { state } = useRoleWindowState(api, 'canvas');
  const focused = useWindowFocused();
  return (
    <CanvasGround front={focused} shown={contentShown(state.status)}>
      <CanvasBoard view={state.canvas} />
    </CanvasGround>
  );
}

function StatusWindow({ api }: { readonly api: BuddyDesktopApi }) {
  const { state, summonCanvas } = useRoleWindowState(api, 'status');
  return (
    <StatusTab
      view={statusTabView(state.status, state.connection)}
      canSummon={canSummonCanvas(state.status)}
      onSummon={summonCanvas}
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
