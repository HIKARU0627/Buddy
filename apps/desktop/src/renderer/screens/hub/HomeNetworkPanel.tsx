// 中枢の画面の「自宅のネットワーク」のタブ（設計 11 §10、ADR 0022・0024・0026、B03-08）。
// 上から「説明 → 登録している自宅 → このマシンが今つながっているネットワーク（伏せた表示・登録のボタン）」。
// 登録・登録し直しは確認（ConfirmDialog）を挟んでから送る。画面に来るのは伏せた表示と main の参照だけで、
// MAC・SSID の値はない。タブを開いたときに main へ読み取りを頼む。状態と操作は引数で受け取り、限定 API を直接呼ばない。
// UI レビュー 2 回目の約束（ADR 0024 の追記）: 失敗の Alert は warning（danger は証明書の変化だけ）で記号を付ける。
// 操作の結果の文言は押したボタンのすぐ下に出す。確認のダイアログでは、確かめる値を大きな等幅で別の段に出す。
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  CloseButton,
  Description,
  Label,
  Spinner,
} from '@heroui/react';
import type {
  DesktopHomeObservation,
  HomeRegistration,
} from '@buddy/contracts';
import { AlertIcon } from '../../components/AlertIcon.js';
import { Section } from '../../components/Section.js';
import { StatusMark, StatusText } from '../../components/StatusText.js';
import { clockOf } from '../../format.js';
import type { HomeActions, HomeViewState } from '../../state/home-state.js';
import type { StatusLine } from '../../tones.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import type { ConfirmRequest } from './ConfirmDialog.js';

export const HOME_LABELS = {
  tab: '自宅のネットワーク',
  intro:
    '中枢と別のマシンの端末は、ここで登録した自宅のネットワークにつながっていて、Tailscale で直接つながっているときだけ中枢に接続できます。この画面（中枢と同じマシン）は判定を受けません。',
  registrationTitle: '登録している自宅',
  currentTitle: 'このマシンが今つながっているネットワーク',
  loading: '読み込んでいます…',
  reading: '読み取っています…',
  reread: '読み取り直す',
  register: 'このネットワークを自宅として登録する',
  reregister: '今のネットワークで登録し直す',
  unregisteredBody:
    'まだ自宅を登録していません。登録するまで、中枢と別のマシンの端末は接続できません。',
  hashNote:
    'ルーターの MAC アドレスと Wi-Fi 名は、照合用の値（HMAC）だけを中枢に保存しています。元の値は表示できません。',
  readFailedTitle: 'このマシンのネットワークを読み取れませんでした',
  readFailedBody:
    'ネットワークにつながっているかを確かめてから、「読み取り直す」を押してください。',
  notRegistrable:
    'ルーターの MAC とサブネットの両方が読み取れないと登録できません。ネットワークにつながっているかを確かめてから、読み取り直してください。',
  noSsid:
    'このマシンの Wi-Fi 名を読み取れないため、Wi-Fi 名なしで登録します。判定では、ルーターの MAC アドレス・サブネット・Tailscale の直接経路を確かめます。',
  // Wi-Fi 名（SSID）も確かめるか（本人の判断 2026-10-22。既定は確かめる）。
  includeSsid: 'Wi-Fi 名（SSID）も確かめる',
  includeSsidOn:
    '端末の Wi-Fi 名が、このネットワークの Wi-Fi 名と同じときだけ通します（有線の端末は Wi-Fi 名を比べません）。',
  includeSsidOff:
    '切っても、ルーターの MAC アドレス・サブネット・Tailscale の直接経路は確かめます。',
  ssidChecked: '確かめる（登録した Wi-Fi 名と比べます）',
  ssidNotChecked:
    '確かめない（ルーターの MAC アドレス・サブネット・Tailscale の直接経路で判定します）',
  doneTitle: '自宅のネットワークを登録しました。',
} as const;

const SSID_REASON_LABELS: Readonly<
  Record<NonNullable<DesktopHomeObservation['ssid_unavailable_reason']>, string>
> = {
  redacted:
    '読み取れません（macOS の位置情報の許可がないため伏せられています）',
  ambiguous: '決められません（無線の接続が複数あります）',
  unavailable: 'ありません（有線の接続、または読み取れません）',
};

const UNAVAILABLE: StatusLine = {
  tone: 'warning',
  mark: 'warning',
  text: '読み取れません',
};

