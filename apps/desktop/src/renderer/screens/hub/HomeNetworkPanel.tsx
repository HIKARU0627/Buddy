// 中枢の画面の「自宅のネットワーク」のタブ（設計 11 §10、ADR 0022・0024・0026、B03-08）。
// 上から「説明 → 登録している自宅 → このマシンが今つながっているネットワーク（伏せた表示・登録のボタン）」。
// 登録・登録し直しは確認（ConfirmDialog）を挟んでから送る。画面に来るのは伏せた表示と main の参照だけで、
// MAC・SSID の値はない。タブを開いたときに main へ読み取りを頼む。状態と操作は引数で受け取り、限定 API を直接呼ばない。
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, CloseButton, Spinner } from '@heroui/react';
import type {
  DesktopHomeObservation,
  HomeRegistration,
} from '@buddy/contracts';
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
    'ルーターの MAC と SSID は、照合用の値（HMAC）だけを中枢に保存しています。元の値は表示できません。',
  readFailedTitle: 'このマシンのネットワークを読み取れませんでした',
  readFailedBody:
    'ネットワークにつながっているかを確かめてから、「読み取り直す」を押してください。',
  notRegistrable:
    'ルーターの MAC とサブネットの両方が読み取れないと登録できません。ネットワークにつながっているかを確かめてから、読み取り直してください。',
  noSsid:
    'SSID なしで登録します。判定では、ルーターの MAC とサブネットだけを比べます。',
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
function MaskedMac({ tail }: { readonly tail: string }) {
  return (
    <>
      <span aria-hidden="true" className="font-mono tabular-nums">
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
}: {
  readonly hint: NonNullable<DesktopHomeObservation['ssid_hint']>;
}) {
  const masked =
    hint.first === null
      ? '•'.repeat(hint.length)
      : `${hint.first}${'•'.repeat(hint.length - 1)}`;
  return (
    <>
      <span aria-hidden="true" className="font-mono break-all">
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
      'Wi-Fi の名前（SSID）',
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
                    'Wi-Fi の名前（SSID）',
                    registration.ssid_registered
                      ? '登録しています（判定で比べます）'
                      : '登録していません（判定で比べません）',
                  ],
                  [
                    '最終更新',
                    <span key="at" className="tabular-nums">
                      {clockOf(registration.registered_at, now)}
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
}: {
  readonly state: HomeViewState;
  readonly actions: HomeActions;
  readonly now: number;
  readonly onAsk: (request: ConfirmRequest) => void;
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
        <Button size="sm" variant="ghost" onPress={actions.refresh}>
          {HOME_LABELS.reread}
        </Button>
      }
    >
      {state.reading ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <Spinner size="sm" color="current" aria-hidden="true" />
          {HOME_LABELS.reading}
        </p>
      ) : null}
      {home === null ? null : observation === null ? (
        <Alert status="danger" role="alert">
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
          ) : state.stale ? null : (
            // main が参照を捨てた後は、読み取り直すまで登録のボタンを置かない（押せないボタンを置かない）。
            <div className="flex flex-col gap-2">
              {observation.ssid_hint === null ? (
                <p className="max-w-prose text-xs leading-5 text-muted">
                  {HOME_LABELS.noSsid}
                </p>
              ) : null}
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
                      ),
                    )
                  }
                >
                  {registration === null
                    ? HOME_LABELS.register
                    : HOME_LABELS.reregister}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      {state.message === null ? null : (
        <p
          role="alert"
          className="max-w-prose text-sm leading-6 text-warning-soft-foreground"
        >
          {state.message}
        </p>
      )}
    </Section>
  );
}

// 登録・登録し直しの確認。読み取った内容（伏せた表示）を見せ、登録の意味と置き換えを書く。
export function confirmRequest(
  observation: DesktopHomeObservation,
  ref: string,
  registration: HomeRegistration | null,
  now: number,
  actions: HomeActions,
): ConfirmRequest {
  return {
    title:
      registration === null
        ? 'このネットワークを自宅として登録しますか'
        : '自宅の登録を今のネットワークで置き換えますか',
    body: (
      <div className="flex flex-col gap-4">
        <Rows rows={observationRows(observation)} />
        <p className="text-sm leading-6">
          登録すると、中枢と別のマシンの端末は、このネットワークにつながっていて
          Tailscale で直接つながっているときだけ中枢に接続できます。
        </p>
        {registration === null ? null : (
          <p className="text-sm leading-6">
            今の登録（
            <span className="font-mono">{registration.subnet}</span>・
            <span className="tabular-nums">
              {clockOf(registration.registered_at, now)}
            </span>
            ）は置き換わり、元に戻せません。前のネットワークにいる端末は接続できなくなります。
          </p>
        )}
      </div>
    ),
    confirmLabel: registration === null ? '登録する' : '登録し直す',
    tone: 'accent',
    onConfirm: () => actions.register(ref),
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
  // タブを開いたときに、このマシンのネットワークを読み取り直す（前に読んだ値を今の値として使わない）。
  useEffect(() => {
    actions.refresh();
  }, [actions]);
  return (
    <div className="flex flex-col gap-6">
      {state.registered ? (
        <Alert status="success">
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
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
