// 中枢との音声の経路（リースの更新・Live の接続・閉じる要求。B05-06、ADR 0050）。Electron に依存しない。
// - 製品の起動（unavailableVoiceCorePort）: 使えない。中枢の Live の provider がまだない（Live の接続は 503）、音声レンダラーの
//   SDP offer を main へ渡す経路と会話（session_id）の結び付けが決まっていない、端末の io_epoch と中枢の世代の突き合わせ
//   （ADR 0046 の U70）が終わっていない、の 3 つが揃うまで、中枢へ音声のリースも Live の接続も求めない（U91）。
// - 開発の模擬（mockVoiceCorePort）: 端末の中だけで答える模擬の中枢。合成の値だけを返し、外部へ通信しない。
//   --buddy-voice=mock のときだけ使う（配布版では使えない）。
import type { AudioReason } from '@buddy/domain';
import type { LiveOpenResult, VoiceCorePort } from './voice-controller.js';
import type {
  LeaseCoreContext,
  LeaseRenewalBody,
} from './voice-lease-keeper.js';

export function unavailableVoiceCorePort(): VoiceCorePort {
  return {
    context: () => null,
    renew: async () => null,
    openLive: async () => ({ kind: 'refused' }),
    closeLive: () => undefined,
  };
}

export interface MockVoiceCoreOptions {
  readonly newId: () => string;
  // 応答の遅延（ms）。0 なら次の処理の順番で返す。
  readonly delay: (ms: number) => Promise<void>;
  readonly renewDelayMs?: number;
  readonly openDelayMs?: number;
  readonly log?: (code: string) => void;
}

// 模擬の中枢。リースは要求の lease_id・nonce をそのまま返して受け付け（ttl 6 秒）、Live の接続は合成の answer と、
// 接続ごとに 1 つ進めた音声・会話の世代を返す。閉じる要求は記録だけ。
export function mockVoiceCorePort(
  options: MockVoiceCoreOptions,
): VoiceCorePort & {
  readonly closed: readonly {
    readonly id: string;
    readonly reason: AudioReason;
  }[];
} {
  const context: LeaseCoreContext = {
    deviceId: options.newId(),
    coreInstanceId: options.newId(),
    commandScopeId: options.newId(),
  };
  let epoch = 0n;
  const closed: { id: string; reason: AudioReason }[] = [];
  return {
    closed,
    context: () => context,
    renew: async (body: LeaseRenewalBody) => {
      await options.delay(options.renewDelayMs ?? 0);
      // 契約の LeaseRenewalResponse の形（受け付けたときは空の reasons を持つ）。
      const response = {
        request_id: body.request_id,
        lease_id: body.lease_id,
        nonce: body.nonce,
        result: 'renewed' as const,
        reasons: [] as string[],
        ttl_ms: body.ttl_ms,
      };
      return response;
    },
    openLive: async (): Promise<LiveOpenResult> => {
      await options.delay(options.openDelayMs ?? 0);
      epoch += 1n;
      return {
        kind: 'answer',
        liveSessionId: options.newId(),
        // 合成の SDP answer（実際の接続には使えない）。
        sdpAnswer: 'v=0\r\ns=buddy-mock\r\n',
        audioEpoch: epoch.toString(),
        sessionEpoch: epoch.toString(),
      };
    },
    closeLive: (id, reason) => {
      closed.push({ id, reason });
      options.log?.(`voice_mock_core_close:${reason}`);
    },
  };
}