function registrationLine(registration: HomeRegistration | null): StatusLine {
  return registration === null
    ? { tone: 'neutral', mark: 'square', text: '未登録' }
    : { tone: 'success', mark: 'dot', text: '登録済み' };
}

// ラベルと値の 2 列の表（幅が狭いときも同じ並び）。
function Rows({
  rows,
}: {
  readonly rows: readonly (readonly [string, ReactNode])[];
}) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm leading-6">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ゲートウェイの MAC の伏せた表示（最後の 2 組だけ）。読み上げでは伏せたことを言う。
function MaskedMac({
  tail,
  className = '',
}: {
  readonly tail: string;
  readonly className?: string;
}) {
  return (
    <>
      <span
        aria-hidden="true"
        className={`font-mono tabular-nums ${className}`}
      >
        ••:••:••:••:{tail}
      </span>
      <span className="sr-only">
        最後の 2 組が {tail}（ほかは伏せています）
      </span>
    </>
  );
}

// SSID の伏せた表示（先頭の 1 文字と文字数。3 文字以下は文字数だけ）。
function MaskedSsid({
  hint,
  className = '',
}: {
  readonly hint: NonNullable<DesktopHomeObservation['ssid_hint']>;
  readonly className?: string;
}) {
  const masked =
    hint.first === null
      ? '•'.repeat(hint.length)
      : `${hint.first}${'•'.repeat(hint.length - 1)}`;
  return (
    <>
      <span aria-hidden="true" className={`font-mono break-all ${className}`}>
        {masked}
      </span>{' '}
      <span className="text-muted tabular-nums">（{hint.length} 文字）</span>
      <span className="sr-only">
        {hint.first === null ? '' : `先頭が「${hint.first}」で、`}
        ほかは伏せています
      </span>
    </>
  );
}

export function observationRows(
  observation: DesktopHomeObservation,
): (readonly [string, ReactNode])[] {
  return [
    [
      'ルーターの MAC',
      observation.gateway_mac_tail === null ? (
        <StatusText line={UNAVAILABLE} />
      ) : (
        <MaskedMac tail={observation.gateway_mac_tail} />
      ),
    ],
    [
      'サブネット',
      observation.subnet === null ? (
        <StatusText line={UNAVAILABLE} />
      ) : (
        <span className="font-mono tabular-nums">{observation.subnet}</span>
      ),
    ],
    [
      'Wi-Fi 名（SSID）',
      observation.ssid_hint !== null ? (
        <MaskedSsid hint={observation.ssid_hint} />
      ) : (
        SSID_REASON_LABELS[observation.ssid_unavailable_reason ?? 'unavailable']
      ),
    ],
  ];
}

export function RegistrationSection({
  registration,
  loaded,
  now,
}: {
  readonly registration: HomeRegistration | null;
  readonly loaded: boolean;
  readonly now: number;
}) {
  return (
    <Section
      id="home-registration-heading"
      title={HOME_LABELS.registrationTitle}
    >
      {!loaded ? (
        <p className="text-sm text-muted">{HOME_LABELS.loading}</p>
      ) : (
        <>
          <StatusText
            line={registrationLine(registration)}
            className="text-base font-semibold"
          />
          {registration === null ? (
            <p className="max-w-prose text-sm leading-6">
              {HOME_LABELS.unregisteredBody}
            </p>
          ) : (
            <>
              <Rows
                rows={[
                  [
                    'サブネット',
                    <span key="subnet" className="font-mono tabular-nums">
                      {registration.subnet}
                    </span>,
                  ],
                  [
                    'Wi-Fi 名（SSID）',
                    registration.ssid_registered
                      ? HOME_LABELS.ssidChecked
                      : HOME_LABELS.ssidNotChecked,
                  ],
                  [
                    '最終更新',
                    <span key="at" className="tabular-nums">
                      {clockOf(registration.registered_at, now, {
                        date: true,
                      })}
                    </span>,
                  ],
                ]}
              />
              <p className="max-w-prose text-xs leading-5 text-muted">
                {HOME_LABELS.hashNote}
              </p>
            </>
          )}
        </>
      )}
    </Section>
  );
}

