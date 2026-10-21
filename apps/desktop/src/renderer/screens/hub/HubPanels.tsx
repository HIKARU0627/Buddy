// 中枢の画面の端末だけに出す「承認待ちの申請」「登録済みの端末」の欄（設計 02 端末登録と接続、ADR 0024・0026）。
// 承認・拒否・失効は重い操作として、確認（ConfirmDialog）を挟んでから送る。状態と操作は引数で受け取り、
// 限定 API を直接呼ばない。画面に来るのは main の参照（ref）と表示用の値だけで、ID・コード・秘密・トークンはない。
import { useState } from 'react';
import { Alert, Button, Card, Chip } from '@heroui/react';
import type {
  DesktopClaimEntry,
  DesktopDeviceEntry,
  DesktopPairingSession,
} from '@buddy/contracts';
import { PanelTitle } from '../../components/PanelTitle.js';
import {
  PLATFORM_LABELS,
  formatClaimCheck,
  formatFingerprint,
  formatObservedAt,
} from '../../labels.js';
import type { HubActions, HubViewState } from '../../state/hub-state.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import type { ConfirmRequest } from './ConfirmDialog.js';

export const HUB_LABELS = {
  claimsTitle: '承認待ちの申請',
  devicesTitle: '登録済みの端末',
  noClaims: '承認待ちの申請はありません。',
  loading: '読み込んでいます…',
  approve: '承認する',
  reject: '拒否する',
  revoke: '失効する',
  refresh: '一覧を取り直す',
  openTitle: '新しい端末を登録する',
  open: 'ペアリングを始める（コードを出す）',
  reopen: 'コードを出し直す',
} as const;

export function PairingOpenPanel({
  session,
  busy,
  actions,
}: {
  readonly session: DesktopPairingSession | null;
  readonly busy: boolean;
  readonly actions: HubActions;
}) {
  return (
    <section aria-label={HUB_LABELS.openTitle}>
      <Card>
        <Card.Header>
          <PanelTitle>{HUB_LABELS.openTitle}</PanelTitle>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3">
          {session === null ? (
            <p className="text-sm">
              登録する端末でペアリングを始める前に、ここでワンタイムコードを出します（有効
              5 分・5 回まで）。
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-sm">
                登録する端末に、このコードを入力してもらいます。端末の画面の指紋が下の指紋と同じことも確かめてもらってください。
              </p>
              <p
                aria-label="ワンタイムコード"
                className="font-mono text-3xl tracking-widest"
              >
                {session.pairing_code.slice(0, 4)}{' '}
                {session.pairing_code.slice(4)}
              </p>
              <p className="text-sm text-muted">
                期限 {formatObservedAt(session.expires_at)}
              </p>
              <p
                aria-label="中枢の証明書の指紋（SHA-256）"
                className="break-all rounded-md border border-border p-3 font-mono text-sm"
              >
                {formatFingerprint(session.certificate_fingerprint)}
              </p>
            </div>
          )}
          <div>
            <Button
              variant={session === null ? 'primary' : 'secondary'}
              isDisabled={busy}
              onPress={actions.openPairing}
            >
              {session === null ? HUB_LABELS.open : HUB_LABELS.reopen}
            </Button>
          </div>
        </Card.Content>
      </Card>
    </section>
  );
}

