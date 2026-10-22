// 中枢の画面の端末だけに出す本体（設計 02 端末登録と接続、ADR 0024・0026）。Tabs で「承認待ちの申請」
// 「登録済みの端末」「自宅のネットワーク」（B03-08）「このマシンの接続」を分ける（状態帯は全画面で共通）。
// 承認・拒否・失効は重い操作として、
// 確認（ConfirmDialog）を挟んでから送る。状態と操作は引数で受け取り、限定 API を直接呼ばない。
// 画面に来るのは main の参照（ref）と表示用の値だけで、申請 ID・端末 ID・申請用の秘密・トークンはない。
// 申請が 1 件以上あるときは申請の一覧を先に置く（いちばん押すボタンを上に。UI レビュー 2 回目 R1-M1）。
// 操作の結果の文言は、押した行のすぐ下に出す（R1-M2）。
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Tabs } from '@heroui/react';
import type {
  DesktopClaimEntry,
  DesktopDeviceEntry,
  DesktopPairingSession,
} from '@buddy/contracts';
import { FingerprintGrid } from '../../components/FingerprintGrid.js';
import { InlineNotice } from '../../components/InlineNotice.js';
import { Section } from '../../components/Section.js';
import { StatusText } from '../../components/StatusText.js';
import { clockOf, remainingOf, splitInFour } from '../../format.js';
import { PLATFORM_LABELS } from '../../labels.js';
import type {
  HubActions,
  HubNotice,
  HubPane,
  HubViewState,
} from '../../state/hub-state.js';
import type { StatusLine } from '../../tones.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import type { ConfirmRequest } from './ConfirmDialog.js';

export const HUB_LABELS = {
  thisMachine: 'このマシンの接続',
  homeTitle: '自宅のネットワーク',
  claimsTitle: '承認待ちの申請',
  devicesTitle: '登録済みの端末',
  noClaims: '承認待ちの申請はありません。',
  loading: '読み込んでいます…',
  approve: '承認する',
  reject: '拒否する',
  revoke: '失効する',
  refresh: '一覧を更新',
  openTitle: '新しい端末を登録する',
  open: 'ペアリングを始める（コードを出す）',
  reopen: 'コードを出し直す',
  claimCheck: '確認コード',
  claimCheckRole: '承認の前に、申請した端末の画面と見比べる 8 桁',
  pairingCode: 'ワンタイムコード',
  pairingCodeRole: '登録する端末に入力する 8 桁',
  fingerprintNote:
    '下線の最後の 4 桁を、登録する端末に入力してもらいます（端末の画面では伏せています）。',
  hubDevice: '中枢（このマシン）',
} as const;

