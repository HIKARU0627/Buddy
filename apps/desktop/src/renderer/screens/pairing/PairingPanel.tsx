// 登録のフォーム（設計 02 端末登録と接続、ADR 0021・0024・0025）。今の段階を「手順 n / 4」で示す。
//   1 宛先 → 2 指紋の確認（4 桁ずつ 4 行の指紋を見比べ、この画面では伏せた最後の 4 桁を中枢の画面から読んで入力する。合うときだけ次へ）
//   → 3 コードの入力（8 桁）→ 4 承認待ち（中枢の画面で承認する。確認コードを見比べる）→ 登録（main が safeStorage に保存）
// 4 桁が合うかは main が受け取った証明書の指紋と比べて決め、合わなければ申請を送らない。画面はトークン・申請用の秘密を持たない。
// 押せないボタンは置かず、押したときに理由を欄の下に出す。状態と操作は引数で受け取り、限定 API を直接呼ばない。
import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Description,
  FieldError,
  Input,
  InputOTP,
  Label,
  Spinner,
  TextField,
} from '@heroui/react';
import { FingerprintGrid } from '../../components/FingerprintGrid.js';
import { clockOf, remainingOf, splitInFour } from '../../format.js';
import { AlertIcon } from '../../components/AlertIcon.js';
import {
  PAIRING_STEPS,
  PAIRING_STEP_COUNT,
  pairingFailureCopy,
} from '../../labels.js';
import {
  DEFAULT_HUB_PORT,
  normalizeCode,
  normalizeDeviceName,
  normalizeHost,
  normalizeTail,
  parsePort,
} from '../../state/connection-state.js';
import type {
  PairingActions,
  PairingView,
  ShownConnection,
} from '../../state/connection-state.js';

export const PAIRING_LABELS = {
  title: 'この端末を中枢に登録する',
  host: '中枢の宛先',
  hostHelp:
    'Tailscale のアドレス（100.x.x.x）か、〜.ts.net の名前です。https:// やパスは付けず、宛先だけを入れます。',
  hostPlaceholder: '例: 100.64.0.1',
  hostInvalid: '宛先を入れてください（例: 100.64.0.1）。',
  port: 'ポート',
  portInvalid: '1〜65535 の数字にしてください。',
  begin: '中枢の証明書を受け取る',
  fetching: '中枢の証明書を受け取っています',
  compare:
    '中枢の画面の「新しい端末を登録する」に出ている指紋と、1\u00a0行ずつ見比べてください（中枢の画面で「ペアリングを始める」を押すと、指紋が表示されます）。',
  beforeStart:
    '先に中枢の画面の「端末の登録」で「ペアリングを始める（コードを出す）」を押してください。宛先・指紋・コードはそこに出ます。',
  masked:
    '最後の 4\u00a0桁はこの画面では伏せています。中枢の画面から読んで入力してください。',
  cliNote:
    'buddy-core first-device start の出力にも、同じ 4\u00a0桁区切り・4\u00a0行の指紋が出ます。',
  tail: '中枢の画面の指紋の最後の 4\u00a0桁',
  tailInvalid: '指紋の最後の 4\u00a0桁（0〜9・a〜f）を入れてください。',
  tailNote:
    '中枢の画面の指紋の最後の組です。一致しないときは申請を送りません。',
  confirm: '最後の 4\u00a0桁を確かめて次へ',
  mismatch: '一致しない（やめる）',
  code: 'ワンタイムコード',
  codeHelp:
    '中枢の画面に出ている 8\u00a0桁の数字です。5\u00a0分で切れ、入力は 5\u00a0回までです。',
  codeInvalid: '8\u00a0桁の数字を入れてください。',
  deviceName: 'この端末の名前',
  deviceNameInvalid: '1〜40\u00a0文字で入れてください。',
  submit: '申請する',
  cancel: 'やめる',
  claiming: '申請しています',
  waiting: '中枢での承認を待っています',
  withdraw: '申請をやめる',
} as const;

function StepLabel({ step }: { readonly step: keyof typeof PAIRING_STEPS }) {
  const { index, name } = PAIRING_STEPS[step];
  return (
    <p className="text-sm text-muted tabular-nums">
      手順 {index} / {PAIRING_STEP_COUNT}
      <span className="ml-3">{name}</span>
    </p>
  );
}

