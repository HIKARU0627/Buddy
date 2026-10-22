// 中枢の画面の「自宅のネットワーク」のタブの試験（ADR 0022・0024・0026、B03-08）。
// サーバー描画（react-dom/server）で、未登録・登録済み・取得できない要素がある・読み取りの失敗の表示とボタンを確かめ、
// 押したときは要求を送ることを onPress を呼んで確かめる（本人の確認は main の OS の確認ダイアログで、その文言は
// main の admin-confirm.test.ts で確かめる）。
// 期待値の文言・伏せた表示は手で書く。画面に来る値は伏せた表示だけなので、生の値は描画にも出ない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DesktopHomeObservation,
  DesktopIpcRequest,
  DesktopIpcResponse,
  HomeRegistration,
} from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import {
  HOME_IPC_FAILURE_MESSAGE,
  INITIAL_HOME_STATE,
  applyHomeFailure,
  applyHomeResponse,
  homeActions,
  markHomeSending,
} from '../../state/home-state.js';
import type { HomeViewState } from '../../state/home-state.js';
import { INITIAL_HUB_STATE, hubActions } from '../../state/hub-state.js';
import {
  CurrentNetworkSection,
  HOME_LABELS,
  HomeNetworkPanel,
  RegistrationSection,
} from './HomeNetworkPanel.js';
import { HubTabs } from './HubPanels.js';

const REF = '00000000-0000-4000-8000-000000000e61';
const OBSERVATION: DesktopHomeObservation = {
  ref: REF,
  collected_at: '2030-10-05T03:00:00Z',
  gateway_mac_tail: '53:01',
  subnet: '192.0.2.0/24',
  ssid_hint: { first: '合', length: 5 },
  ssid_unavailable_reason: null,
};
const REGISTRATION: HomeRegistration = {
  subnet: '192.0.2.0/24',
  ssid_registered: true,
  registered_at: '2030-10-04T03:00:00Z',
};
// 地域時間の 2030-10-05 の昼を「今」にする。
const NOW = new Date(2030, 9, 5, 12, 0, 0).getTime();

const html = (node: ReactNode) =>
  renderToStaticMarkup(<AppProviders>{node}</AppProviders>);

const state = (patch: Partial<HomeViewState>): HomeViewState => ({
  ...INITIAL_HOME_STATE,
  ...patch,
});

// 押せるボタン（文言 → onPress）。Section の見出しの右の操作（action）も探す。
function pressables(node: ReactNode): Map<string, () => void> {
  const found = new Map<string, () => void>();
  const walk = (current: ReactNode): void => {
    if (Array.isArray(current)) {
      for (const child of current as ReactNode[]) walk(child);
      return;
    }
    if (!isValidElement(current)) return;
    const props = current.props as {
      onPress?: unknown;
      children?: ReactNode;
      action?: ReactNode;
    };
    if (
      typeof props.onPress === 'function' &&
      typeof props.children === 'string'
    )
      found.set(props.children, props.onPress as () => void);
    walk(props.action);
    walk(props.children);
  };
  walk(node);
  return found;
}

// 文言が label のボタンの開始タグ（variant・disabled を確かめる）。
function buttonTag(markup: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return (
    new RegExp(`<button([^>]*)>${escaped}</button>`, 'u').exec(markup)?.[1] ??
    null
  );
}

function capture() {
  const sent: DesktopIpcRequest[] = [];
  let dismissed = 0;
  return {
    sent,
    dismissed: () => dismissed,
    actions: homeActions(
      (built) => sent.push(built),
      () => {
        dismissed += 1;
      },
    ),
  };
}

