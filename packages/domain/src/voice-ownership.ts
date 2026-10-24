// 音声所有権（音声リースの取得）の調停・中枢が返すリースの期限・リースの取り直し・停止の到達の状態の純粋な規則
// （B05-03、ADR 0046。設計 07 §5、10 §2A・§8）。時計は呼び出し側が中枢の単調時計で読んで渡す。
// 端末・中枢・OS には依存しない。リースの更新の可否そのものは leaseRenewalReasons（voice.ts）が持ち、ここでは足さない。

import type { StoredLease } from './voice.js';

// 複数の端末が同時に呼びかけ語を検知したときの窓（ms）。設計初期値（10 §8）。合格値ではない。
export const CONCURRENT_WAKE_WINDOW_MS = 300;
// 中枢が返すリースの期限の上限（ms）。heartbeat 2 秒・リース 6 秒は設計初期値（07 §5）。
export const CORE_LEASE_TTL_MAX_MS = 6000;
// 1 つのリース（lease_id）で受け付ける更新の数の上限。nonce の履歴（used_nonces）の保持量の上限で、2 秒ごとの更新で
// 1 時間分。超えたら端末は新しい lease_id で取り直す（原本に決めなし。ADR 0046・U69）。
export const LEASE_MAX_ACCEPTED_NONCES = 1800;

// 今の音声所有者（中枢の RAM の記録）。
export interface AudioOwnerView {
  readonly device_id: string;
  // この所有を受け付けた時刻（中枢の単調時計）。
  readonly granted_at_mono_ms: number;
  // 所有が有効か（リースが中枢の見積もりで期限内で、停止・喪失で取り消していない）。
  readonly valid: boolean;
}

export interface AudioClaim {
  readonly device_id: string;
  // 取得の要求を受けた時刻（中枢の単調時計）。
  readonly at_mono_ms: number;
}

export type AudioClaimDecision =
  | { readonly decision: 'grant'; readonly replaces: null }
  // 前の所有者の Live を中枢が先に閉じ、リースを取り消してから発行する。
  | {
      readonly decision: 'grant';
      readonly replaces: string;
      readonly why: 'takeover' | 'display_target_priority';
    }
  | { readonly decision: 'reject'; readonly code: 'audio_owned_elsewhere' };

// 音声リースの取得（新しい lease_id の初回の要求）を受けてよいか（10 §8）。
// - 所有者がいない・所有が無効・同じ端末なら受ける。
// - 別の端末が窓（300 ms）以内に先に取得していれば、要求した端末が表示先で、所有者が表示先でないときだけ表示先を優先する。
//   それ以外は 409（別の端末で会話中）。窓ちょうどは窓の内。
// - 窓より後の取得は端末の交代として受け、前の所有者の Live を先に閉じる（次に呼びかけた端末が所有権を取る）。
// - 時計を比べられない（経過が負・有限でない）ときは、他の端末の会話を閉じない側（拒否）に倒す。
export function arbitrateAudioClaim(
  owner: AudioOwnerView | null,
  claim: AudioClaim,
  displayTargetDeviceId: string | null,
  windowMs: number = CONCURRENT_WAKE_WINDOW_MS,
): AudioClaimDecision {
  if (owner === null || !owner.valid || owner.device_id === claim.device_id)
    return { decision: 'grant', replaces: null };
  const elapsed = claim.at_mono_ms - owner.granted_at_mono_ms;
  if (!Number.isFinite(elapsed) || elapsed < 0)
    return { decision: 'reject', code: 'audio_owned_elsewhere' };
  if (elapsed <= windowMs) {
    if (
      displayTargetDeviceId !== null &&
      displayTargetDeviceId === claim.device_id &&
      owner.device_id !== displayTargetDeviceId
    )
      return {
        decision: 'grant',
        replaces: owner.device_id,
        why: 'display_target_priority',
      };
    return { decision: 'reject', code: 'audio_owned_elsewhere' };
  }
  return { decision: 'grant', replaces: owner.device_id, why: 'takeover' };
}

// 中枢が返す ttl_ms。端末の求めた値と中枢の上限の小さい方（長いリースを中枢が渡さない）。
export function grantedLeaseTtlMs(
  requestedTtlMs: number,
  maxMs: number = CORE_LEASE_TTL_MAX_MS,
): number {
  return Math.min(requestedTtlMs, maxMs);
}

// 同じリースで受け付けた更新が上限に達したか（達していれば更新を拒否し、端末に取り直させる）。初回（stored が null）は対象外。
export function leaseRotationRequired(
  stored: StoredLease | null,
  max: number = LEASE_MAX_ACCEPTED_NONCES,
): boolean {
  return stored !== null && stored.used_nonces.length >= max;
}

export type IoStopDeviceState = 'confirmed' | 'awaiting_ack' | 'lease_expired';

export interface IoStopTarget {
  readonly device_id: string;
  // 停止を要求した端末（ローカルで先に止めてから要求する。07 §2）。
  readonly requester: boolean;
  // 中枢が見積もったその端末のリースの期限（中枢の単調時計。最後に更新を受け付けた時刻 + 返した ttl）。
  // リースを持っていなければ null。
  readonly lease_expires_at_mono_ms: number | null;
}

export interface IoStopReach {
  readonly devices: readonly {
    readonly device_id: string;
    readonly stop_state: IoStopDeviceState;
  }[];
  readonly all_confirmed: boolean;
}

// 停止の到達の状態（07 §5）。停止確認済みは要求した端末だけ（他の端末の ACK の経路は原本に決めなし。U70）。
// リースの失効は、端末が自分で止まる期限が過ぎたことで、停止の確認ではない（all_confirmed に数えない）。
// リースを持たない端末は、端末内の収音（KWS・③）を止めた確認がないので応答待ち。時計を比べられなければ応答待ち。
export function ioStopReach(
  targets: readonly IoStopTarget[],
  nowMonoMs: number,
): IoStopReach {
  const devices = targets.map((target) => {
    const expires = target.lease_expires_at_mono_ms;
    const stop_state: IoStopDeviceState = target.requester
      ? 'confirmed'
      : expires !== null &&
          Number.isFinite(nowMonoMs) &&
          Number.isFinite(expires) &&
          nowMonoMs >= expires
        ? 'lease_expired'
        : 'awaiting_ack';
    return { device_id: target.device_id, stop_state };
  });
  return {
    devices,
    all_confirmed:
      devices.length > 0 &&
      devices.every((device) => device.stop_state === 'confirmed'),
  };
}
