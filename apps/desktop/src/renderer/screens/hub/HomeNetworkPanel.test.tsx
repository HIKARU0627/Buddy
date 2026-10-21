// 中枢の画面の「自宅のネットワーク」のタブの試験（ADR 0022・0024・0026、B03-08）。
// サーバー描画（react-dom/server）で、未登録・登録済み・取得できない要素がある・読み取りの失敗の表示とボタンを確かめ、
// 押したときは確認（ConfirmRequest）を経て要求を送ることを onPress・onConfirm を呼んで確かめる。
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
import type { ConfirmRequest } from './ConfirmDialog.js';
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
  const asked: ConfirmRequest[] = [];
  let dismissed = 0;
  return {
    sent,
    asked,
    dismissed: () => dismissed,
    actions: homeActions(
      (built) => sent.push(built),
      () => {
        dismissed += 1;
      },
    ),
    onAsk: (request: ConfirmRequest) => asked.push(request),
  };
}

test(
  'unregistered: the masked network and a primary register button that asks before sending',
  { timeout: 10_000 },
  () => {
    const { sent, asked, actions, onAsk } = capture();
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
    assert.match(markup, /••:••:••:••:53:01/u);
    assert.match(markup, /最後の 2 組が 53:01（ほかは伏せています）/u);
    assert.match(markup, />192\.0\.2\.0\/24</u);
    assert.match(markup, /合••••/u);
    assert.match(markup, /（5 文字）/u);
    assert.match(markup, /先頭が「合」で、ほかは伏せています/u);
    // 時刻は端末の地域時間（今日でなければ月日を付ける）。
    assert.match(
      markup,
      /(?:10\/\d )?\d\d:\d\d:\d\d に読み取りました。一部を伏せて表示しています。/u,
    );
    const tag = buttonTag(markup, HOME_LABELS.register);
    assert(tag !== null, markup);
    assert.match(tag, /button--primary/u);
    assert.doesNotMatch(tag, /disabled/u);
    // 押しただけでは送らず、確認を出す。
    const buttons = pressables(
      CurrentNetworkSection({
        state: state({ home }),
        actions,
        now: NOW,
        onAsk,
      }),
    );
    buttons.get(HOME_LABELS.register)?.();
    assert.equal(sent.length, 0);
    assert.equal(asked.length, 1);
    const request = asked[0];
    assert(request);
    assert.equal(request.title, 'このネットワークを自宅として登録しますか');
    assert.equal(request.tone, 'accent');
    assert.equal(request.confirmLabel, '登録する');
    const body = html(request.body);
    assert.match(body, /••:••:••:••:53:01/u);
    assert.match(body, /Tailscale\s*で直接つながっているときだけ/u);
    // 確かめる値は、値ごとに別の段の大きな等幅で出す。
    assert.match(
      body,
      /ルーターの MAC（最後の 2 組）<\/p><p><span aria-hidden="true" class="font-mono tabular-nums text-2xl[^"]*">••:••:••:••:53:01/u,
    );
    assert.match(
      body,
      /class="font-mono tabular-nums text-2xl[^"]*">192\.0\.2\.0\/24/u,
    );
    assert.doesNotMatch(body, /置き換わり/u);
    request.onConfirm();
    assert.deepEqual(
      sent.map((built) => [built.channel, built.payload]),
      [['desktop.home_register', { ref: REF }]],
    );
    // 読み取り直すは確認なしで送る。
    buttons.get(HOME_LABELS.reread)?.();
    assert.equal(sent.at(-1)?.channel, 'desktop.home_status');
  },
);

test(
  'registered: the subnet, whether an SSID is registered and the last update, with a secondary re-register that warns about replacing',
  { timeout: 10_000 },
  () => {
    const { sent, asked, actions, onAsk } = capture();
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
    assert.match(markup, /登録しています（判定で比べます）/u);
    assert.match(markup, /最終更新/u);
    // 登録の時刻は「今」の前の日（地域時間で 10/3〜10/4）なので月日を付ける。
    assert.match(markup, /10\/[34] \d\d:\d\d:\d\d/u);
    assert.match(markup, /照合用の値（HMAC）だけ/u);
    assert.match(markup, /ありません（有線の接続、または読み取れません）/u);
    assert.match(markup, /SSID なしで登録します。/u);
    const tag = buttonTag(markup, HOME_LABELS.reregister);
    assert(tag !== null, markup);
    assert.match(tag, /button--secondary/u);
    assert.equal(buttonTag(markup, HOME_LABELS.register), null);
    pressables(
      CurrentNetworkSection({
        state: state({ home }),
        actions,
        now: NOW,
        onAsk,
      }),
    ).get(HOME_LABELS.reregister)?.();
    assert.equal(sent.length, 0);
    const request = asked[0];
    assert(request);
    assert.equal(request.title, '自宅の登録を今のネットワークで置き換えますか');
    assert.equal(request.confirmLabel, '登録し直す');
    assert.match(html(request.body), /置き換わり、元に戻せません/u);
    request.onConfirm();
    assert.deepEqual(sent[0]?.payload, { ref: REF });
    // SSID を登録していない登録。
    assert.match(
      html(
        <RegistrationSection
          registration={{ ...REGISTRATION, ssid_registered: false }}
          loaded
          now={NOW}
        />,
      ),
      /登録していません（判定で比べません）/u,
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
    assert.match(markup, /位置情報の許可がないため伏せられています/u);
    assert.match(markup, /両方が読み取れないと登録できません/u);
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
        onAsk={() => undefined}
      />,
    );
    assert.match(short, /•••/u);
    assert.match(short, /（3 文字）/u);
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
          onAsk={() => undefined}
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
    assert.match(loading, /読み込んでいます…/u);
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
    assert.match(stale, /role="alert"[^>]*>読み取り直してください/u);
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
        `>${HOME_LABELS.register}</button></div><p role="alert"[^>]*>拒否の文言`,
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
        `>${HOME_LABELS.reread}</button></div><p role="alert"[^>]*>読み取りの拒否`,
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
      payload: { ref: REF },
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