test(
  'unregistered: the masked network and a primary register button that sends the request (main asks with the OS dialog)',
  { timeout: 10_000 },
  () => {
    const { sent, actions } = capture();
    const home = { registration: null, observation: OBSERVATION };
    const markup = html(
      <HomeNetworkPanel state={state({ home })} actions={actions} now={NOW} />,
    );
    assert.match(
      markup,
      /<section aria-labelledby="home-registration-heading"/u,
    );
    assert.match(markup, /<section aria-labelledby="home-current-heading"/u);
    assert.match(markup, /<span>未登録<\/span>/u);
    assert.match(markup, /まだ自宅を登録していません。/u);
    // MAC は最後の 2 組、サブネットはそのまま、SSID は先頭の 1 文字と文字数。
    assert.match(markup, /··:··:··:··:53:01/u);
    assert.match(
      markup,
      /最後の\u00a02\u00a0組が 53 と 01（ほかは伏せています）/u,
    );
    assert.match(markup, />192\.0\.2\.0\/24</u);
    assert.match(markup, /合····/u);
    assert.match(markup, /（5\u00a0文字）/u);
    assert.match(markup, /先頭が「合」で、ほかは伏せています/u);
    // 時刻は端末の地域時間（今日でなければ月日を付ける）。
    assert.match(
      markup,
      /(?:10\/\d )?\d\d:\d\d:\d\d に読み取りました。ルーターの MAC\u00a0アドレスは最後の\u00a02\u00a0組だけ、Wi-Fi 名は先頭の\u00a01\u00a0文字と文字数だけを表示しています。/u,
    );
    const tag = buttonTag(markup, HOME_LABELS.register);
    assert(tag !== null, markup);
    assert.match(tag, /button--primary/u);
    assert.doesNotMatch(tag, /disabled/u);
    // 押すと登録の要求を送る（本人の確認は main が OS の確認ダイアログで行い、画面の中では確かめない）。
    const buttons = pressables(
      CurrentNetworkSection({
        state: state({ home }),
        actions,
        now: NOW,
      }),
    );
    buttons.get(HOME_LABELS.register)?.();
    assert.deepEqual(
      sent.map((built) => [built.channel, built.payload]),
      [['desktop.home_register', { ref: REF, include_ssid: true }]],
    );
    // 読み取り直すは確認なしで送る。
    buttons.get(HOME_LABELS.reread)?.();
    assert.equal(sent.at(-1)?.channel, 'desktop.home_status');
  },
);

test(
  'the Wi-Fi name choice is on by default; turning it off says what is still checked and registers without the SSID',
  { timeout: 10_000 },
  () => {
    const { sent, actions } = capture();
    const home = { registration: null, observation: OBSERVATION };
    // 既定は「確かめる」（パネルの初期値）。
    const markup = html(
      <HomeNetworkPanel state={state({ home })} actions={actions} now={NOW} />,
    );
    assert.match(markup, /Wi-Fi 名（SSID）も確かめる/u);
    assert.match(markup, /data-selected="true"/u);
    assert.match(markup, /同じときだけ通します/u);
    // 切ったとき: 補足を出し、確認でも分かるようにし、SSID を送らないで登録する（include_ssid: false）。
    const off = html(
      <CurrentNetworkSection
        state={state({ home })}
        actions={actions}
        now={NOW}
        includeSsid={false}
      />,
    );
    assert.doesNotMatch(off, /data-selected="true"/u);
    assert.match(
      off,
      /切っても、ルーターの MAC\u00a0アドレス・サブネット・Tailscale の直接経路は確かめます。/u,
    );
    pressables(
      CurrentNetworkSection({
        state: state({ home }),
        actions,
        now: NOW,
        includeSsid: false,
      }),
    ).get(HOME_LABELS.register)?.();
    assert.deepEqual(sent[0]?.payload, { ref: REF, include_ssid: false });
  },
);

test(
  'registered: the subnet, whether an SSID is registered and the last update, with a secondary re-register that warns about replacing',
  { timeout: 10_000 },
  () => {
    const { sent, actions } = capture();
    const wired: DesktopHomeObservation = {
      ...OBSERVATION,
      ssid_hint: null,
      ssid_unavailable_reason: 'unavailable',
    };
    const home = { registration: REGISTRATION, observation: wired };
    const markup = html(
      <HomeNetworkPanel state={state({ home })} actions={actions} now={NOW} />,
    );
    assert.match(markup, /<span>登録済み<\/span>/u);
    assert.match(markup, /確かめる（登録した Wi-Fi 名と比べます）/u);
    assert.match(markup, /<dt[^>]*>登録<\/dt>/u);
    // 登録の時刻は「今」の前の日（地域時間で 10/3〜10/4）なので月日を付ける。
    assert.match(markup, /10\/[34] \d\d:\d\d:\d\d/u);
    assert.match(markup, /照合用の値（元の値に戻せない形）だけ/u);
    assert.match(markup, /ありません（有線の接続、または読み取れません）/u);
    assert.match(markup, /Wi-Fi 名なしで登録します。/u);
    // Wi-Fi 名が読み取れないときは、確かめるかの選択肢を出さない。
    assert.doesNotMatch(markup, /Wi-Fi 名（SSID）も確かめる/u);
    const tag = buttonTag(markup, HOME_LABELS.reregister);
    assert(tag !== null, markup);
    assert.match(tag, /button--secondary/u);
    assert.equal(buttonTag(markup, HOME_LABELS.register), null);
    pressables(
      CurrentNetworkSection({
        state: state({ home }),
        actions,
        now: NOW,
      }),
    ).get(HOME_LABELS.reregister)?.();
    assert.deepEqual(sent[0]?.payload, { ref: REF, include_ssid: true });
    // SSID を登録していない登録。
    assert.match(
      html(
        <RegistrationSection
          registration={{ ...REGISTRATION, ssid_registered: false }}
          loaded
          now={NOW}
        />,
      ),
      /確かめない（ルーターの MAC\u00a0アドレス・サブネット・Tailscale の直接経路で判定します）/u,
    );
  },
);

