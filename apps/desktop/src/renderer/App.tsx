// UI レンダラーの画面の切り替え（ADR 0014・0015・0024・0025・0026）。
// 限定 API（preload の invoke・onNotification）を読めなければ、その旨だけを出す。
// 未登録・再登録が必要・登録の途中なら登録の画面、それ以外は端末の画面。中枢の画面の端末（main が中枢に確かめた
// hub_screen）なら、端末の画面の本体を「端末の登録」「登録済みの端末」「自宅のネットワーク」「このマシンの接続」の Tabs にする。
// ロック中・ロック状態不明では main が接続の内容を隠すので、端末の画面（内容を隠した状態帯）になる。
// 登録済みの端末の画面は、機能をページに分け、左のサイドバーで切り替える（ADR 0204）: 会話（確認が必要な操作を含む）・
// 気づき・自動実行・家計簿・記憶・端末と接続。選んでいるページはここが持つ（島の「確認が必要な操作を見る」と、会話からの
// 家計の記録の候補が、ページを切り替えるため）。
// 画面を足すときは screens/<名前>/ に置き、ここで切り替える。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from '@heroui/react';
import type {
  DesktopOperationEntry,
  DesktopPrivateConfirmationEntry,
  StorageMode,
} from '@buddy/contracts';
import { AlertIcon } from './components/AlertIcon.js';
import { AppShell } from './app/AppShell.js';
import { desktopApi } from './desktop-api.js';
import type { BuddyDesktopApi } from './desktop-api.js';
import { ConnectionSection } from './screens/device/ConnectionSection.js';
import { DeviceScreen } from './screens/device/DeviceScreen.js';
import { HomeNetworkPanel } from './screens/hub/HomeNetworkPanel.js';
import { ConnectionsPanel } from './screens/hub/ConnectionsPanel.js';
import { HubTabs } from './screens/hub/HubPanels.js';
import { PairingScreen } from './screens/pairing/PairingScreen.js';
import { RoleWindow } from './screens/canvas/RoleWindow.js';
import {
  hubScreenMode,
  needsPairing,
  nextHubSeen,
  shownConnection,
} from './state/connection-state.js';
import { useDesktopState, useNow } from './state/use-desktop-state.js';
import { useHomeState } from './state/use-home-state.js';
import { useHubState } from './state/use-hub-state.js';
import { useWorkState } from './state/use-work-state.js';
import { useIslandSignals } from './state/use-island-signals.js';
import { useCandidateState } from './state/use-candidate-state.js';
import { useAutoActionState } from './state/use-auto-action-state.js';
import { useHouseholdState } from './state/use-household-state.js';
import { useMemoryState } from './state/use-memory-state.js';
import { canStartAddFrom } from './state/household-state.js';
import { inputFromCandidate } from './state/household-candidate.js';
import { useConnectionsState } from './state/use-connections-state.js';
import { CandidatesPanel } from './screens/candidates/CandidatesPanel.js';
import { AutoActionsPanel } from './screens/auto-actions/AutoActionsPanel.js';
import { HouseholdPanel } from './screens/household/HouseholdPanel.js';
import { MemoryPanel } from './screens/memory/MemoryPanel.js';
import { MemorySettingsPanel } from './screens/memory/MemorySettingsPanel.js';
import { WorkPanel } from './screens/work/WorkPanel.js';
import { StopShortcutMark } from './components/StopShortcutMark.js';
import {
  AutoIcon,
  InsightIcon,
  LedgerIcon,
  MemoryIcon,
  TalkIcon,
} from './components/NavIcons.js';
import { openAttention } from './components/StatusBand.js';
import type { ShellPage } from './app/AppShell.js';
import { groupOperations } from './state/work-state.js';
import { StorageModeControl } from './components/StorageMode.js';
import { PrivateConfirmations } from './components/PrivateConfirmations.js';
import { usePrivateConfirmationState } from './state/use-private-confirmation-state.js';
import { messageFor } from './state/desktop-state.js';
import {
  storageBoundary,
  storageModeControlView,
  storageModeOf,
} from './state/storage-mode-state.js';
import {
  stopShortcutKeys,
  stopShortcutMark,
} from './state/status-panel-state.js';
import { rendererWindowRole } from './state/window-role-state.js';

