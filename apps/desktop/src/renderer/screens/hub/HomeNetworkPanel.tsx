// 中枢の画面の「自宅のネットワーク」のタブ（設計 11 §10、ADR 0022・0024・0026、B03-08）。
// 上から「説明 → 登録している自宅 → このマシンが今つながっているネットワーク（伏せた表示・登録のボタン）」。
// 登録・登録し直しは確認（ConfirmDialog）を挟んでから送る。画面に来るのは伏せた表示と main の参照だけで、
// MAC・SSID の値はない。タブを開いたときに main へ読み取りを頼む。状態と操作は引数で受け取り、限定 API を直接呼ばない。
// UI レビュー 2 回目の約束（ADR 0024 の追記）: 失敗の Alert は warning（danger は証明書の変化だけ）で記号を付ける。
// 操作の結果の文言は押したボタンのすぐ下に出す。確認のダイアログでは、確かめる値を大きな等幅で別の段に出す。
// 数字と単位の間は改行しない空白（U+00A0）にする（UI レビュー 3 回目の決定。`NB` を使う）。
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
import { InlineNotice } from '../../components/InlineNotice.js';
import { Section } from '../../components/Section.js';
import { StatusMark, StatusText } from '../../components/StatusText.js';
import { clockOf } from '../../format.js';
import type { HomeActions, HomeViewState } from '../../state/home-state.js';
import type { StatusLine } from '../../tones.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import type { ConfirmRequest } from './ConfirmDialog.js';

// 改行しない空白（数字と単位の間・「MAC アドレス」の間）。
const NB = '\u00a0';
// 伏せた文字（指紋の格子の伏せ字と同じ U+00B7）。
const MASK = '·';
const MAC_ADDRESS = `ルーターの MAC${NB}アドレス`;

export const HOME_LABELS = {
  tab: '自宅のネットワーク',
  intro:
    'ほかのマシンの端末は、ここで登録した自宅のネットワークにつながっていて、Tailscale で直接つながっているときだけ中枢に接続できます。中枢と同じマシンの端末（この画面）は、この判定の対象になりません。',
  registrationTitle: '登録している自宅',
  currentTitle: 'このマシンが今つながっているネットワーク',
  reading: '読み取っています…',
  reread: '読み取り直す',
  register: 'このネットワークを自宅として登録する',
  reregister: '今のネットワークで登録し直す',
  unregisteredBody:
    'まだ自宅を登録していません。登録するまで、ほかのマシンの端末は接続できません。',
  hashNote: `${MAC_ADDRESS}と Wi-Fi 名は、照合用の値（元の値に戻せない形）だけを中枢に保存しています。元の値は表示できません。`,
  readFailedTitle: 'このマシンのネットワークを読み取れませんでした',
  readFailedBody:
    'ネットワークにつながっているかを確かめてから、「読み取り直す」を押してください。',
  // Wi-Fi 名（SSID）も確かめるか（本人の判断 2026-10-22。未登録では確かめる、登録済みでは今の登録に合わせる）。
  includeSsid: 'Wi-Fi 名（SSID）も確かめる',
  includeSsidOn:
    '端末の Wi-Fi 名が、このネットワークの Wi-Fi 名と同じときだけ通します（有線の端末は Wi-Fi 名を比べません）。',
  includeSsidOff: `切っても、${MAC_ADDRESS}・サブネット・Tailscale の直接経路は確かめます。`,
  appliesOnReregister: '登録し直すときに反映されます。',
  ssidChecked: '確かめる（登録した Wi-Fi 名と比べます）',
  ssidNotChecked: `確かめない（${MAC_ADDRESS}・サブネット・Tailscale の直接経路で判定します）`,
  doneTitle: '自宅のネットワークを登録しました。',
  // 中枢との接続を待つ間（中枢の画面の Tabs と同じく、表示を残して操作を止める）。
  paused:
    '中枢との接続を待っています。接続が戻ると、読み取り直しと自宅の登録ができます。',
} as const;

// Wi-Fi 名が取れない理由（行の値。短く）。
const SSID_REASON_LABELS: Readonly<
  Record<NonNullable<DesktopHomeObservation['ssid_unavailable_reason']>, string>
> = {
  redacted: '読み取れません（位置情報の許可がありません）',
  ambiguous: '決められません（無線の接続が複数あります）',
  unavailable: 'ありません（有線の接続、または読み取れません）',
};