test(
  'missing elements: no register button without both the MAC and the subnet; the SSID reason is shown',
  { timeout: 10_000 },
  () => {
    const { actions } = capture();
    const partial: DesktopHomeObservation = {
      ...OBSERVATION,
      ref: null,
      gateway_mac_tail: null,
      ssid_hint: null,
      ssid_unavailable_reason: 'redacted',
    };
    const markup = html(
      <HomeNetworkPanel
        state={state({ home: { registration: null, observation: partial } })}
        actions={actions}
        now={NOW}
      />,
    );
    assert.match(markup, /<span>読み取れません<\/span>/u);
    assert.match(markup, /読み取れません（位置情報の許可がありません）/u);
    assert.match(
      markup,
      /ルーターの MAC\u00a0アドレスを読み取れないため、登録できません。/u,
    );
    assert.equal(buttonTag(markup, HOME_LABELS.register), null);
    assert.equal(buttonTag(markup, HOME_LABELS.reregister), null);
    // 3 文字以下の SSID は文字数だけ。
    const short = html(
      <CurrentNetworkSection
        state={state({
          home: {
            registration: null,
            observation: {
              ...OBSERVATION,
              ssid_hint: { first: null, length: 3 },
            },
          },
        })}
        actions={actions}
        now={NOW}
      />,
    );
    assert.match(short, /···/u);
    assert.match(short, /（3\u00a0文字）/u);
    assert.doesNotMatch(short, /先頭が/u);
    assert.match(
      html(
        <CurrentNetworkSection
          state={state({
            home: {
              registration: null,
              observation: {
                ...OBSERVATION,
                ssid_hint: null,
                ssid_unavailable_reason: 'ambiguous',
              },
            },
          })}
          actions={actions}
          now={NOW}
        />,
      ),
      /決められません（無線の接続が複数あります）/u,
    );
  },
);