export function CurrentNetworkSection({
  state,
  actions,
  now,
  onAsk,
  includeSsid = true,
  onIncludeSsidChange = () => undefined,
}: {
  readonly state: HomeViewState;
  readonly actions: HomeActions;
  readonly now: number;
  readonly onAsk: (request: ConfirmRequest) => void;
  // Wi-Fi 名（SSID）も確かめるか（既定は確かめる）。SSID が読み取れないときは選択肢を出さない。
  readonly includeSsid?: boolean;
  readonly onIncludeSsidChange?: (include: boolean) => void;
}) {
  const home = state.home;
  const observation = home?.observation ?? null;
  const registration = home?.registration ?? null;
  const ref = observation?.ref ?? null;
  return (
    <Section
      id="home-current-heading"
      title={HOME_LABELS.currentTitle}
      action={
        <Button size="sm" variant="outline" onPress={actions.refresh}>
          {HOME_LABELS.reread}
        </Button>
      }
    >
      {state.messageFrom === 'status' ? (
        <MessageText text={state.message} />
      ) : null}
      {state.reading ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <Spinner size="sm" color="current" aria-hidden="true" />
          {HOME_LABELS.reading}
        </p>
      ) : null}
      {home === null ? null : observation === null ? (
        <Alert status="warning" role="alert">
          <Alert.Indicator>
            <AlertIcon />
          </Alert.Indicator>
          <Alert.Content>
            <Alert.Title>{HOME_LABELS.readFailedTitle}</Alert.Title>
            <Alert.Description className="text-sm leading-6 text-foreground">
              {HOME_LABELS.readFailedBody}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : (
        <>
          <Rows rows={observationRows(observation)} />
          <p className="text-xs text-muted tabular-nums">
            {`${clockOf(observation.collected_at, now)} に読み取りました。一部を伏せて表示しています。`}
          </p>
          {ref === null ? (
            <p className="flex max-w-prose items-start gap-1.5 text-sm leading-6">
              <span className="mt-1">
                <StatusMark line={UNAVAILABLE} />
              </span>
              <span>{HOME_LABELS.notRegistrable}</span>
            </p>
          ) : state.stale ? (
            // main が参照を捨てた後は、読み取り直すまで登録のボタンを置かない（押せないボタンを置かない）。
            // 理由と次の行動は、ボタンがあった場所に出す。
            <MessageText
              text={state.messageFrom === 'register' ? state.message : null}
            />
          ) : (
            <div className="flex flex-col gap-2">
              {observation.ssid_hint === null ? (
                <p className="max-w-prose text-xs leading-5 text-muted">
                  {HOME_LABELS.noSsid}
                </p>
              ) : (
                <Checkbox
                  isSelected={includeSsid}
                  onChange={onIncludeSsidChange}
                  className="max-w-prose"
                >
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <Label>{HOME_LABELS.includeSsid}</Label>
                  </Checkbox.Content>
                  <Description className="text-xs leading-5 text-muted">
                    {includeSsid
                      ? HOME_LABELS.includeSsidOn
                      : HOME_LABELS.includeSsidOff}
                  </Description>
                </Checkbox>
              )}
              <div>
                <Button
                  variant={registration === null ? 'primary' : 'secondary'}
                  isDisabled={state.busy}
                  onPress={() =>
                    onAsk(
                      confirmRequest(
                        observation,
                        ref,
                        registration,
                        now,
                        actions,
                        includeSsid,
                      ),
                    )
                  }
                >
                  {registration === null
                    ? HOME_LABELS.register
                    : HOME_LABELS.reregister}
                </Button>
              </div>
              {state.messageFrom === 'register' ? (
                <MessageText text={state.message} />
              ) : null}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// 操作の拒否・失敗の文言（押したボタンのすぐ下。warning の文字色）。
function MessageText({ text }: { readonly text: string | null }) {
  if (text === null) return null;
  return (
    <p
      role="alert"
      className="max-w-prose text-sm leading-6 text-warning-soft-foreground"
    >
      {text}
    </p>
  );
}

// 確認のダイアログで確かめる値（大きな等幅で、値ごとに別の段に出す。ADR 0024 の UI レビュー 2 回目の追記 6）。
function ConfirmValues({
  observation,
  includeSsid,
}: {
  readonly observation: DesktopHomeObservation;
  readonly includeSsid: boolean;
}) {
  const value = 'text-2xl font-semibold tracking-wider';
  const items: [string, ReactNode][] = [
    [
      'ルーターの MAC（最後の 2 組）',
      observation.gateway_mac_tail === null ? null : (
        <MaskedMac tail={observation.gateway_mac_tail} className={value} />
      ),
    ],
    [
      'サブネット',
      <span key="subnet" className={`font-mono tabular-nums ${value}`}>
        {observation.subnet}
      </span>,
    ],
    [
      'Wi-Fi 名（SSID）',
      observation.ssid_hint !== null && includeSsid ? (
        <MaskedSsid hint={observation.ssid_hint} className={value} />
      ) : observation.ssid_hint !== null ? (
        <span className="text-sm">確かめない（Wi-Fi 名は送りません）</span>
      ) : (
        <span className="text-sm">
          {
            SSID_REASON_LABELS[
              observation.ssid_unavailable_reason ?? 'unavailable'
            ]
          }
        </span>
      ),
    ],
  ];
  return (
    <div className="flex flex-col gap-3">
      {items.map(([label, shown]) => (
        <div key={label} className="flex flex-col gap-1">
          <p className="text-sm font-medium">{label}</p>
          <p>{shown}</p>
        </div>
      ))}
    </div>
  );
}

// 登録・登録し直しの確認。読み取った内容（伏せた表示）を見せ、登録の意味と置き換えを書く。
export function confirmRequest(
  observation: DesktopHomeObservation,
  ref: string,
  registration: HomeRegistration | null,
  now: number,
  actions: HomeActions,
  includeSsid = true,
): ConfirmRequest {
  const ssidOff = observation.ssid_hint !== null && !includeSsid;
  return {
    title:
      registration === null
        ? 'このネットワークを自宅として登録しますか'
        : '自宅の登録を今のネットワークで置き換えますか',
    body: (
      <div className="flex flex-col gap-4">
        <ConfirmValues observation={observation} includeSsid={includeSsid} />
        <p className="text-sm leading-6">
          登録すると、中枢と別のマシンの端末は、このネットワークにつながっていて
          Tailscale で直接つながっているときだけ中枢に接続できます。
        </p>
        {ssidOff ? (
          <p className="text-sm leading-6">
            Wi-Fi 名は確かめません。{HOME_LABELS.includeSsidOff}
          </p>
        ) : null}
        {registration === null ? null : (
          <p className="text-sm leading-6">
            今の登録（
            <span className="font-mono">{registration.subnet}</span>・
            <span className="tabular-nums">
              {clockOf(registration.registered_at, now, { date: true })}
            </span>
            ）は置き換わり、元に戻せません。前のネットワークにいる端末は接続できなくなります。
          </p>
        )}
      </div>
    ),
    confirmLabel: registration === null ? '登録する' : '登録し直す',
    tone: 'accent',
    onConfirm: () => actions.register(ref, includeSsid),
  };
}

export function HomeNetworkPanel({
  state,
  actions,
  now,
}: {
  readonly state: HomeViewState;
  readonly actions: HomeActions;
  readonly now: number;
}) {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  // Wi-Fi 名（SSID）も確かめるか（本人の判断 2026-10-22。既定は確かめる）。
  const [includeSsid, setIncludeSsid] = useState(true);
  // タブを開いたときに、このマシンのネットワークを読み取り直す（前に読んだ値を今の値として使わない）。
  useEffect(() => {
    actions.refresh();
  }, [actions]);
  return (
    <div className="flex flex-col gap-6">
      {state.registered ? (
        <Alert status="success">
          <Alert.Indicator>
            <span aria-hidden="true" className="text-sm leading-none">
              ●
            </span>
          </Alert.Indicator>
          <Alert.Content>
            <Alert.Title>{HOME_LABELS.doneTitle}</Alert.Title>
          </Alert.Content>
          <CloseButton aria-label="知らせを閉じる" onPress={actions.dismiss} />
        </Alert>
      ) : null}
      <p className="max-w-prose text-sm leading-6">{HOME_LABELS.intro}</p>
      <RegistrationSection
        registration={state.home?.registration ?? null}
        loaded={state.home !== null}
        now={now}
      />
      <CurrentNetworkSection
        state={state}
        actions={actions}
        now={now}
        onAsk={setConfirm}
        includeSsid={includeSsid}
        onIncludeSsidChange={setIncludeSsid}
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