// 操作がないときの空の配列（描画のたびに新しい配列を作らない）。
const NO_OPERATIONS: readonly DesktopOperationEntry[] = [];
const NO_PRIVATE_CONFIRMATIONS: readonly DesktopPrivateConfirmationEntry[] = [];

function ApiUnavailable() {
  return (
    <AppShell role="この端末">
      <Alert status="danger" role="alert">
        <Alert.Indicator>
          <AlertIcon />
        </Alert.Indicator>
        <Alert.Content>
          <Alert.Title>
            画面を開けませんでした。Buddy を終了して、開き直してください。
          </Alert.Title>
        </Alert.Content>
      </Alert>
    </AppShell>
  );
}

function ConnectedApp({ api }: { readonly api: BuddyDesktopApi }) {
  const { state, actions, pairing, dismissRegistered } = useDesktopState(api);
  const now = useNow();
  const connection = shownConnection(state.connection);
  // 前に中枢の画面と確かめたか（接続を待つ間も中枢の画面の枠を残す。判定の正本は main）。
  const [hubSeen, setHubSeen] = useState(false);
  const seen = nextHubSeen(hubSeen, connection);
  useEffect(() => {
    if (seen !== hubSeen) setHubSeen(seen);
  }, [seen, hubSeen]);
  const mode = hubScreenMode(seen, connection);
  const hubScreen = mode !== 'off';
  const locked = state.status?.visibility !== 'shown';
  const hub = useHubState(api, mode, locked);
  // 自宅のネットワーク（B03-08）。接続を待つ間も最後の表示を残し、操作だけを止める。
  const home = useHomeState(api, hubScreen);
  const stopped =
    state.status?.visibility === 'shown' && state.status.stop_scope !== 'none';
  // 会話・変更の確認・処理状況（B04-05）。ロック中・未登録では内容を持たない（ロックで捨てる）。
  const workShown =
    !locked && connection !== null && connection.registration === 'registered';
  // 中枢に接続している間だけ会話の内容を持つ。切断（接続の待ちを含む）で世代を進めて内容を捨て、切断をまたいだ応答を
  // 反映しない（main も切断で参照・preview・会話を捨てる。ADR 0031）。
  const workLive = workShown && connection?.link === 'connected';
  const work = useWorkState(
    api,
    workLive,
    connection?.operations ?? NO_OPERATIONS,
  );
  // 上の中央の島を広げるきっかけ（ADR 0181 の段階 2）。確認が必要な操作が増えた・操作の結果が届いた。会話と同じく、
  // ロック解除済みで中枢に接続している間だけ数える（ロック・切断で忘れる）。
  // 保存モード（UI-05 の段階 6、ADR 0189）。会話と同じく、ロック解除済みで中枢に接続している間だけ見る。変わったら島を
  // 区切りの知らせで広げ、会話の履歴に区切りの行を足す（受け取っていなかった値からの変化は区切りにしない）。
  const storageMode = workLive ? storageModeOf(state.status) : null;
  // 記録しない会話の独立した確認（ADR 0197）。main が記録しない会話の間だけ出す。承認を待つ確認が増えたら島を広げる。
  const privateConfirmations =
    connection?.private_confirmations ?? NO_PRIVATE_CONFIRMATIONS;
  const privateDecisions = usePrivateConfirmationState(
    api,
    workLive,
    storageMode,
  );
  const island = useIslandSignals(
    workLive,
    connection?.operations ?? NO_OPERATIONS,
    work.state.notices,
    storageMode,
    privateConfirmations.length,
  );
  const seenStorageMode = useRef<StorageMode | null>(null);
  const markBoundary = work.actions.markBoundary;
  useEffect(() => {
    const boundary = storageBoundary(seenStorageMode.current, storageMode);
    seenStorageMode.current = storageMode;
    if (boundary !== null && boundary.line.mark !== 'none')
      markBoundary({
        text: boundary.line.text,
        mark: boundary.line.mark === 'square' ? 'square' : 'dot',
      });
  }, [storageMode, markBoundary]);
  // 自動実行の一覧・安全停止・取り消し（B13-05、ADR 0154）。気づきと同じく、ロック解除済みで中枢に接続している間だけ
  // 内容を持つ（切断・ロックで捨てる）。
  // 自動実行の欄で取り消した・読み直した後は、気づきの行の自動実行の写しも読み直す（ADR 0199）。気づきの欄は後で
  // 作るので、参照を通して呼ぶ。
  const reloadCandidates = useRef<() => void>(() => undefined);
  const candidatesChanged = useCallback(() => reloadCandidates.current(), []);
  const autoActions = useAutoActionState(api, workLive, candidatesChanged);
  // 気づき（B11-05、ADR 0132）。会話と同じく、ロック解除済みで中枢に接続している間だけ内容を持つ（切断・ロックで捨てる）。
  // 気づきの欄で自動実行を取り消したら、自動実行の欄も読み直す（ADR 0199。知らせ返さない reload を使う）。
  const candidates = useCandidateState(
    api,
    workLive,
    autoActions.actions.reload,
  );
  useEffect(() => {
    reloadCandidates.current = candidates.actions.reload;
  }, [candidates.actions]);
  // 家計簿（ADR 0162）。自動実行と同じく、ロック解除済みで中枢に接続している間だけ内容を持つ（切断・ロックで捨てる）。
  const household = useHouseholdState(api, workLive);
  // 忘却の画面（UI-10、ADR 0183）。家計簿と同じく、ロック解除済みで中枢に接続している間だけ内容を持つ（切断・ロックで捨てる）。
  const memories = useMemoryState(api, workLive);
  // 連携アカウント（B08-02 P3・B09-05、ADR 0142）。中枢の画面で中枢に接続している間だけ内容を持つ
  // （中枢の画面かどうかは main が確かめる。接続を待つ間は欄だけ出し、操作を止める）。
  const linked = useConnectionsState(api, mode === 'live');
  // 選んでいるページ（ADR 0204）。null は最初のページ。
  const [page, setPage] = useState<string | null>(null);
  // ページを切り替えてから、切り替えた先の欄へ移る（描き直しの後。隠れているページの見出しにはフォーカスを移せない）。
  const afterPage = useRef<(() => void) | null>(null);
  useEffect(() => {
    const run = afterPage.current;
    afterPage.current = null;
    run?.();
  }, [page]);
  const attentionCount = workShown
    ? groupOperations(connection?.operations ?? NO_OPERATIONS).attention
        .length + privateConfirmations.length
    : 0;
  // 機能のページ（ADR 0204）。会話と同じ条件（ロック解除済み・登録済み）で出す。切断中もページを出し、各欄が
  // 取得できていないことを示す。
  const pages: readonly ShellPage[] =
    workShown && connection !== null
      ? [
          {
            id: 'talk',
            label: '会話',
            icon: <TalkIcon />,
            badge: attentionCount,
            badgeLabel: `確認が必要な操作 ${attentionCount}\u00a0件`,
            content: (
              <>
                <PrivateConfirmations
                  entries={privateConfirmations}
                  privateMode={storageMode === 'private'}
                  state={privateDecisions.state}
                  actions={privateDecisions.actions}
                  stopped={stopped}
                />
                <WorkPanel
                  state={work.state}
                  actions={work.actions}
                  operations={connection.operations}
                  link={connection.link === 'connected' ? 'connected' : 'other'}
                  stopped={stopped}
                  // 会話の一言からの家計の記録の候補を、家計簿の欄の手入力の欄に入れて開く（ADR 0171）。開けたら候補をしまう
                  // （同じ候補から二度開かない）。記録は本人が欄で「足す」を押したときだけ作る。
                  storage={
                    <StorageModeControl
                      view={storageModeControlView(state.status)}
                      message={messageFor(state, [
                        'desktop.storage_mode_change',
                      ])}
                      onChange={actions.changeStorageMode}
                    />
                  }
                  household={{
                    canOpen: canStartAddFrom(household.state),
                    open: (draft) => {
                      if (
                        household.actions.startAddFrom(
                          inputFromCandidate(draft),
                        )
                      )
                        work.actions.dismissHouseholdCandidate();
                    },
                  }}
                />
              </>
            ),
          },
          {
            id: 'candidates',
            label: '気づき',
            icon: <InsightIcon />,
            content: (
              <>
                {/* 切断中も欄を出し、取得できていないことを示す（「気づきはありません」と言わない。設計 01）。 */}
                <CandidatesPanel
                  state={candidates.state}
                  actions={candidates.actions}
                  now={now}
                />
              </>
            ),
          },
          {
            id: 'auto',
            label: '自動実行',
            icon: <AutoIcon />,
            content: (
              <>
                {/* 切断中も欄を出し、取得できていないことを示す（「自動で行った操作はありません」と言わない）。 */}
                <AutoActionsPanel
                  state={autoActions.state}
                  actions={autoActions.actions}
                  now={now}
                />
              </>
            ),
          },
          {
            id: 'household',
            label: '家計簿',
            icon: <LedgerIcon />,
            content: (
              <>
                {/* 切断中も欄を出し、取得できていないことを示す（「記録はありません」と言わない）。 */}
                <HouseholdPanel
                  state={household.state}
                  actions={household.actions}
                  now={now}
                />
              </>
            ),
          },
          {
            id: 'memory',
            label: '記憶',
            icon: <MemoryIcon />,
            content: (
              <>
                {/* 保存してよい記憶の種類（ADR 0191）。忘却の欄の上。読めていない間は選択を置かない。 */}
                <MemorySettingsPanel
                  state={memories.state}
                  actions={memories.actions}
                />
                {/* 切断中も欄を出し、取得できていないことを示す（「記憶はありません」と言わない）。 */}
                <MemoryPanel
                  state={memories.state}
                  actions={memories.actions}
                  now={now}
                />
              </>
            ),
          },
        ]
      : [];
  if (connection !== null && needsPairing(connection))
    return (
      <PairingScreen
        state={state}
        connection={connection}
        actions={actions}
        pairing={pairing}
        now={now}
      />
    );
  return (
    <DeviceScreen
      state={state}
      actions={actions}
      now={now}
      role={
        mode === 'live'
          ? '中枢の画面'
          : mode === 'paused'
            ? '中枢の画面（接続を待っています）'
            : 'この端末'
      }
      onDismissRegistered={dismissRegistered}
      island={island}
      stopShortcut={
        <StopShortcutMark
          mark={stopShortcutMark(api.stopShortcut)}
          keys={stopShortcutKeys(navigator.userAgent)}
        />
      }
      pages={pages}
      {...(page === null ? {} : { page })}
      onPageChange={setPage}
      onOpenAttention={() => {
        // 確認の欄は会話のページにある。ページを切り替えてから、見出しへ移る。
        if (page === 'talk' || (page === null && pages.length > 0))
          openAttention();
        else {
          afterPage.current = openAttention;
          setPage('talk');
        }
      }}
      hub={
        hubScreen && connection !== null ? (
          <HubTabs
            state={hub.state}
            actions={hub.actions}
            now={now}
            paused={
              mode === 'paused'
                ? {
                    linked: connection.link === 'connected',
                    lastConfirmedAt: connection.last_confirmed_at,
                  }
                : null
            }
            stopped={stopped}
            thisDevice={
              <ConnectionSection
                connection={connection}
                title="このマシンと中枢の接続"
              />
            }
            home={
              <HomeNetworkPanel
                state={home.state}
                actions={home.actions}
                now={now}
                paused={mode === 'paused'}
                stopped={stopped}
              />
            }
            connections={
              <ConnectionsPanel
                state={linked.state}
                actions={linked.actions}
                paused={mode === 'paused'}
              />
            }
          />
        ) : undefined
      }
    />
  );
}

export function App() {
  const api = desktopApi();
  if (api === null) return <ApiUnavailable />;
  // 窓の役割（UI-02）。従来の窓は今の画面のまま。3 つの窓の試作は役割ごとの画面。知らない役割は何も描かない。
  const role = rendererWindowRole(api.windowRole);
  if (role === null) return null;
  if (role !== 'legacy') return <RoleWindow api={api} role={role} />;
  return <ConnectedApp api={api} />;
}