test(
  'a failed read shows an alert and no register button; loading, busy, a rejection and the done notice',
  { timeout: 10_000 },
  () => {
    const { actions, dismissed } = capture();
    const failed = html(
      <HomeNetworkPanel
        state={state({
          home: { registration: REGISTRATION, observation: null },
        })}
        actions={actions}
        now={NOW}
      />,
    );
    assert.match(
      failed,
      /role="alert"[\s\S]*このマシンのネットワークを読み取れませんでした/u,
    );
    // 失敗の Alert は warning（danger は証明書の変化だけ）で、記号を付ける。
    assert.match(failed, /alert--warning/u);
    assert.doesNotMatch(failed, /alert--danger/u);
    assert.match(failed, /alert__indicator/u);
    assert.match(failed, /<span>登録済み<\/span>/u);
    assert.equal(buttonTag(failed, HOME_LABELS.reregister), null);
    // 受け取る前と読み取りの最中。
    const loading = html(
      <HomeNetworkPanel
        state={state({ reading: true })}
        actions={actions}
        now={NOW}
      />,
    );
    assert.match(
      loading,
      /<p class="flex items-center gap-2 text-sm text-muted">(?:<[^>]+>)*読み取っています…/u,
    );
    assert.match(loading, /role="status"[^>]*>[\s\S]*読み取っています…/u);
    // 登録の結果を待つ間は押せない。
    const busy = html(
      <HomeNetworkPanel
        state={state({
          busy: true,
          home: { registration: null, observation: OBSERVATION },
        })}
        actions={actions}
        now={NOW}
      />,
    );
    assert.match(String(buttonTag(busy, HOME_LABELS.register)), /disabled/u);
    // main が参照を捨てた後は、読み取り直すまで登録のボタンを置かない（理由は alert で出す）。
    const stale = html(
      <HomeNetworkPanel
        state={state({
          stale: true,
          message: '読み取り直してください',
          messageFrom: 'register',
          home: { registration: null, observation: OBSERVATION },
        })}
        actions={actions}
        now={NOW}
      />,
    );
    assert.equal(buttonTag(stale, HOME_LABELS.register), null);
    assert.match(
      stale,
      /role="alert"[^>]*>(?:<[^>]+>)*読み取り直してください/u,
    );
    // 拒否は押したボタンのすぐ下に alert で出す（登録のボタンの下・欄の見出しの「読み取り直す」の下）。
    const registerRejected = html(
      <HomeNetworkPanel
        state={state({
          message: '拒否の文言',
          messageFrom: 'register',
          home: { registration: null, observation: OBSERVATION },
        })}
        actions={actions}
        now={NOW}
      />,
    );
    assert.match(
      registerRejected,
      new RegExp(
        `>${HOME_LABELS.register}</button></div><p role="alert"[^>]*>(?:<[^>]+>)*拒否の文言`,
        'u',
      ),
    );
    const statusRejected = html(
      <HomeNetworkPanel
        state={state({
          message: '読み取りの拒否',
          messageFrom: 'status',
          home: { registration: null, observation: OBSERVATION },
        })}
        actions={actions}
        now={NOW}
      />,
    );
    assert.match(
      statusRejected,
      new RegExp(
        `>${HOME_LABELS.reread}</button></div><p role="alert"[^>]*>(?:<[^>]+>)*読み取りの拒否`,
        'u',
      ),
    );
    // 「読み取り直す」は outline の小さなボタン（中枢の画面の「一覧を更新」と同じ重さ）。
    assert.match(
      String(buttonTag(statusRejected, HOME_LABELS.reread)),
      /button--outline/u,
    );
    // 登録の知らせ（一度だけ。閉じられる）。
    const done = html(
      <HomeNetworkPanel
        state={state({
          registered: true,
          home: { registration: REGISTRATION, observation: OBSERVATION },
        })}
        actions={actions}
        now={NOW}
      />,
    );
    assert.match(done, /自宅のネットワークを登録しました。/u);
    assert.match(done, /aria-label="知らせを閉じる"/u);
    actions.dismiss();
    assert.equal(dismissed(), 1);
    // p 要素に aria-label・aria-labelledby を付けない。
    for (const markup of [failed, loading, busy, done])
      assert.doesNotMatch(markup, /<p[^>]*aria-label/u);
  },
);