// Wi-Fi 名が取れないときの次の行動（理由ごと）。登録の内容を左右するので本文の重さで出す（UI レビュー M3）。
// どのアプリに位置情報の許可が要るかは実機で確かめる（device-check の D0-2）。
function ssidGuidance(
  reason: NonNullable<DesktopHomeObservation['ssid_unavailable_reason']>,
  registrable: boolean,
): string | null {
  const without = `このまま登録すると、Wi-Fi 名は確かめません（${MAC_ADDRESS}・サブネット・Tailscale の直接経路で判定します）。`;
  if (reason === 'redacted')
    return `Wi-Fi 名を読み取るには、macOS のシステム設定の「プライバシーとセキュリティ」>「位置情報サービス」で Buddy を許可してから、「読み取り直す」を押してください。${registrable ? without : ''}`;
  if (reason === 'ambiguous')
    return `無線の接続が複数あるため、Wi-Fi 名を決められません。使わない Wi-Fi を切ってから、「読み取り直す」を押してください。${registrable ? without : ''}`;
  return registrable
    ? `このマシンの Wi-Fi 名を読み取れないため、Wi-Fi 名なしで登録します。判定では、${MAC_ADDRESS}・サブネット・Tailscale の直接経路を確かめます。`
    : null;
}

// 登録できない理由（足りない要素を名指しする。UI レビュー M2）。
function notRegistrableText(observation: DesktopHomeObservation): string {
  const missing = [
    observation.gateway_mac_tail === null ? MAC_ADDRESS : null,
    observation.subnet === null ? 'サブネット' : null,
  ].filter((name): name is string => name !== null);
  return `${missing.join('と')}を読み取れないため、登録できません。登録には、${MAC_ADDRESS}とサブネットの両方が必要です。ネットワークにつながっているかを確かめてから、「読み取り直す」を押してください。`;
}

// 読み取った時刻と、何をどう伏せたか（伏せたものがあるときだけ。UI レビュー M5・L2）。
function collectedNote(
  observation: DesktopHomeObservation,
  now: number,
): string {
  const masked = [
    observation.gateway_mac_tail === null
      ? null
      : `${MAC_ADDRESS}は最後の${NB}2${NB}組だけ`,
    observation.ssid_hint === null
      ? null
      : observation.ssid_hint.first === null
        ? 'Wi-Fi 名は文字数だけ'
        : `Wi-Fi 名は先頭の${NB}1${NB}文字と文字数だけ`,
  ].filter((part): part is string => part !== null);
  const at = `${clockOf(observation.collected_at, now)} に読み取りました。`;
  return masked.length === 0
    ? at
    : `${at}${masked.join('、')}を表示しています。`;
}

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

