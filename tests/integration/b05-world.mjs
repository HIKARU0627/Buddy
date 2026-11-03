// B05 専用の「世界」。端末側（デスクトップの VoiceController・DesktopDeviceController・模擬の音声レンダラー）と、
// 中枢側（VoiceControl・DB worker（一時ディレクトリ）・予算の門・模擬の Live の provider）を、1 本の手で進める時計でつなぐ。
// HTTP・WSS・Electron・マイク・WebRTC・実 API は通さない（端末の中枢への口は、VoiceControl の同じ入口を直接呼ぶ）。
// 製品の src は直接 import せず、ビルド済みの dist だけを読み込む（apps/*/dist）。期待値はここでは作らない（b05-expectations.json）。
import assert from 'node:assert/strict';
import {
  A,
  CORE,
  DEV_A,
  SCOPE_A,
  SESSION,
  waitUntil,
  withRig,
} from '../../apps/core/dist/voice-rig-test-support.js';
import {
  createDesktopContract,
  loadContractSchema,
} from '../../apps/desktop/dist/main/contract.js';
import { DesktopDeviceController } from '../../apps/desktop/dist/main/device-controller.js';
import { VoiceConsentStore } from '../../apps/desktop/dist/main/voice-consent.js';
import { VoiceReplyModeStore } from '../../apps/desktop/dist/main/voice-reply-mode.js';
import { VoiceController } from '../../apps/desktop/dist/main/voice-controller.js';
import {
  MockVoiceRenderer,
  NO_FAULTS,
} from '../../apps/desktop/dist/main/voice-mock-renderer.js';

export { A, CORE, DEV_A, NO_FAULTS, SCOPE_A, SESSION, waitUntil };

// 合成の PCM の 1 つの区間（フレームを 20 ms として数え、PCM_BATCH 個を 1 つの timer でまとめて進める）。
const PCM_FRAME_MS = 20;
const PCM_BATCH = 5;
const WALL_BASE = Date.parse('2030-10-15T00:00:00.000Z');