test(
  'home state: reads and registrations replace the view, rejections only set a message, sending clears the old message',
  { timeout: 10_000 },
  () => {
    const status: DesktopIpcRequest = {
      channel: 'desktop.home_status',
      request_id: '00000000-0000-4000-8000-000000000e71',
      payload: null,
    };
    const register: DesktopIpcRequest = {
      channel: 'desktop.home_register',
      request_id: '00000000-0000-4000-8000-000000000e72',
      payload: { ref: REF, include_ssid: true },
    };
    const home = { registration: null, observation: OBSERVATION };
    const reading = markHomeSending(
      { ...INITIAL_HOME_STATE, message: '前の文言', registered: true },
      status,
    );
    assert.equal(reading.reading, true);
    assert.equal(reading.message, null);
    assert.equal(reading.registered, false);
    const read = applyHomeResponse(reading, 'desktop.home_status', {
      request_id: status.request_id,
      channel: 'desktop.home_status',
      outcome: 'ok',
      home,
    });
    assert.equal(read.reading, false);
    assert.deepEqual(read.home, home);
    assert.equal(read.registered, false);
    const sending = markHomeSending(read, register);
    assert.equal(sending.busy, true);
    // OS の確認で「やめる」を選んだ・main が古い読み取りとして捨てたときは、何も出さず、表示と参照を変えない。
    for (const reason of [
      'confirmation_declined',
      'list_superseded',
    ] as const) {
      const quiet = applyHomeResponse(sending, 'desktop.home_register', {
        request_id: register.request_id,
        channel: 'desktop.home_register',
        outcome: 'rejected',
        reason,
      });
      assert.equal(quiet.busy, false);
      assert.equal(quiet.message, null);
      assert.equal(quiet.stale, false);
      assert.deepEqual(quiet.home, home);
    }
    const changed: DesktopIpcResponse = {
      request_id: register.request_id,
      channel: 'desktop.home_register',
      outcome: 'rejected',
      reason: 'home_network_changed',
    };
    const rejected = applyHomeResponse(
      sending,
      'desktop.home_register',
      changed,
    );
    assert.equal(rejected.busy, false);
    assert.deepEqual(rejected.home, home);
    assert.match(
      String(rejected.message),
      /ネットワークが変わった（または読み取れなくなった）ため、登録しませんでした/u,
    );
    // main が参照を捨てたので、読み取り直すまで登録のボタンを出さない。
    assert.equal(rejected.stale, true);
    const reread = applyHomeResponse(
      markHomeSending(rejected, status),
      'desktop.home_status',
      {
        request_id: status.request_id,
        channel: 'desktop.home_status',
        outcome: 'ok',
        home,
      },
    );
    assert.equal(reread.stale, false);
    assert.equal(reread.message, null);
    // 読み取りの拒否は読み取りの文言、登録の拒否は登録の文言。
    assert.match(
      String(
        applyHomeResponse(reading, 'desktop.home_status', {
          request_id: status.request_id,
          channel: 'desktop.home_status',
          outcome: 'rejected',
          reason: 'core_rejected',
        }).message,
      ),
      /自宅の登録の状態を受け取れませんでした/u,
    );
    assert.match(
      String(
        applyHomeResponse(sending, 'desktop.home_register', {
          ...changed,
          reason: 'core_rejected',
        }).message,
      ),
      /中枢が登録を受け付けませんでした/u,
    );
    // 結果が分からないときは参照を捨てていないので、ボタンは残す（自動では送り直さない）。
    assert.equal(
      applyHomeResponse(sending, 'desktop.home_register', {
        ...changed,
        reason: 'outcome_unknown',
      }).stale,
      false,
    );
    // 自宅の登録で言い方を変える拒否。
    assert.match(
      String(
        applyHomeResponse(sending, 'desktop.home_register', {
          ...changed,
          reason: 'entry_not_found',
        }).message,
      ),
      /読み取った内容が古くなっています/u,
    );
    assert.match(
      String(
        applyHomeResponse(sending, 'desktop.home_register', {
          ...changed,
          reason: 'outcome_unknown',
        }).message,
      ),
      /自動では送り直しません/u,
    );
    const done = applyHomeResponse(sending, 'desktop.home_register', {
      request_id: register.request_id,
      channel: 'desktop.home_register',
      outcome: 'ok',
      home: { registration: REGISTRATION, observation: OBSERVATION },
    });
    assert.equal(done.busy, false);
    assert.equal(done.registered, true);
    assert.deepEqual(done.home?.registration, REGISTRATION);
    const lost = applyHomeFailure(sending, 'desktop.home_register');
    assert.equal(lost.busy, false);
    assert.equal(lost.message, HOME_IPC_FAILURE_MESSAGE);
  },
);

test(
  'hub tabs: the home network tab appears only when its panel is given',
  { timeout: 10_000 },
  () => {
    const hub = hubActions({
      request: () => undefined,
      update: () => undefined,
    });
    const { actions } = capture();
    const withHome = html(
      <HubTabs
        state={{ ...INITIAL_HUB_STATE, claims: [] }}
        actions={hub}
        now={NOW}
        thisDevice={null}
        home={
          <HomeNetworkPanel
            state={state({
              home: { registration: null, observation: OBSERVATION },
            })}
            actions={actions}
            now={NOW}
          />
        }
        initialTab="home"
      />,
    );
    assert.match(
      withHome,
      /role="tab"[^>]*>自宅のネットワーク|自宅のネットワーク<\/span>/u,
    );
    assert.match(withHome, /このマシンが今つながっているネットワーク/u);
    const without = html(
      <HubTabs
        state={{ ...INITIAL_HUB_STATE, claims: [] }}
        actions={hub}
        now={NOW}
        thisDevice={null}
      />,
    );
    assert.doesNotMatch(without, /自宅のネットワーク/u);
  },
);