function Progress({ text }: { readonly text: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm leading-6">
      <Spinner size="sm" color="current" aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}

export function AddressStep({
  initialHost,
  initialPort,
  fetching,
  message,
  hostRejected,
  actions,
}: {
  readonly initialHost: string;
  readonly initialPort: number;
  readonly fetching: boolean;
  readonly message: string | null;
  // main が宛先を受け付けなかった（Tailscale のアドレス・名前でない）。
  readonly hostRejected: string | null;
  readonly actions: PairingActions;
}) {
  const [host, setHost] = useState(initialHost);
  const [port, setPort] = useState(String(initialPort));
  const [tried, setTried] = useState(false);
  const parsedHost = normalizeHost(host);
  const parsedPort = parsePort(port);
  const hostError =
    tried && parsedHost === null ? PAIRING_LABELS.hostInvalid : hostRejected;
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose text-sm leading-6">
        {PAIRING_LABELS.beforeStart}
      </p>
      <div className="flex flex-wrap items-start gap-4">
        <TextField
          className="min-w-48 flex-1"
          value={host}
          onChange={setHost}
          isRequired
          isInvalid={hostError !== null}
        >
          <Label>{PAIRING_LABELS.host}</Label>
          <Input
            variant="secondary"
            className="font-mono"
            placeholder={PAIRING_LABELS.hostPlaceholder}
          />
          <Description>{PAIRING_LABELS.hostHelp}</Description>
          <FieldError>{hostError}</FieldError>
        </TextField>
        <TextField
          className="w-28"
          value={port}
          onChange={setPort}
          isRequired
          isInvalid={tried && parsedPort === null}
        >
          <Label>{PAIRING_LABELS.port}</Label>
          <Input
            variant="secondary"
            className="font-mono tabular-nums"
            inputMode="numeric"
          />
          <FieldError>{PAIRING_LABELS.portInvalid}</FieldError>
        </TextField>
      </div>
      {fetching ? (
        <Progress text={`${PAIRING_LABELS.fetching}…`} />
      ) : (
        <div className="flex flex-col gap-1">
          <div>
            <Button
              variant="primary"
              onPress={() => {
                setTried(true);
                if (parsedHost !== null && parsedPort !== null)
                  actions.begin(parsedHost, parsedPort);
              }}
            >
              {PAIRING_LABELS.begin}
            </Button>
          </div>
          {message === null ? null : (
            <p role="alert" className="text-sm text-warning-soft-foreground">
              {message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function FingerprintStep({
  pairing,
  tailRejected,
  message,
  actions,
}: {
  readonly pairing: PairingView;
  // main が 4 桁を合わないとして拒否した（中枢の画面の指紋と違う）。
  readonly tailRejected: string | null;
  readonly message: string | null;
  readonly actions: PairingActions;
}) {
  const [tail, setTail] = useState('');
  const [tried, setTried] = useState(false);
  const parsed = normalizeTail(tail);
  const fingerprint = pairing.fingerprint ?? '';
  const formatError =
    tried && parsed === null ? PAIRING_LABELS.tailInvalid : null;
  const error = formatError ?? tailRejected;
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose text-sm leading-6">{PAIRING_LABELS.compare}</p>
      <p className="text-sm text-muted">
        宛先:{' '}
        <span className="font-mono">
          {pairing.host}:{pairing.port}
        </span>
      </p>
      <FingerprintGrid
        fingerprint={fingerprint}
        id="pairing-fingerprint"
        maskLast
        note={PAIRING_LABELS.masked}
      />
      <p className="text-xs text-muted">{PAIRING_LABELS.cliNote}</p>
      <div className="flex flex-col gap-1">
        <Label id="pairing-tail-label" isRequired>
          {PAIRING_LABELS.tail}
        </Label>
        <InputOTP
          maxLength={4}
          value={tail}
          onChange={(value) => setTail(value.toLowerCase())}
          autoComplete="off"
          pattern="^[0-9a-fA-F]*$"
          aria-labelledby="pairing-tail-label"
          aria-describedby="pairing-tail-help"
          aria-required="true"
          isInvalid={error !== null}
          noScriptCSSFallback={null}
        >
          <InputOTP.Group>
            {[0, 1, 2, 3].map((index) => (
              <InputOTP.Slot key={index} index={index} className="font-mono" />
            ))}
          </InputOTP.Group>
        </InputOTP>
        <p id="pairing-tail-help" className="text-xs leading-5 text-muted">
          {PAIRING_LABELS.tailNote}
        </p>
        {formatError === null ? null : (
          <p role="alert" className="text-sm text-danger-soft-foreground">
            {formatError}
          </p>
        )}
      </div>
      {formatError === null && tailRejected !== null ? (
        <Alert status="warning" role="alert">
          <Alert.Indicator>
            <AlertIcon />
          </Alert.Indicator>
          <Alert.Content>
            <Alert.Description className="text-sm leading-6 text-foreground">
              {tailRejected}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onPress={() => {
            setTried(true);
            if (parsed !== null) actions.confirm(fingerprint, parsed);
          }}
        >
          {PAIRING_LABELS.confirm}
        </Button>
        <Button variant="secondary" onPress={actions.cancel}>
          {PAIRING_LABELS.mismatch}
        </Button>
      </div>
      {message === null ? null : (
        <p role="alert" className="text-sm text-warning-soft-foreground">
          {message}
        </p>
      )}
    </div>
  );
}

export function CodeStep({
  claiming,
  message,
  actions,
}: {
  readonly claiming: boolean;
  readonly message: string | null;
  readonly actions: PairingActions;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [tried, setTried] = useState(false);
  const parsedCode = normalizeCode(code);
  const parsedName = normalizeDeviceName(name);
  const codeInvalid = tried && parsedCode === null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label id="pairing-code-label" isRequired>
          {PAIRING_LABELS.code}
        </Label>
        <InputOTP
          maxLength={8}
          value={code}
          onChange={setCode}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="^[0-9]*$"
          aria-labelledby="pairing-code-label"
          aria-describedby="pairing-code-help"
          aria-required="true"
          isInvalid={codeInvalid}
          noScriptCSSFallback={null}
        >
          <InputOTP.Group>
            {[0, 1, 2, 3].map((index) => (
              <InputOTP.Slot key={index} index={index} />
            ))}
          </InputOTP.Group>
          <InputOTP.Separator />
          <InputOTP.Group>
            {[4, 5, 6, 7].map((index) => (
              <InputOTP.Slot key={index} index={index} />
            ))}
          </InputOTP.Group>
        </InputOTP>
        <p id="pairing-code-help" className="text-xs leading-5 text-muted">
          {PAIRING_LABELS.codeHelp}
        </p>
        {codeInvalid ? (
          <p className="text-xs text-danger-soft-foreground">
            {PAIRING_LABELS.codeInvalid}
          </p>
        ) : null}
      </div>
      <TextField
        className="max-w-sm"
        value={name}
        onChange={setName}
        isRequired
        isInvalid={tried && parsedName === null}
      >
        <Label>{PAIRING_LABELS.deviceName}</Label>
        <Input variant="secondary" maxLength={40} />
        <FieldError>{PAIRING_LABELS.deviceNameInvalid}</FieldError>
      </TextField>
      {claiming ? (
        <Progress text={`${PAIRING_LABELS.claiming}…`} />
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onPress={() => {
                setTried(true);
                if (parsedCode !== null && parsedName !== null)
                  actions.submit(parsedCode, parsedName);
              }}
            >
              {PAIRING_LABELS.submit}
            </Button>
            <Button variant="tertiary" onPress={actions.cancel}>
              {PAIRING_LABELS.cancel}
            </Button>
          </div>
          {message === null ? null : (
            <p role="alert" className="text-sm text-warning-soft-foreground">
              {message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function WaitingStep({
  pairing,
  deviceName,
  now,
  actions,
}: {
  readonly pairing: PairingView;
  readonly deviceName: string | null;
  readonly now: number;
  readonly actions: PairingActions;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Progress text={`${PAIRING_LABELS.waiting}…`} />
      <p className="max-w-prose text-sm leading-6">
        中枢の画面で「{deviceName ?? 'この端末'}
        」の申請を承認してください。
      </p>
      {pairing.claim_check === null ? null : (
        <div className="flex flex-col gap-1">
          <p className="text-sm">確認コード</p>
          <p className="font-mono text-2xl font-semibold tracking-wider tabular-nums">
            {splitInFour(pairing.claim_check)}
          </p>
          <p className="max-w-prose text-xs leading-5 text-muted">
            中枢の画面の「承認待ちの申請」に、同じ確認コードの申請があることを確かめてから承認してください。
          </p>
        </div>
      )}
      {pairing.claim_expires_at === null ? null : (
        <p className="text-sm text-muted tabular-nums">
          {clockOf(pairing.claim_expires_at, now, { seconds: false })} まで（
          {remainingOf(pairing.claim_expires_at, now)}）
        </p>
      )}
      <div>
        {/* 受取りの要求の最中は押せない（main は受取りの結果を捨てない。ADR 0025）。 */}
        <Button
          variant="secondary"
          isDisabled={!pairing.cancelable}
          onPress={actions.cancel}
        >
          {PAIRING_LABELS.withdraw}
        </Button>
      </div>
    </div>
  );
}

export function FailedStep({
  pairing,
  deviceName,
  actions,
}: {
  readonly pairing: PairingView;
  readonly deviceName: string | null;
  readonly actions: PairingActions;
}) {
  const copy = pairingFailureCopy(pairing.failure ?? 'protocol_error', {
    target: `${pairing.host}:${pairing.port}`,
    deviceName,
  });
  return (
    <div className="flex flex-col gap-4">
      <Alert status={copy.severity} role="alert">
        <Alert.Indicator>
          <AlertIcon />
        </Alert.Indicator>
        <Alert.Content>
          <Alert.Title>{copy.title}</Alert.Title>
          <Alert.Description className="text-sm leading-6 text-foreground">
            {copy.subject === null ? null : (
              <span className="font-mono">{copy.subject}</span>
            )}
            {copy.body}
          </Alert.Description>
        </Alert.Content>
      </Alert>
      <div>
        <Button variant="secondary" onPress={actions.cancel}>
          {copy.action}
        </Button>
      </div>
    </div>
  );
}

function stepOf(pairing: PairingView | null): keyof typeof PAIRING_STEPS {
  if (pairing?.step === 'failed')
    return pairingFailureCopy(pairing.failure ?? 'protocol_error', {
      target: null,
      deviceName: null,
    }).step;
  switch (pairing?.step) {
    case 'fingerprint_check':
      return 'fingerprint';
    case 'code_entry':
    case 'claiming':
      return 'code';
    case 'waiting_approval':
      return 'waiting';
    default:
      return 'address';
  }
}

export function PairingPanel({
  connection,
  actions,
  initialHost,
  initialPort,
  deviceName,
  now,
  message,
  tailRejected,
  hostRejected,
}: {
  readonly connection: ShownConnection;
  readonly actions: PairingActions;
  readonly initialHost: string;
  readonly initialPort: number;
  readonly deviceName: string | null;
  readonly now: number;
  // 登録の操作の拒否の文言（押したボタンのすぐ下に出す）。
  readonly message: string | null;
  readonly tailRejected: string | null;
  readonly hostRejected: string | null;
}) {
  const pairing = connection.pairing;
  let body;
  if (connection.registration === 'secure_storage_unavailable') {
    const copy = pairingFailureCopy('secure_storage_unavailable', {
      target: null,
      deviceName: null,
    });
    body = (
      <Alert status={copy.severity} role="alert">
        <Alert.Indicator>
          <AlertIcon />
        </Alert.Indicator>
        <Alert.Content>
          <Alert.Title>{copy.title}</Alert.Title>
          <Alert.Description className="text-sm leading-6 text-foreground">
            {copy.body}
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  } else if (pairing === null || pairing.step === 'fetching_certificate')
    body = (
      <AddressStep
        initialHost={initialHost}
        initialPort={initialPort}
        fetching={pairing !== null}
        message={message}
        hostRejected={hostRejected}
        actions={actions}
      />
    );
  else if (pairing.step === 'fingerprint_check')
    body = (
      <FingerprintStep
        pairing={pairing}
        tailRejected={tailRejected}
        message={message}
        actions={actions}
      />
    );
  else if (pairing.step === 'code_entry' || pairing.step === 'claiming')
    body = (
      <CodeStep
        claiming={pairing.step === 'claiming'}
        message={message}
        actions={actions}
      />
    );
  else if (pairing.step === 'waiting_approval')
    body = (
      <WaitingStep
        pairing={pairing}
        deviceName={deviceName}
        now={now}
        actions={actions}
      />
    );
  else
    body = (
      <FailedStep pairing={pairing} deviceName={deviceName} actions={actions} />
    );
  return (
    <Card>
      <Card.Header className="flex flex-col gap-1">
        <h2 id="pairing-heading" className="text-base font-semibold">
          {PAIRING_LABELS.title}
        </h2>
        {connection.registration === 'secure_storage_unavailable' ? null : (
          <StepLabel step={stepOf(pairing)} />
        )}
      </Card.Header>
      <Card.Content>
        <section aria-labelledby="pairing-heading">{body}</section>
      </Card.Content>
    </Card>
  );
}

export { DEFAULT_HUB_PORT };