function platformOf(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

export function ClaimsPanel({
  claims,
  busy,
  onAsk,
  actions,
}: {
  readonly claims: readonly DesktopClaimEntry[] | null;
  readonly busy: boolean;
  readonly onAsk: (request: ConfirmRequest) => void;
  readonly actions: HubActions;
}) {
  return (
    <section aria-label={HUB_LABELS.claimsTitle}>
      <Card>
        <Card.Header className="flex flex-row flex-wrap items-center justify-between gap-2">
          <PanelTitle>{HUB_LABELS.claimsTitle}</PanelTitle>
          <Button size="sm" variant="tertiary" onPress={actions.refreshClaims}>
            {HUB_LABELS.refresh}
          </Button>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            申請した端末の画面に出ている確認コードと同じか確かめてから承認してください。
          </p>
          {claims === null ? (
            <p className="text-sm text-muted">{HUB_LABELS.loading}</p>
          ) : claims.length === 0 ? (
            <p className="text-sm text-muted">{HUB_LABELS.noClaims}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {claims.map((claim) => (
                <li
                  key={claim.ref}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="font-medium break-words">
                      {claim.device_name}
                      <span className="ml-2 text-sm text-muted">
                        {platformOf(claim.platform)}
                      </span>
                    </p>
                    <p className="text-sm">
                      確認コード{' '}
                      <span className="font-mono text-base tracking-wider">
                        {formatClaimCheck(claim.claim_check)}
                      </span>
                    </p>
                    <p className="text-sm text-muted">
                      申請 {formatObservedAt(claim.claimed_at)}・期限{' '}
                      {formatObservedAt(claim.expires_at)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="primary"
                      isDisabled={busy}
                      onPress={() =>
                        onAsk({
                          title: `「${claim.device_name}」を承認しますか`,
                          body: (
                            <p>
                              確認コード{' '}
                              <span className="font-mono">
                                {formatClaimCheck(claim.claim_check)}
                              </span>{' '}
                              が申請した端末の画面と同じときだけ承認してください。承認すると、その端末はこの中枢に接続できるようになります。
                            </p>
                          ),
                          confirmLabel: HUB_LABELS.approve,
                          tone: 'accent',
                          onConfirm: () => actions.decide(claim.ref, 'approve'),
                        })
                      }
                    >
                      {HUB_LABELS.approve}
                    </Button>
                    <Button
                      variant="secondary"
                      isDisabled={busy}
                      onPress={() =>
                        onAsk({
                          title: `「${claim.device_name}」の申請を拒否しますか`,
                          body: (
                            <p>
                              拒否した申請は使えなくなります。登録するには、端末側でペアリングを最初からやり直します。
                            </p>
                          ),
                          confirmLabel: HUB_LABELS.reject,
                          tone: 'danger',
                          onConfirm: () => actions.decide(claim.ref, 'reject'),
                        })
                      }
                    >
                      {HUB_LABELS.reject}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card.Content>
      </Card>
    </section>
  );
}

function deviceStatus(device: DesktopDeviceEntry) {
  if (device.revoked_at !== null)
    return (
      <Chip color="danger" variant="soft">
        × 失効済み
      </Chip>
    );
  if (device.this_device)
    return (
      <Chip color="accent" variant="soft">
        この端末
      </Chip>
    );
  return (
    <Chip color="success" variant="soft">
      ● 有効
    </Chip>
  );
}

export function DevicesPanel({
  devices,
  busy,
  onAsk,
  actions,
}: {
  readonly devices: readonly DesktopDeviceEntry[] | null;
  readonly busy: boolean;
  readonly onAsk: (request: ConfirmRequest) => void;
  readonly actions: HubActions;
}) {
  return (
    <section aria-label={HUB_LABELS.devicesTitle}>
      <Card>
        <Card.Header className="flex flex-row flex-wrap items-center justify-between gap-2">
          <PanelTitle>{HUB_LABELS.devicesTitle}</PanelTitle>
          <Button size="sm" variant="tertiary" onPress={actions.refreshDevices}>
            {HUB_LABELS.refresh}
          </Button>
        </Card.Header>
        <Card.Content>
          {devices === null ? (
            <p className="text-sm text-muted">{HUB_LABELS.loading}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {devices.map((device, index) => (
                <li
                  key={device.ref ?? `fixed-${index}`}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <span className="break-words">{device.device_name}</span>
                      {deviceStatus(device)}
                    </p>
                    <p className="text-sm text-muted">
                      {platformOf(device.platform)}
                      {device.hub_local ? '・中枢と同じマシン' : ''}・登録{' '}
                      {formatObservedAt(device.registered_at)}
                    </p>
                    <p className="text-sm text-muted">
                      {device.revoked_at !== null
                        ? `失効 ${formatObservedAt(device.revoked_at)}`
                        : device.last_seen_at !== null
                          ? `最終接続 ${formatObservedAt(device.last_seen_at)}`
                          : '最終接続 なし'}
                    </p>
                  </div>
                  {device.ref !== null ? (
                    <div className="shrink-0">
                      <Button
                        variant="danger-soft"
                        isDisabled={busy}
                        onPress={() => {
                          const ref = device.ref;
                          if (ref === null) return;
                          onAsk({
                            title: `「${device.device_name}」を失効しますか`,
                            body: (
                              <p>
                                失効すると、その端末はすぐに切断され、元に戻せません。もう一度使うには、端末側でペアリングをやり直します。他の端末には影響しません。
                              </p>
                            ),
                            confirmLabel: HUB_LABELS.revoke,
                            tone: 'danger',
                            onConfirm: () => actions.revoke(ref),
                          });
                        }}
                      >
                        {HUB_LABELS.revoke}
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card.Content>
      </Card>
    </section>
  );
}

export function HubPanels({
  state,
  actions,
}: {
  readonly state: HubViewState;
  readonly actions: HubActions;
}) {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  return (
    <>
      {state.message !== null ? (
        <Alert status="warning" role="alert">
          <Alert.Content>
            <Alert.Title>⚠ {state.message}</Alert.Title>
          </Alert.Content>
        </Alert>
      ) : null}
      <PairingOpenPanel
        session={state.session}
        busy={state.busy}
        actions={actions}
      />
      <ClaimsPanel
        claims={state.claims}
        busy={state.busy}
        onAsk={setConfirm}
        actions={actions}
      />
      <DevicesPanel
        devices={state.devices}
        busy={state.busy}
        onAsk={setConfirm}
        actions={actions}
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