// PR #79 の見た目のレビュー（M1〜M7・L1〜L9）とコードレビュー（Low-2・Low-3）で直した表示。
test(
  'review: the Wi-Fi name choice follows the registration, missing elements and hidden Wi-Fi names say what to do next',
  { timeout: 10_000 },
  () => {
    const { actions } = capture();
    // M1: 登録済みでは、Checkbox の初期値は今の登録に合わせ、登録し直すときに反映されると書く。
    const checkedOff = html(
      <HomeNetworkPanel
        state={state({
          home: {
            registration: { ...REGISTRATION, ssid_registered: false },
            observation: OBSERVATION,
          },
        })}
        actions={actions}
        now={NOW}
      />,
    );
    assert.doesNotMatch(checkedOff, /data-selected="true"/u);
    assert.match(checkedOff, /登録し直すときに反映されます。/u);
    const checkedOn = html(
      <HomeNetworkPanel
        state={state({
          home: { registration: REGISTRATION, observation: OBSERVATION },
        })}
        actions={actions}
        now={NOW}
      />,
    );
    assert.match(checkedOn, /data-selected="true"/u);
    // 未登録では「登録し直すとき」を書かない。
    assert.doesNotMatch(
      html(
        <HomeNetworkPanel
          state={state({
            home: { registration: null, observation: OBSERVATION },
          })}
          actions={actions}
          now={NOW}
        />,
      ),
      /登録し直すときに反映されます/u,
    );
    // M2: 足りない要素を名指しする（両方とも読めないとき）。
    const neither = html(
      <CurrentNetworkSection
        state={state({
          home: {
            registration: null,
            observation: {
              ...OBSERVATION,
              ref: null,
              gateway_mac_tail: null,
              subnet: null,
            },
          },
        })}
        actions={actions}
        now={NOW}
      />,
    );
    assert.match(
      neither,
      /ルーターの MAC\u00a0アドレスとサブネットを読み取れないため、登録できません。/u,
    );
    // M3: 位置情報の許可で伏せられたときは、許可の場所と、そのまま登録したときの結果を本文の重さで書く。
    const redacted = html(
      <CurrentNetworkSection
        state={state({
          home: {
            registration: null,
            observation: {
              ...OBSERVATION,
              ssid_hint: null,
              ssid_unavailable_reason: 'redacted',
            },
          },
        })}
        actions={actions}
        now={NOW}
      />,
    );
    assert.match(
      redacted,
      /<p class="max-w-prose text-sm leading-6 text-foreground">Wi-Fi 名を読み取るには、macOS のシステム設定の「プライバシーとセキュリティ」&gt;「位置情報サービス」で Buddy を許可してから、「読み取り直す」を押してください。このまま登録すると、Wi-Fi 名は確かめません/u,
    );
    // 登録できないときは「このまま登録すると」を書かない。
    const redactedNoMac = html(
      <CurrentNetworkSection
        state={state({
          home: {
            registration: null,
            observation: {
              ...OBSERVATION,
              ref: null,
              gateway_mac_tail: null,
              ssid_hint: null,
              ssid_unavailable_reason: 'redacted',
            },
          },
        })}
        actions={actions}
        now={NOW}
      />,
    );
    assert.match(redactedNoMac, /位置情報サービス/u);
    assert.doesNotMatch(redactedNoMac, /このまま登録すると/u);
    // L2: 伏せたものがない（MAC も Wi-Fi 名も出ていない）ときは「表示しています」と書かない。
    assert.match(redactedNoMac, /に読み取りました。<\/p>/u);
    assert.match(
      html(
        <CurrentNetworkSection
          state={state({
            home: {
              registration: null,
              observation: {
                ...OBSERVATION,
                ssid_hint: null,
                ssid_unavailable_reason: 'ambiguous',
              },
            },
          })}
          actions={actions}
          now={NOW}
        />,
      ),
      /無線の接続が複数あるため、Wi-Fi 名を決められません。使わない Wi-Fi を切ってから/u,
    );
  },
);