function platformOf(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

// 欄・行・ボタンの下に出す操作の結果（警告は warning の ⚠、適用できたときは success の ●。InlineNotice は
// 自宅のネットワークのタブと共通。B03-08 のレビュー L8）。
function NoticeText({ notice }: { readonly notice: HubNotice }) {
  return <InlineNotice tone={notice.tone} text={notice.text} />;
}

const noticeAt = (
  notice: HubNotice | null,
  pane: HubPane,
  place: 'section' | 'open' | string,
): HubNotice | null => {
  if (notice === null || notice.pane !== pane) return null;
  if (place === 'section')
    return notice.place.kind === 'section' ? notice : null;
  if (place === 'open') return notice.place.kind === 'open' ? notice : null;
  return notice.place.kind === 'row' && notice.place.ref === place
    ? notice
    : null;
};

function RefreshButton({ onPress }: { readonly onPress: () => void }) {
  return (
    <Button size="sm" variant="outline" onPress={onPress}>
      {HUB_LABELS.refresh}
    </Button>
  );
}

export function PairingOpenPanel({
  session,
  sessionUsed,
  busy,
  now,
  notice,
  actions,
}: {
  readonly session: DesktopPairingSession | null;
  readonly sessionUsed: boolean;
  readonly busy: boolean;
  readonly now: number;
  readonly notice: HubNotice | null;
  readonly actions: HubActions;
}) {
  const expired = session !== null && Date.parse(session.expires_at) <= now;
  // 期限が切れた・申請に使われたコードは表示に残さない（CR-L6）。
  const showCode = session !== null && !expired && !sessionUsed;
  return (
    <Section id="hub-open-heading" title={HUB_LABELS.openTitle}>
      {session === null ? (
        <p className="max-w-prose text-sm leading-6">
          登録する端末でペアリングを始める前に、ここでワンタイムコードを出します（有効
          5 分・入力は 5 回まで）。
        </p>
      ) : !showCode ? (
        <p className="max-w-prose text-sm leading-6">
          {sessionUsed
            ? 'このコードは申請に使われました（コードは 1 回だけ使えます）。別の端末を登録するときは、コードを出し直してください。'
            : 'このコードは期限が切れました。登録するときは、コードを出し直してください。'}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="max-w-prose text-sm leading-6">
            登録する端末にこのコードを入力してもらいます。端末の画面の指紋が下の指紋と同じことを確かめてもらってください。
          </p>
          <dl className="flex flex-col gap-1">
            <dt className="text-sm font-medium">
              {HUB_LABELS.pairingCode}
              <span className="ml-2 text-xs font-normal text-muted">
                {HUB_LABELS.pairingCodeRole}
              </span>
            </dt>
            <dd
              id="hub-open-code"
              className="font-mono text-xl tracking-widest tabular-nums"
            >
              {splitInFour(session.pairing_code)}
            </dd>
            <dd className="text-xs text-muted tabular-nums">
              {clockOf(session.expires_at, now, { seconds: false })} まで（
              {remainingOf(session.expires_at, now)}）
            </dd>
          </dl>
          <FingerprintGrid
            fingerprint={session.certificate_fingerprint}
            id="hub-open-fingerprint"
            note={HUB_LABELS.fingerprintNote}
          />
        </div>
      )}
      <div className="flex flex-col gap-1">
        <div>
          <Button
            variant={session === null ? 'primary' : 'secondary'}
            isDisabled={busy}
            onPress={actions.openPairing}
          >
            {session === null ? HUB_LABELS.open : HUB_LABELS.reopen}
          </Button>
        </div>
        {notice === null ? null : <NoticeText notice={notice} />}
      </div>
    </Section>
  );
}

// 承認の確認（確認コードを大きな等幅で別の段に出し、題に OS と申請の時刻を入れる。R1-M4）。
export function approveRequest(
  claim: DesktopClaimEntry,
  now: number,
  onConfirm: () => void,
): ConfirmRequest {
  return {
    title: `「${claim.device_name}」（${platformOf(claim.platform)}・${clockOf(claim.claimed_at, now)} の申請）を承認しますか`,
    body: (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">
            この申請の{HUB_LABELS.claimCheck}
          </p>
          <p className="font-mono text-2xl font-semibold tracking-wider tabular-nums">
            {splitInFour(claim.claim_check)}
          </p>
        </div>
        <p className="text-sm leading-6">
          申請した端末の画面の確認コードと、8
          桁すべて同じときだけ承認してください。承認すると、その端末はこの中枢に接続できるようになります。
        </p>
      </div>
    ),
    confirmLabel: HUB_LABELS.approve,
    tone: 'accent',
    onConfirm,
  };
}

export function ClaimsPanel({
  claims,
  busy,
  now,
  notice,
  onAsk,
  actions,
}: {
  readonly claims: readonly DesktopClaimEntry[] | null;
  readonly busy: boolean;
  readonly now: number;
  readonly notice: HubNotice | null;
  readonly onAsk: (request: ConfirmRequest) => void;
  readonly actions: HubActions;
}) {
  const top = noticeAt(notice, 'claims', 'section');
  return (
    <Section
      id="hub-claims-heading"
      title={HUB_LABELS.claimsTitle}
      action={<RefreshButton onPress={() => actions.refresh('claims')} />}
    >
      {top === null ? null : <NoticeText notice={top} />}
      {claims === null ? (
        <p className="text-sm text-muted">{HUB_LABELS.loading}</p>
      ) : claims.length === 0 ? (
        <p className="text-sm text-muted">{HUB_LABELS.noClaims}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-separator">
          {claims.map((claim) => {
            const rowNotice = noticeAt(notice, 'claims', claim.ref);
            return (
              <li key={claim.ref} className="flex flex-col gap-2 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="text-sm font-semibold break-words">
                      {claim.device_name}
                      <span className="ml-2 text-xs font-normal text-muted">
                        {platformOf(claim.platform)}
                      </span>
                    </p>
                    <p className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm">{HUB_LABELS.claimCheck}</span>
                      <span className="font-mono text-2xl font-semibold tracking-wider tabular-nums">
                        {splitInFour(claim.claim_check)}
                      </span>
                    </p>
                    <p className="text-xs text-muted tabular-nums">
                      {HUB_LABELS.claimCheckRole}。申請{' '}
                      {clockOf(claim.claimed_at, now)}・
                      {clockOf(claim.expires_at, now, { seconds: false })}{' '}
                      まで（
                      {remainingOf(claim.expires_at, now)}）
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      isDisabled={busy}
                      aria-label={`「${claim.device_name}」の申請を承認する`}
                      onPress={() =>
                        onAsk(
                          approveRequest(claim, now, () =>
                            actions.decide(claim, 'approve'),
                          ),
                        )
                      }
                    >
                      {HUB_LABELS.approve}
                    </Button>
                    <Button
                      variant="danger-soft"
                      size="sm"
                      isDisabled={busy}
                      aria-label={`「${claim.device_name}」の申請を拒否する`}
                      onPress={() =>
                        onAsk({
                          title: `「${claim.device_name}」（${platformOf(claim.platform)}・${clockOf(claim.claimed_at, now)} の申請）を拒否しますか`,
                          body: (
                            <p className="text-sm leading-6">
                              拒否した申請は使えなくなります。登録するには、端末側でペアリングを最初からやり直します。
                            </p>
                          ),
                          confirmLabel: HUB_LABELS.reject,
                          tone: 'danger',
                          onConfirm: () => actions.decide(claim, 'reject'),
                        })
                      }
                    >
                      {HUB_LABELS.reject}
                    </Button>
                  </div>
                </div>
                {rowNotice === null ? null : <NoticeText notice={rowNotice} />}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function deviceLine(device: DesktopDeviceEntry): StatusLine {
  // 失効は本人が終えた状態なので、警報（danger）にせず中立の ○ にする（UI レビュー 2 回目 R1-L1）。
  if (device.revoked_at !== null)
    return { tone: 'muted', mark: 'circle', text: '失効済み' };
  if (device.this_device)
    return { tone: 'success', mark: 'dot', text: HUB_LABELS.hubDevice };
  return { tone: 'success', mark: 'dot', text: '有効' };
}

export function DevicesPanel({
  devices,
  busy,
  now,
  notice,
  onAsk,
  actions,
}: {
  readonly devices: readonly DesktopDeviceEntry[] | null;
  readonly busy: boolean;
  readonly now: number;
  readonly notice: HubNotice | null;
  readonly onAsk: (request: ConfirmRequest) => void;
  readonly actions: HubActions;
}) {
  const top = noticeAt(notice, 'devices', 'section');
  return (
    <Section
      id="hub-devices-heading"
      title={HUB_LABELS.devicesTitle}
      action={<RefreshButton onPress={() => actions.refresh('devices')} />}
    >
      {top === null ? null : <NoticeText notice={top} />}
      {devices === null ? (
        <p className="text-sm text-muted">{HUB_LABELS.loading}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-separator">
          {devices.map((device, index) => {
            const revoked = device.revoked_at !== null;
            const ref = device.ref;
            const rowNotice =
              ref === null ? null : noticeAt(notice, 'devices', ref);
            return (
              <li
                key={ref ?? `fixed-${index}`}
                className="flex flex-col gap-2 py-3"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <span
                        className={`font-semibold break-words ${revoked ? 'text-muted' : ''}`}
                      >
                        {device.device_name}
                      </span>
                      <StatusText
                        line={deviceLine(device)}
                        className={`text-xs ${revoked ? 'text-muted' : ''}`}
                      />
                    </p>
                    <p className="text-xs text-muted tabular-nums">
                      {platformOf(device.platform)}
                      {device.hub_local ? '・中枢と同じマシン' : ''}・登録{' '}
                      {clockOf(device.registered_at, now, { date: true })}・
                      {device.revoked_at !== null
                        ? `失効 ${clockOf(device.revoked_at, now, { date: true })}`
                        : device.last_seen_at !== null
                          ? `最終接続 ${clockOf(device.last_seen_at, now)}`
                          : '最終接続 なし'}
                    </p>
                  </div>
                  {ref !== null ? (
                    <div className="shrink-0">
                      <Button
                        variant="danger-soft"
                        size="sm"
                        isDisabled={busy}
                        aria-label={`「${device.device_name}」を失効する`}
                        onPress={() =>
                          onAsk({
                            title: `「${device.device_name}」（${platformOf(device.platform)}・${clockOf(device.registered_at, now, { date: true })} の登録）を失効しますか`,
                            body: (
                              <p className="text-sm leading-6">
                                失効すると、その端末はすぐに切断され、元に戻せません。もう一度使うには、端末側で登録し直します。他の端末には影響しません。
                              </p>
                            ),
                            confirmLabel: HUB_LABELS.revoke,
                            tone: 'danger',
                            onConfirm: () =>
                              actions.revoke({ ref, name: device.device_name }),
                          })
                        }
                      >
                        {HUB_LABELS.revoke}
                      </Button>
                    </div>
                  ) : null}
                </div>
                {rowNotice === null ? null : <NoticeText notice={rowNotice} />}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

export type HubTab = 'device' | 'claims' | 'devices' | 'home';

export function HubTabs({
  state,
  actions,
  now,
  thisDevice,
  home,
  initialTab = 'claims',
}: {
  readonly state: HubViewState;
  readonly actions: HubActions;
  readonly now: number;
  // 「このマシンの接続」のタブの中身（中枢との接続の欄）。
  readonly thisDevice: ReactNode;
  // 「自宅のネットワーク」のタブの中身（B03-08。HomeNetworkPanel）。渡さなければタブを出さない。
  readonly home?: ReactNode;
  readonly initialTab?: HubTab;
}) {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [tab, setTab] = useState<HubTab>(initialTab);
  const claimCount = state.claims?.length ?? 0;
  const busy = state.pending !== null;
  const open = (
    <PairingOpenPanel
      key="open"
      session={state.session}
      sessionUsed={state.sessionUsed}
      busy={busy}
      now={now}
      notice={noticeAt(state.notice, 'claims', 'open')}
      actions={actions}
    />
  );
  const claims = (
    <ClaimsPanel
      key="claims"
      claims={state.claims}
      busy={busy}
      now={now}
      notice={state.notice}
      onAsk={setConfirm}
      actions={actions}
    />
  );
  return (
    <>
      <Tabs
        selectedKey={tab}
        onSelectionChange={(key) => {
          setTab(key as HubTab);
          // タブを切り替えたら、前のタブの操作の文言は消す。
          actions.clearNotice();
        }}
      >
        <Tabs.ListContainer>
          {/* タブは高さが 1 行分（h-8）なので折り返さない。4 つのタブが幅 640px でも 1 行に収まり、狭いときは
              HeroUI の一覧の横送りに任せる（B03-08 で「自宅のネットワーク」を足した）。 */}
          <Tabs.List aria-label="中枢の画面" className="whitespace-nowrap">
            <Tabs.Tab id="claims">
              {HUB_LABELS.claimsTitle}
              {claimCount > 0 ? `（${claimCount}）` : ''}
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="devices">
              {HUB_LABELS.devicesTitle}
              <Tabs.Indicator />
            </Tabs.Tab>
            {home === undefined ? null : (
              <Tabs.Tab id="home">
                {HUB_LABELS.homeTitle}
                <Tabs.Indicator />
              </Tabs.Tab>
            )}
            <Tabs.Tab id="device">
              {HUB_LABELS.thisMachine}
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="claims" className="flex flex-col gap-6 pt-4">
          {claimCount > 0 ? [claims, open] : [open, claims]}
        </Tabs.Panel>
        <Tabs.Panel id="devices" className="flex flex-col gap-6 pt-4">
          <DevicesPanel
            devices={state.devices}
            busy={busy}
            now={now}
            notice={state.notice}
            onAsk={setConfirm}
            actions={actions}
          />
        </Tabs.Panel>
        {home === undefined ? null : (
          <Tabs.Panel id="home" className="flex flex-col gap-6 pt-4">
            {home}
          </Tabs.Panel>
        )}
        <Tabs.Panel id="device" className="flex flex-col gap-6 pt-4">
          {thisDevice}
        </Tabs.Panel>
      </Tabs>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