// 順序だけを固定する PRNG（b07 と同じ。受付の ID・鍵などの乱数は固定しない）。
export function shuffled(values, seed) {
  let state = seed >>> 0;
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// 端末の模擬の音声レンダラー + 端末状態 + 音声の制御を、中枢の VoiceControl へつなぐ。
// options.faults: 作り直しの順の故障（足りなければ故障なし）。
// options.dialog: 同意の確認ダイアログの答え（順に使う。既定は 1 回「同意する」）。
// options.core: 中枢側の VoiceControl の追加の設定。
// options.voiceLimit: 音声の枠の上限（合成の XTS）。
export async function withWorld(options, body) {
  await withRig(
    async (rig) => {
      const clock = rig.clock;
      const wall = () => WALL_BASE + clock.mono();
      const contract = createDesktopContract(loadContractSchema());
      let ids = 0;
      const newId = () => {
        ids += 1;
        return `00000000-0000-4000-8000-${ids.toString(16).padStart(12, '0')}`;
      };
      const ipcMs = options.ipcMs ?? 1;
      const slots = [];
      const sent = [];
      const acks = [];
      const kills = [];
      const closedToCore = [];
      const renewals = [];
      const renewalBodies = [];
      const silence = [];
      const renewResponses = [];
      const coreEvents = [];
      const logs = [];
      const dialogs = [];
      const answers = [...(options.dialog ?? [true])];
      let consentRecord = null;
      // 中枢のイベントを購読した端末（VoiceController）。作った後で代入する。
      let voice = null;
      let device = null;

      const setTimer = (ms, run) => {
        const handle = clock.set(ms, run);
        return () => clock.clear(handle);
      };

      const slot = (generation) =>
        slots.find((entry) => entry.generation === generation) ?? null;

      const renderer = {
        create(generation) {
          const faults = options.faults?.[generation - 1] ?? NO_FAULTS;
          const entry = {
            generation,
            alive: true,
            mock: new MockVoiceRenderer(
              {
                ack: (ack) => {
                  acks.push({ at: clock.mono(), ack });
                  setTimer(ipcMs, () => {
                    // 強制終了した音声レンダラーの送りかけの ACK は main に届かない（プロセスがない）。
                    if (entry.alive) voice?.receiveAck(generation, ack);
                  });
                },
                schedule: (ms, task) =>
                  setTimer(ms, () => {
                    if (entry.alive) task();
                  }),
                wallNow: () => new Date(wall()).toISOString(),
              },
              faults,
            ),
          };
          slots.push(entry);
          const tick = () => {
            if (!entry.alive) return;
            for (let i = 0; i < PCM_BATCH; i += 1) entry.mock.tick();
            setTimer(PCM_FRAME_MS * PCM_BATCH, tick);
          };
          setTimer(PCM_FRAME_MS * PCM_BATCH, tick);
          setTimer(options.loadMs ?? 5, () => {
            if (entry.alive) voice?.rendererReady(generation);
          });
        },
        send(generation, request) {
          const entry = slot(generation);
          if (entry === null || !entry.alive) return false;
          sent.push({
            generation,
            at: clock.mono(),
            channel: request.channel,
            reason: request.payload.reason ?? null,
            payload: structuredClone(request.payload),
          });
          setTimer(ipcMs, () => {
            if (entry.alive) entry.mock.receive(structuredClone(request));
          });
          return true;
        },
        kill(generation) {
          kills.push({ at: clock.mono(), generation });
          const entry = slot(generation);
          if (entry !== null) entry.alive = false;
          voice?.rendererGone(generation, 'closed');
        },
      };

      const lockHeader = () => {
        const state = device.state.lockState;
        return state === 'unknown' ? null : state;
      };

      const core = {
        context: () => ({
          deviceId: DEV_A,
          coreInstanceId: CORE,
          commandScopeId: SCOPE_A,
        }),
        renew: async (request) => {
          renewals.push({ at: clock.mono(), io_epoch: request.io_epoch });
          renewalBodies.push(structuredClone(request));
          const result = await rig.voice.renewLease(A, request, lockHeader());
          renewResponses.push({
            at: clock.mono(),
            status: result.status,
            result: result.body.result ?? null,
            reasons: result.body.reasons ?? [],
          });
          // 受け付けた・拒否した応答はそのまま端末の規則へ渡す。形が違うもの（エラー）は結果不明にする。
          return result.status === 200 ? result.body : null;
        },
        openLive: async () => {
          const result = await rig.voice.createLiveSession(A, {
            request_id: newId(),
            command_scope_id: SCOPE_A,
            session_id: SESSION,
            purpose: 'conversation',
            sdp_offer: 'v=0 synthetic-offer',
          });
          if (result.status === 201)
            return {
              kind: 'answer',
              liveSessionId: result.body.live_session_id,
              sdpAnswer: result.body.sdp_answer,
              audioEpoch: result.body.audio_epoch,
              sessionEpoch: result.body.session_epoch,
            };
          if (result.status >= 400 && result.status < 500)
            return { kind: 'refused' };
          return { kind: 'unknown' };
        },
        closeLive: (liveSessionId, reason) => {
          closedToCore.push({ at: clock.mono(), reason });
          const live = rig.voice.liveRecord(liveSessionId);
          if (live === null) return;
          void rig.voice.closeLiveSession(A, liveSessionId, {
            request_id: newId(),
            audio_epoch: live.audio_epoch,
            reason,
          });
        },
      };

      device = new DesktopDeviceController({
        contract,
        initial: { io_epoch: '0', stop_scope: 'none' },
        now: () => new Date(wall()),
        persist: () => undefined,
        onNotification: (notification) => {
          if (notification.channel === 'desktop.state_changed')
            voice?.deviceChanged(device.state);
        },
      });

      const consent = new VoiceConsentStore({
        load: () => consentRecord,
        save: (record) => {
          consentRecord = record;
        },
        remove: () => {
          consentRecord = null;
        },
        now: () => new Date(wall()).toISOString(),
        log: (code) => logs.push(code),
      });

      voice = new VoiceController({
        enabled: true,
        contract,
        renderer,
        core,
        clock: { mono: clock.mono, wall, setTimer, newId },
        consent,
        confirmConsent: () => {
          dialogs.push(clock.mono());
          return Promise.resolve(answers.shift() ?? false);
        },
        cancelConsent: () => undefined,
        stopDevice: () => device.stopFromMain(),
        replyMode: new VoiceReplyModeStore({
          load: () => undefined,
          save: () => undefined,
          log: (code) => logs.push(code),
        }),
        onSilenceExtension: (ms) => silence.push({ at: clock.mono(), ms }),
        onChange: () => {
          if (voice === null) return;
          device.setVoice({
            enabled: true,
            state: voice.statusVoice(),
          });
        },
        log: (code) => logs.push(code),
      });
      voice.deviceChanged(device.state);

      // 中枢のイベント（WSS の {type:"voice"} に相当）を、端末の音声の制御へ渡す。
      rig.voice.subscribe(DEV_A, (event) => {
        coreEvents.push({ at: clock.mono(), event });
        voice.onCoreVoiceEvent(event);
      });

      // 模擬の Live の provider のサイドバンドは、既定では ping に pong を返す（健全）。healthy を false にすると返さない
      // （X25 の ping_timeout）。pong を返す・返さないは試験が決め、provider の応答の中身（音声）は作らない。
      // provider 自身の「真の使用時間」: 作成の時刻と、閉じる要求（session.close）を受けた時刻。Core の精算の秒数と
      // 突き合わせる。providerCloses が 'auto' なら、閉じる要求の 50 ms 後に、真の秒数（切り捨て）で session.closed を返す。
      const providerTruth = [];
      const provider = rig.provider;
      const create = provider.createSession.bind(provider);
      provider.createSession = (input) => {
        providerTruth.push({
          live_session_id: input.live_session_id,
          created_at: clock.mono(),
          close_requested_at: null,
        });
        return create(input);
      };
      const connect = provider.connectSideband.bind(provider);
      provider.connectSideband = async (providerSessionId, handlers) => {
        const sideband = await connect(providerSessionId, handlers);
        if (sideband !== null) {
          const ping = sideband.ping.bind(sideband);
          sideband.ping = () => {
            ping();
            if (world.sidebandHealthy) {
              world.lastPongAt = clock.mono();
              sideband.pong();
            }
          };
          const sendClose = sideband.sendClose.bind(sideband);
          const liveId = providerSessionId.slice('prov-'.length);
          sideband.sendClose = () => {
            sendClose();
            const truth = providerTruth.find(
              (entry) => entry.live_session_id === liveId,
            );
            if (truth === undefined || truth.close_requested_at !== null)
              return;
            truth.close_requested_at = clock.mono();
            if (world.providerCloses === 'auto')
              setTimer(50, () =>
                sideband.closed(
                  Math.floor(
                    (truth.close_requested_at - truth.created_at) / 1000,
                  ),
                ),
              );
          };
        }
        return sideband;
      };

      const world = {
        sidebandHealthy: true,
        lastPongAt: null,
        renewalBodies,
        silence,
        providerCloses: 'auto',
        providerTruth,
        rig,
        clock,
        ctl: voice,
        device,
        contract,
        slots,
        sent,
        acks,
        kills,
        closedToCore,
        renewals,
        renewResponses,
        coreEvents,
        logs,
        dialogs,
        newId,
        wall,
        current: () => slots.at(-1) ?? null,
        stats: () => slots.at(-1)?.mock.stats ?? null,
        // 相手（モデル）の音声が届く（模擬のレンダラーの受信トラック）。epoch は音声を作った時点の出力の世代（省略は今の世代）。
        remoteAudio: (epoch) =>
          slots
            .at(-1)
            ?.mock.remoteAudioArrived(
              epoch ?? slots.at(-1).mock.stats.epochs.output ?? '0',
            ),
        // 時計を進める（端末と中枢の timer を時刻の順に動かし、動かすたびに両側の処理を消化する）。
        advance: (ms) => clock.advance(ms),
        // 条件が満たされるまで、時計を進めずに両側の処理を消化する（実時間の上限つき）。
        until: (description, done, limitMs) =>
          waitUntil(rig, description, done, limitMs),
        // 条件が満たされるまで、時計を stepMs ずつ進める（模擬の経過時間の上限つき）。
        async advanceUntil(description, done, stepMs = 1, maxMs = 2000) {
          let elapsed = 0;
          while (!done()) {
            assert.ok(
              elapsed < maxMs,
              `${description} が模擬の ${maxMs} ms 以内に確認できませんでした`,
            );
            await world.advance(stepMs);
            elapsed += stepMs;
            // 条件がまだなら、中枢の保存（DB worker）など実時間で進む処理に追いつく機会を与えてから、時計を進める。
            // 実時間の待ちは短く区切り、条件が満たされたらすぐ抜ける（模擬の時間は進めない）。負荷の高い実行機でも、模擬の時間だけが
            // 先に進んで上限に達しないようにする。
            for (let turn = 0; turn < 20 && !done(); turn += 1) {
              await rig.wait();
              await new Promise((resolve) => setTimeout(resolve, 2));
            }
          }
          return elapsed;
        },
        // 画面からの明示再開（desktop.io_resume）。結果は { outcome, reason? }。
        resumeFromScreen({ focused = true, epoch = null } = {}) {
          const outcome = device.handleIpc(
            'desktop.io_resume',
            {
              request_id: newId(),
              channel: 'desktop.io_resume',
              payload: { expected_io_epoch: epoch ?? device.state.ioEpoch },
            },
            { trustedSender: true, windowFocused: focused },
          ).response;
          return outcome.outcome === 'ok'
            ? { outcome: 'ok' }
            : { outcome: outcome.outcome, reason: outcome.reason };
        },
        // 「続ける」で音声の会話を始め、模擬の音声レンダラーが開始を適用するまで待つ。
        async begin() {
          await world.advanceUntil(
            '音声レンダラーの準備',
            () => voice.view().visibility === 'shown',
          );
          const outcome = await voice.continueConversation();
          await world.advanceUntil(
            '会話の開始（模擬の音声レンダラーが送信を始める）',
            () => world.stats()?.sending === true,
          );
          return outcome;
        },
      };
      // 起動直後に OS へ問い合わせてロック解除を確かめる（ロック状態が不明のうちは入出力を許可しない）。
      device.applyLockQuery('unlock_screen');
      await world.advance(10);
      await body(world);
    },
    options.core ?? {},
    options.voiceLimit,
  );
}