test(
  'review: reading and registering do not overlap, the done notice is announced and a newer reading is kept',
  { timeout: 10_000 },
  () => {
    const { actions } = capture();
    const home = { registration: null, observation: OBSERVATION };
    // Low-2: 読み取りの最中は登録のボタンを押せない。
    const reading = html(
      <CurrentNetworkSection
        state={state({ home, reading: true })}
        actions={actions}
        now={NOW}
      />,
    );
    assert.match(String(buttonTag(reading, HOME_LABELS.register)), /disabled/u);
    // Low-3: 登録の結果を待つ間は読み取り直せない。
    const busy = html(
      <CurrentNetworkSection
        state={state({ home, busy: true })}
        actions={actions}
        now={NOW}
      />,
    );
    assert.match(String(buttonTag(busy, HOME_LABELS.reread)), /disabled/u);
    // L6: 受け取る前の 2 つの欄は同じ言葉で、ライブ領域は 1 つだけ。
    const loading = html(
      <HomeNetworkPanel
        state={state({ reading: true })}
        actions={actions}
        now={NOW}
      />,
    );
    assert.equal(loading.match(/読み取っています…/gu)?.length, 2);
    // Spinner は aria-hidden（記号は読み上げない）。ライブ領域の段は下の欄の 1 つだけ。
    assert.equal(loading.match(/<p role="status"/gu)?.length, 1);
    // M7: 登録の知らせは role="status"。
    assert.match(
      html(
        <HomeNetworkPanel
          state={state({ registered: true, home })}
          actions={actions}
          now={NOW}
        />,
      ),
      /role="status"[\s\S]*自宅のネットワークを登録しました。/u,
    );
    // Low-3: 登録の応答より新しい読み取りが届いていれば、表示（と参照）は新しい方を残す。
    const newer: DesktopHomeObservation = {
      ...OBSERVATION,
      ref: '00000000-0000-4000-8000-000000000e66',
      collected_at: '2030-10-05T03:00:05Z',
    };
    const applied = applyHomeResponse(
      state({ busy: true, home: { registration: null, observation: newer } }),
      'desktop.home_register',
      {
        request_id: '00000000-0000-4000-8000-000000000e73',
        channel: 'desktop.home_register',
        outcome: 'ok',
        home: { registration: REGISTRATION, observation: OBSERVATION },
      },
    );
    assert.deepEqual(applied.home, {
      registration: REGISTRATION,
      observation: newer,
    });
    // 読み取りの応答は、いつも置き換える。
    assert.deepEqual(
      applyHomeResponse(
        state({ home: { registration: null, observation: newer } }),
        'desktop.home_status',
        {
          request_id: '00000000-0000-4000-8000-000000000e74',
          channel: 'desktop.home_status',
          outcome: 'ok',
          home: { registration: null, observation: OBSERVATION },
        },
      ).home?.observation,
      OBSERVATION,
    );
  },
);

// b03-06 の 3 回目の修正に合わせた表示（接続を待つ間・止まっている間・タブの幅）。
test(
  'while waiting for the hub the home tab keeps its values and stops re-reading and registering; a stop banner keeps the only primary',
  { timeout: 10_000 },
  () => {
    const { actions, sent } = capture();
    const home = { registration: null, observation: OBSERVATION };
    const paused = html(
      <HomeNetworkPanel
        state={state({ home })}
        actions={actions}
        now={NOW}
        paused
      />,
    );
    assert.match(
      paused,
      /中枢との接続を待っています。接続が戻ると、読み取り直しと自宅の登録ができます。/u,
    );
    assert.match(paused, /··:··:··:··:53:01/u);
    assert.match(String(buttonTag(paused, HOME_LABELS.reread)), /disabled/u);
    assert.match(String(buttonTag(paused, HOME_LABELS.register)), /disabled/u);
    // 待つ間の文は読み上げの領域にしない（中枢の画面の Tabs の上の 1 行が受け持つ）。
    assert.doesNotMatch(
      paused,
      /role="status"[^>]*>(?:<[^>]+>|○)*中枢との接続を待っています/u,
    );
    assert.equal(sent.length, 0);
    // 入出力が止まっている間は、登録のボタンを primary にしない（停止の帯の再開が primary）。
    const stopped = html(
      <HomeNetworkPanel
        state={state({ home })}
        actions={actions}
        now={NOW}
        stopped
      />,
    );
    assert.match(
      String(buttonTag(stopped, HOME_LABELS.register)),
      /button--secondary/u,
    );
    // 自宅のネットワークのタブも、ほかのタブと同じ幅の約束（狭い幅で字と余白を小さくし、折り返さない）。
    const tabs = html(
      <HubTabs
        state={{ ...INITIAL_HUB_STATE, claims: [] }}
        actions={hubActions({
          request: () => undefined,
          update: () => undefined,
        })}
        now={NOW}
        thisDevice={null}
        home={<p>自宅の中身</p>}
      />,
    );
    assert.match(
      tabs,
      /class="[^"]*whitespace-nowrap px-1\.5 text-xs sm:px-4 sm:text-sm[^"]*"[^>]*>自宅のネットワーク/u,
    );
  },
);
