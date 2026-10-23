// 3 つの窓の画面の切り替え（UI-02 の試作、ADR 0032）。preload が渡した窓の役割で、キャンバス・状態の層・入力バーの
// どれを描くかを決める。役割で使えるチャネルは main が決め、画面は役割の表にある要求だけを送る。
import { useEffect, useState } from 'react';
import type { BuddyDesktopApi } from '../../desktop-api.js';
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
import { CanvasGround } from './CanvasGround.js';
import { InputBar } from './InputBar.js';
import { StatusTab } from './StatusTab.js';

function CanvasWindow({ api }: { readonly api: BuddyDesktopApi }) {
  const { state } = useRoleWindowState(api, 'canvas');
  const focused = useWindowFocused();
  return <CanvasGround front={focused} shown={contentShown(state.status)} />;
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
  // ロック中・不明になったら下書きを捨てる（描画は inputDraftAfter で先に隠す）。
  useEffect(() => {
    setDraft((prev) => inputDraftAfter(prev, state.status));
  }, [state.status]);
  const view = statusTabView(state.status, null);
  return (
    <InputBar
      line={view.line}
      enabled={inputBarEnabled(state.status)}
      value={inputDraftAfter(draft, state.status)}
      onChange={setDraft}
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
