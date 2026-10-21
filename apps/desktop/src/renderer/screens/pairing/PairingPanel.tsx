// ペアリングの欄（設計 02 端末登録と接続、ADR 0021・0024・0025）。
//   宛先の入力 → 中枢の証明書の指紋の表示 →（本人が中枢の画面・CLI の指紋と比べて）「一致」
//   → ワンタイムコードと端末名の入力 → 申請 → 中枢での承認を待つ → 登録（main がトークンを safeStorage に保存）
// 「一致」を押すまで main は申請を送らない。画面は手順・指紋・期限・失敗の理由だけを受け取り、トークン・申請用の
// 秘密を持たない。状態と操作は引数で受け取り、限定 API を直接呼ばない。
import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Description,
  Input,
  Label,
  TextField,
} from '@heroui/react';
import { PanelTitle } from '../../components/PanelTitle.js';
import {
  PAIRING_FAILURE_LABELS,
  PAIRING_STEP_LABELS,
  formatFingerprint,
  formatObservedAt,
} from '../../labels.js';
import {
  DEFAULT_HUB_PORT,
  normalizeCode,
  normalizeDeviceName,
  normalizeHost,
  parsePort,
} from '../../state/connection-state.js';
import type {
  PairingActions,
  PairingView,
  ShownConnection,
} from '../../state/connection-state.js';

export const PAIRING_LABELS = {
  title: 'この端末を中枢に登録する',
  host: '中枢の宛先（Tailscale の IP アドレスか名前）',
  port: 'ポート',
  begin: '中枢の証明書を受け取る',
  fingerprintIntro:
    '中枢の画面（または buddy-core first-device start の出力）に出ている指紋と、下の指紋が 64 桁すべて同じか確かめてください。',
  match: '✓ 一致（申請に進む）',
  mismatch: '一致しない（やめる）',
  code: 'ワンタイムコード（8 桁）',
  deviceName: 'この端末の名前',
  submit: '申請する',
  cancel: 'やめる',
  retry: '最初からやり直す',
} as const;

function StartForm({ actions }: { readonly actions: PairingActions }) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState(String(DEFAULT_HUB_PORT));
  const parsedHost = normalizeHost(host);
  const parsedPort = parsePort(port);
  return (
    <div className="flex flex-col gap-3">
      <TextField value={host} onChange={setHost} isRequired>
        <Label>{PAIRING_LABELS.host}</Label>
        <Input placeholder="100.64.0.1" />
        <Description>URL やパスは入れません。</Description>
      </TextField>
      <TextField value={port} onChange={setPort} isRequired>
        <Label>{PAIRING_LABELS.port}</Label>
        <Input inputMode="numeric" />
      </TextField>
      <div>
        <Button
          variant="primary"
          isDisabled={parsedHost === null || parsedPort === null}
          onPress={() => {
            if (parsedHost !== null && parsedPort !== null)
              actions.begin(parsedHost, parsedPort);
          }}
        >
          {PAIRING_LABELS.begin}
        </Button>
      </div>
    </div>
  );
}

export function FingerprintCheck({
  pairing,
  actions,
}: {
  readonly pairing: PairingView;
  readonly actions: PairingActions;
}) {
  const fingerprint = pairing.fingerprint ?? '';
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">{PAIRING_LABELS.fingerprintIntro}</p>
      <p className="text-sm text-muted">
        宛先: {pairing.host}:{pairing.port}
      </p>
      <p
        aria-label="中枢の証明書の指紋（SHA-256）"
        className="break-all rounded-md border border-border p-3 font-mono text-base"
      >
        {formatFingerprint(fingerprint)}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onPress={() => actions.confirm(fingerprint)}>
          {PAIRING_LABELS.match}
        </Button>
        <Button variant="secondary" onPress={actions.cancel}>
          {PAIRING_LABELS.mismatch}
        </Button>
      </div>
    </div>
  );
}

function CodeEntry({ actions }: { readonly actions: PairingActions }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const parsedCode = normalizeCode(code);
  const parsedName = normalizeDeviceName(name);
  return (
    <div className="flex flex-col gap-3">
      <TextField value={code} onChange={setCode} isRequired>
        <Label>{PAIRING_LABELS.code}</Label>
        <Input inputMode="numeric" autoComplete="one-time-code" />
        <Description>
          中枢の画面に出ているコード。有効 5 分・5 回まで。
        </Description>
      </TextField>
      <TextField value={name} onChange={setName} isRequired>
        <Label>{PAIRING_LABELS.deviceName}</Label>
        <Input maxLength={40} />
      </TextField>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          isDisabled={parsedCode === null || parsedName === null}
          onPress={() => {
            if (parsedCode !== null && parsedName !== null)
              actions.submit(parsedCode, parsedName);
          }}
        >
          {PAIRING_LABELS.submit}
        </Button>
        <Button variant="secondary" onPress={actions.cancel}>
          {PAIRING_LABELS.cancel}
        </Button>
      </div>
    </div>
  );
}

function Progress({
  pairing,
  actions,
}: {
  readonly pairing: PairingView;
  readonly actions: PairingActions;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="text-sm">
        {PAIRING_STEP_LABELS[pairing.step]}
      </p>
      {pairing.claim_expires_at !== null ? (
        <p className="text-sm text-muted">
          申請の期限: {formatObservedAt(pairing.claim_expires_at)}
        </p>
      ) : null}
      <div>
        <Button variant="secondary" onPress={actions.cancel}>
          {PAIRING_LABELS.cancel}
        </Button>
      </div>
    </div>
  );
}

export function Failed({
  pairing,
  actions,
}: {
  readonly pairing: PairingView;
  readonly actions: PairingActions;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Alert status="danger" role="alert">
        <Alert.Content>
          <Alert.Title>{PAIRING_STEP_LABELS.failed}</Alert.Title>
          {pairing.failure !== null ? (
            <Alert.Description>
              {PAIRING_FAILURE_LABELS[pairing.failure]}
            </Alert.Description>
          ) : null}
        </Alert.Content>
      </Alert>
      <div>
        <Button variant="secondary" onPress={actions.cancel}>
          {PAIRING_LABELS.retry}
        </Button>
      </div>
    </div>
  );
}

export function PairingPanel({
  connection,
  actions,
}: {
  readonly connection: ShownConnection;
  readonly actions: PairingActions;
}) {
  const pairing = connection.pairing;
  let body;
  if (connection.registration === 'secure_storage_unavailable')
    body = (
      <Alert status="danger" role="alert">
        <Alert.Content>
          <Alert.Title>
            この端末では安全な保存（OS の鍵束）が使えないため、登録できません。
          </Alert.Title>
        </Alert.Content>
      </Alert>
    );
  else if (pairing === null) body = <StartForm actions={actions} />;
  else if (pairing.step === 'fingerprint_check')
    body = <FingerprintCheck pairing={pairing} actions={actions} />;
  else if (pairing.step === 'code_entry')
    body = <CodeEntry actions={actions} />;
  else if (pairing.step === 'failed')
    body = <Failed pairing={pairing} actions={actions} />;
  else body = <Progress pairing={pairing} actions={actions} />;
  return (
    <section aria-label="ペアリング">
      <Card>
        <Card.Header>
          <PanelTitle>{PAIRING_LABELS.title}</PanelTitle>
        </Card.Header>
        <Card.Content>{body}</Card.Content>
      </Card>
    </section>
  );
}