// ゲートウェイの MAC の伏せた表示（最後の 2 組だけ）。読み上げでは伏せたことを言う（時刻と読まれないよう「と」で区切る）。
function MaskedMac({
  tail,
  className = '',
}: {
  readonly tail: string;
  readonly className?: string;
}) {
  const masked = `${MASK.repeat(2)}:${MASK.repeat(2)}:${MASK.repeat(2)}:${MASK.repeat(2)}:${tail}`;
  return (
    <>
      <span
        aria-hidden="true"
        className={`font-mono whitespace-nowrap tabular-nums ${className}`}
      >
        {masked}
      </span>
      <span className="sr-only">
        {`最後の${NB}2${NB}組が ${tail.replace(':', ' と ')}（ほかは伏せています）`}
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
      ? MASK.repeat(hint.length)
      : `${hint.first}${MASK.repeat(hint.length - 1)}`;
  return (
    <>
      <span aria-hidden="true" className={`font-mono break-all ${className}`}>
        {masked}
      </span>
      <span className="text-muted tabular-nums">{`（${hint.length}${NB}文字）`}</span>
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
      MAC_ADDRESS,
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
        <span className="font-mono whitespace-nowrap tabular-nums">
          {observation.subnet}
        </span>
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
        // 読み取りの 1 回の要求なので、下の欄と同じ見た目・言葉にする（ライブ領域は下の欄の 1 つだけ）。
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner size="sm" color="current" aria-hidden="true" />
          {HOME_LABELS.reading}
        </p>
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
                    <span
                      key="subnet"
                      className="font-mono whitespace-nowrap tabular-nums"
                    >
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
                    '登録',
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
  paused = false,
  stopped = false,
}: {
  readonly state: HomeViewState;
  readonly actions: HomeActions;
  readonly now: number;
  readonly onAsk: (request: ConfirmRequest) => void;
  // 中枢との接続を待っている（表示を残して、読み取り直し・登録を止める）。
  readonly paused?: boolean;
  // この端末の入出力が止まっている（停止の帯の再開を 1 画面の primary にするため、登録は secondary）。
  readonly stopped?: boolean;
  // Wi-Fi 名（SSID）も確かめるか。SSID が読み取れないときは選択肢を出さない。
  readonly includeSsid?: boolean;
  readonly onIncludeSsidChange?: (include: boolean) => void;
}) {
  const home = state.home;
  const observation = home?.observation ?? null;
  const registration = home?.registration ?? null;
  const ref = observation?.ref ?? null;
  const reason = observation?.ssid_unavailable_reason ?? null;
  const guidance =
    observation === null || observation.ssid_hint !== null || reason === null
      ? null
      : ssidGuidance(reason, ref !== null);
  return (
    <Section
      id="home-current-heading"
      title={HOME_LABELS.currentTitle}
      action={
        // 登録の結果を待つ間は読み取り直さない（古い表示・参照が戻らないように。PR #79 のレビュー Low-3）。
        <Button
          size="sm"
          variant="outline"
          isDisabled={state.busy || paused}
          onPress={actions.refresh}
        >
          {HOME_LABELS.reread}
        </Button>
      }
    >
      {paused ? (
        // 状態のライブ領域は Tabs の上の 1 行（中枢の画面）なので、ここは読み上げの領域にしない。
        <p className="flex items-start gap-2 text-sm leading-6 text-warning-soft-foreground">
          <span aria-hidden="true">○</span>
          <span>{HOME_LABELS.paused}</span>
        </p>
      ) : null}
      {state.messageFrom === 'status' && state.message !== null ? (
        <InlineNotice tone="warning" text={state.message} />
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
            {collectedNote(observation, now)}
          </p>
          {guidance === null ? null : (
            <p className="max-w-prose text-sm leading-6 text-foreground">
              {guidance}
            </p>
          )}
          {ref === null ? (
            <p className="flex max-w-prose items-start gap-1.5 text-sm leading-6">
              <span className="mt-1 flex shrink-0">
                <StatusMark line={UNAVAILABLE} />
              </span>
              <span>{notRegistrableText(observation)}</span>
            </p>
          ) : state.stale ? (
            // main が参照を捨てた後は、読み取り直すまで登録のボタンを置かない（押せないボタンを置かない）。
            // 理由と次の行動は、ボタンがあった場所に出す。
            state.messageFrom === 'register' && state.message !== null ? (
              <InlineNotice tone="warning" text={state.message} />
            ) : null
          ) : (
            <div className="flex flex-col gap-2">
              {observation.ssid_hint === null ? null : (
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
                    {/* 登録済みでは「今の設定」ではなく、登録し直すときの入力（UI レビュー M1）。 */}
                    {registration === null
                      ? ''
                      : `${HOME_LABELS.appliesOnReregister}`}
                    {includeSsid
                      ? HOME_LABELS.includeSsidOn
                      : HOME_LABELS.includeSsidOff}
                  </Description>
                </Checkbox>
              )}
              <div>
                {/* 読み取りの最中は押せない（確認の後に送る直前で読み直すが、表示と食い違わないように。Low-2）。 */}
                {/* 1 画面に primary は 1 つ（ADR 0024）。止まっている間は停止の帯の再開が primary。 */}
                <Button
                  variant={
                    registration === null && !stopped ? 'primary' : 'secondary'
                  }
                  isDisabled={state.busy || state.reading || paused}
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
              {state.messageFrom === 'register' && state.message !== null ? (
                <InlineNotice tone="warning" text={state.message} />
              ) : null}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// 確認のダイアログで確かめる値（大きな等幅で、値ごとに別の段に出す。ADR 0024 の UI レビュー 2 回目の追記 6）。
// 値の下に、何と見比べるかを添える（UI レビュー M5）。
function ConfirmValues({
  observation,
  includeSsid,
}: {
  readonly observation: DesktopHomeObservation;
  readonly includeSsid: boolean;
}) {
  const value = 'text-2xl font-semibold tracking-wider';
  const items: [string, ReactNode, string | null][] = [
    [
      `${MAC_ADDRESS}（最後の${NB}2${NB}組）`,
      observation.gateway_mac_tail === null ? null : (
        <MaskedMac tail={observation.gateway_mac_tail} className={value} />
      ),
      `ルーターのラベルや管理画面の MAC${NB}アドレスの、最後の${NB}2${NB}組と同じかを確かめてください。`,
    ],
    [
      'サブネット',
      <span
        key="subnet"
        className={`font-mono whitespace-nowrap tabular-nums ${value}`}
      >
        {observation.subnet}
      </span>,
      'ルーターの管理画面の、LAN 側のアドレスの範囲です。',
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
      null,
    ],
  ];
  return (
    <div className="flex flex-col gap-3">
      {items.map(([label, shown, note]) => (
        <div key={label} className="flex flex-col gap-1">
          <p className="text-sm font-medium">{label}</p>
          <p>{shown}</p>
          {note === null ? null : (
            <p className="text-xs leading-5 text-muted">{note}</p>
          )}
        </div>
      ))}
    </div>
  );
}

// 登録・登録し直しの確認。読み取った内容（伏せた表示）を見せ、登録の意味と置き換えを書く。
// 登録し直しは前に進む操作なので accent のまま。元に戻せないことは ⚠ と文で示す（UI レビュー L5、ADR 0024）。
export function confirmRequest(
  observation: DesktopHomeObservation,
  ref: string,
  registration: HomeRegistration | null,
  now: number,
  actions: HomeActions,
  includeSsid = true,
): ConfirmRequest {
  const sendsSsid = observation.ssid_hint !== null && includeSsid;
  const ssidOff = observation.ssid_hint !== null && !includeSsid;
  // 登録し直すと Wi-Fi 名の確認が付く・外れるか（UI レビュー M4）。
  const ssidChange =
    registration === null || registration.ssid_registered === sendsSsid
      ? null
      : sendsSsid
        ? '登録し直すと、Wi-Fi 名も確かめるようになります（Wi-Fi 名の違う端末は接続できなくなります）。'
        : '登録し直すと、Wi-Fi 名は確かめなくなります。';
  return {
    title:
      registration === null
        ? 'このネットワークを自宅として登録しますか'
        : '自宅の登録を今のネットワークで置き換えますか',
    body: (
      <div className="flex flex-col gap-4">
        <ConfirmValues observation={observation} includeSsid={includeSsid} />
        <p className="text-sm leading-6">
          登録すると、ほかのマシンの端末は、このネットワークにつながっていて
          Tailscale で直接つながっているときだけ中枢に接続できます。
        </p>
        {ssidOff ? (
          <p className="text-sm leading-6">
            {`Wi-Fi 名は確かめず、${MAC_ADDRESS}・サブネット・Tailscale の直接経路で判定します。`}
          </p>
        ) : null}
        {ssidChange === null ? null : (
          <p className="text-sm leading-6">{ssidChange}</p>
        )}
        {registration === null ? null : (
          <p className="flex items-start gap-1.5 text-sm leading-6 font-medium">
            <span className="mt-1 flex shrink-0">
              <StatusMark line={UNAVAILABLE} />
            </span>
            <span>
              今の登録（
              <span className="font-mono">{registration.subnet}</span>・
              <span className="tabular-nums">
                {clockOf(registration.registered_at, now, { date: true })}
              </span>
              ）は置き換わり、元に戻せません。前のネットワークにいる端末は接続できなくなります。
            </span>
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
  paused = false,
  stopped = false,
}: {
  readonly state: HomeViewState;
  readonly actions: HomeActions;
  readonly now: number;
  readonly paused?: boolean;
  readonly stopped?: boolean;
}) {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const registration = state.home?.registration ?? null;
  // Wi-Fi 名（SSID）も確かめるか（本人の判断 2026-10-22）。未登録なら確かめる。登録済みなら今の登録に合わせ、
  // 登録が変わったら合わせ直す（Checkbox が「今の設定」と食い違って見えないように。UI レビュー M1）。
  const registrationKey =
    registration === null
      ? 'none'
      : `${registration.registered_at}|${String(registration.ssid_registered)}`;
  // 本人が切り替えた選択は、その登録の間だけ保つ（読み取り直しでは戻さない）。
  const [choice, setChoice] = useState<{
    readonly key: string;
    readonly include: boolean;
  } | null>(null);
  const includeSsid =
    choice !== null && choice.key === registrationKey
      ? choice.include
      : (registration?.ssid_registered ?? true);
  const setIncludeSsid = (include: boolean) =>
    setChoice({ key: registrationKey, include });
  // タブを開いたとき・接続が戻ったときに、このマシンのネットワークを読み取り直す（前に読んだ値を今の値として
  // 使わない）。接続を待つ間は読み取らない（中枢へ登録の状態を問い合わせられない）。
  useEffect(() => {
    if (!paused) actions.refresh();
  }, [actions, paused]);
  return (
    <div className="flex flex-col gap-6">
      {state.registered ? (
        // 登録の知らせは読み上げにも届ける（role="status"。時刻を含まない。UI レビュー M7）。
        <Alert status="success" role="status">
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
        registration={registration}
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
        paused={paused}
        stopped={stopped}
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
