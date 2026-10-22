// HTTP の経路ごとに Core が行う検査と、再送・イベント・リース・停止・ペアリングの規則
// （設計 07 §2〜§5、02 端末登録と接続、11 §10、ADR 0009）。
// 形式（OpenAPI と JSON Schema）の検査はこの前に別に行い、不正なら invalid_input（422）にする。

export const MAX_CONTROL_JSON_BYTES = 262_144;
// 認証前の要求の上限（02 の「認証前のサイズ制限」。値は設計初期値、ADR 0009）。
export const MAX_PREAUTH_JSON_BYTES = 16_384;

export type CoreCheck =
  | 'device_token'
  | 'claim_secret'
  | 'home_network'
  | 'command_scope'
  | 'unlocked'
  | 'screen_operation'
  | 'hub_screen'
  | 'audio_owner'
  | 'expected_revision';

const READ = ['device_token', 'home_network'] as const;
const COMMAND = [...READ, 'command_scope', 'unlocked'] as const;
const SCREEN = [...COMMAND, 'screen_operation'] as const;

// operationId ごとの検査。OpenAPI の x-buddy-core-checks と一致することを試験する。
export const ROUTE_CHECKS: Readonly<Record<string, readonly CoreCheck[]>> = {
  getBootstrap: READ,
  getSnapshot: READ,
  getEvents: READ,
  streamEvents: READ,
  getOperation: READ,
  listAutoActions: READ,
  listDevices: [...READ, 'unlocked'],
  listConnections: [...READ, 'unlocked'],
  createSession: COMMAND,
  postTurn: COMMAND,
  handoffSession: [...SCREEN, 'expected_revision'],
  previewOperation: COMMAND,
  approveOperation: [...SCREEN, 'expected_revision'],
  cancelOperation: [...COMMAND, 'expected_revision'],
  reconcileOperation: [...COMMAND, 'expected_revision'],
  retryOperation: [...SCREEN, 'expected_revision'],
  undoAutoAction: [...SCREEN, 'expected_revision'],
  resumeSafety: [...SCREEN, 'expected_revision'],
  // 停止は版もロック解除も求めない。古い接続範囲だけは新しい接続で送り直させる。
  stopIo: [...READ, 'command_scope'],
  resumeIo: [...SCREEN, 'expected_revision'],
  createLiveSession: [...COMMAND, 'audio_owner'],
  // 終了の通知はいつでも受け付ける。中枢はリース切れでも自分から閉じる。
  closeLiveSession: READ,
  startPairing: [...SCREEN, 'hub_screen'],
  claimPairing: ['home_network'],
  decidePairingClaim: [...SCREEN, 'hub_screen'],
  pickupPairingToken: ['home_network', 'claim_secret'],
  // 失効も中枢の画面だけ（本人の判断 2026-10-21、B03-07、ADR 0021）。乗っ取られた端末に他の端末を締め出させない。
  revokeDevice: [...SCREEN, 'hub_screen'],
  startOAuth: [...SCREEN, 'hub_screen'],
  updateConnectionTargets: [...SCREEN, 'expected_revision'],
  disconnectConnection: [...SCREEN, 'expected_revision'],
  // 自宅の指紋の報告（B03-03、ADR 0022）。報告そのものが自宅判定の材料なので home_network を求めない。
  reportHomeFingerprint: ['device_token'],
  // 自宅の登録は中枢の画面からだけ（家ごとに 1 つ）。
  registerHome: [...SCREEN, 'hub_screen'],
};

export interface RequestContext {
  readonly bodyBytes: number;
  // 端末トークンが有効で失効していない。
  readonly deviceAuthenticated: boolean;
  readonly claimSecretMatches: boolean;
  // 自宅判定（11 §10）。中枢と同じマシンのクライアントは Core が免除して true にする。
  readonly homeNetwork: boolean;
  readonly commandScope: 'current' | 'stale';
  readonly lockState: 'unlocked' | 'locked' | 'unknown';
  readonly screenOperation: boolean;
  readonly hubLocal: boolean;
  readonly audioOwner: 'self' | 'other' | 'none';
  readonly revisionMatches: boolean;
}

export type Admission =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly code: string };

const reject = (status: number, code: string): Admission => ({
  ok: false,
  status,
  code,
});

// 経路の検査を表の順に行い、最初に満たさない検査の拒否を返す。
// 対象の存在・所有・状態遷移の可否はこの後に domain の各規則（operations.ts など）で判定する。
export function admitRequest(
  operationId: string,
  context: RequestContext,
): Admission {
  const checks = ROUTE_CHECKS[operationId];
  if (!checks) return reject(404, 'invalid_input');
  const limit = checks.includes('device_token')
    ? MAX_CONTROL_JSON_BYTES
    : MAX_PREAUTH_JSON_BYTES;
  if (context.bodyBytes > limit) return reject(413, 'payload_too_large');
  for (const check of checks) {
    if (check === 'device_token' && !context.deviceAuthenticated)
      return reject(401, 'unauthenticated');
    if (check === 'claim_secret' && !context.claimSecretMatches)
      return reject(401, 'unauthenticated');
    if (check === 'home_network' && !context.homeNetwork)
      return reject(403, 'outside_home_network');
    if (check === 'command_scope' && context.commandScope !== 'current')
      return reject(410, 'expired_scope');
    // ロック状態が取得できなければ解除済みと扱わない（07 §2）。
    if (check === 'unlocked' && context.lockState !== 'unlocked')
      return reject(403, 'device_locked');
    if (check === 'screen_operation' && !context.screenOperation)
      return reject(403, 'screen_operation_required');
    if (check === 'hub_screen' && !context.hubLocal)
      return reject(403, 'hub_screen_required');
    if (check === 'audio_owner' && context.audioOwner === 'other')
      return reject(409, 'audio_owned_elsewhere');
    if (check === 'audio_owner' && context.audioOwner === 'none')
      return reject(403, 'audio_ownership_required');
    if (check === 'expected_revision' && !context.revisionMatches)
      return reject(409, 'conflict');
  }
  return { ok: true };
}

export interface StoredReceipt {
  readonly command_scope_id: string;
  readonly request_id: string;
  readonly request_hash: string;
}

// 同じ接続範囲・request_id・同じ要求内容は保存済みの受付結果へ。内容が違う再利用は 409（07 §3、X04）。
export function replayDecision(
  receipts: readonly StoredReceipt[],
  request: StoredReceipt,
): 'new' | 'replay' | 'conflict' {
  const found = receipts.find(
    (receipt) =>
      receipt.command_scope_id === request.command_scope_id &&
      receipt.request_id === request.request_id,
  );
  if (!found) return 'new';
  return found.request_hash === request.request_hash ? 'replay' : 'conflict';
}

export interface ClientView {
  readonly store_generation: string;
  readonly revisions: Readonly<Record<string, string>>;
  readonly seen_event_ids: readonly string[];
}

export interface EventLike {
  readonly event_id: string;
  readonly store_generation: string;
  readonly operation_id: string;
  readonly state_revision: string;
}

// スナップショットの後のイベントを端末へ反映する（07 §4、X11）。重複と古い版は無害に捨て、
// 連番の飛びだけでは欠落と判定しない。DB 世代が違えば再スナップショット。
export function applyEvents(
  view: ClientView,
  events: readonly EventLike[],
): {
  readonly view: ClientView;
  readonly applied: string[];
  readonly ignored: { readonly event_id: string; readonly reason: string }[];
  readonly resnapshot: boolean;
} {
  const revisions: Record<string, string> = { ...view.revisions };
  const seen = new Set(view.seen_event_ids);
  const applied: string[] = [];
  const ignored: { event_id: string; reason: string }[] = [];
  for (const event of events) {
    if (event.store_generation !== view.store_generation)
      return { view, applied: [], ignored: [], resnapshot: true };
    if (seen.has(event.event_id)) {
      ignored.push({ event_id: event.event_id, reason: 'duplicate' });
      continue;
    }
    seen.add(event.event_id);
    const current = revisions[event.operation_id];
    if (
      current !== undefined &&
      BigInt(event.state_revision) <= BigInt(current)
    ) {
      ignored.push({ event_id: event.event_id, reason: 'stale' });
      continue;
    }
    revisions[event.operation_id] = event.state_revision;
    applied.push(event.event_id);
  }
  return {
    view: {
      store_generation: view.store_generation,
      revisions,
      seen_event_ids: [...seen],
    },
    applied,
    ignored,
    resnapshot: false,
  };
}

export interface LeaseState {
  readonly core_instance_id: string;
  readonly command_scope_id: string;
  readonly io_epoch: string;
  readonly ttl_ms: number;
  // 更新要求を送った時点の端末の単調時計（ms）。
  readonly requested_at_mono_ms: number;
}

// リースで Live を開いたり機密表示を続けたりしてよいか（07 §5、X13）。
// 期限は要求を送った時点から数え、遅れて届いた応答の受信時刻から足し直さない。
export function leaseReasons(
  lease: LeaseState,
  current: {
    readonly core_instance_id: string;
    readonly command_scope_id: string;
    readonly io_epoch: string;
    readonly now_mono_ms: number;
    readonly clock_consistent: boolean;
  },
): string[] {
  const reasons: string[] = [];
  if (lease.core_instance_id !== current.core_instance_id)
    reasons.push('core_restarted');
  if (lease.command_scope_id !== current.command_scope_id)
    reasons.push('scope_changed');
  if (BigInt(lease.io_epoch) < BigInt(current.io_epoch))
    reasons.push('stale_io_epoch');
  if (!current.clock_consistent) reasons.push('clock_inconsistent');
  else if (current.now_mono_ms >= lease.requested_at_mono_ms + lease.ttl_ms)
    reasons.push('expired');
  return reasons;
}

// 停止の到達状況（07 §5、X14）。応答のない端末は、リースの期限を過ぎても確認済みにしない。
export function ioStopProgress(
  devices: readonly {
    readonly device_id: string;
    readonly acknowledged: boolean;
    readonly lease_expires_mono_ms: number;
  }[],
  nowMonoMs: number,
): {
  readonly devices: {
    readonly device_id: string;
    readonly stop_state: string;
  }[];
  readonly all_confirmed: boolean;
} {
  const states = devices.map((device) => ({
    device_id: device.device_id,
    stop_state: device.acknowledged
      ? 'confirmed'
      : nowMonoMs >= device.lease_expires_mono_ms
        ? 'lease_expired'
        : 'awaiting_ack',
  }));
  return {
    devices: states,
    all_confirmed: states.every((state) => state.stop_state === 'confirmed'),
  };
}

export interface PairingState {
  readonly pairing_code: string;
  readonly expires_at: string;
  readonly attempts_left: number;
  readonly used: boolean;
}

// ワンタイムコードの照合（02 端末登録と接続）。期限切れ・使用済み・失敗回数の上限で無効にし、
// 失敗のたびに残り回数を減らす。理由はどれも pairing_failed として返し、区別を外へ出さない。
export function checkPairingCode(
  pairing: PairingState,
  code: string,
  now: string,
): {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly pairing: PairingState;
} {
  if (pairing.used) return { ok: false, reason: 'used', pairing };
  if (Date.parse(now) >= Date.parse(pairing.expires_at))
    return { ok: false, reason: 'expired', pairing };
  if (pairing.attempts_left <= 0)
    return { ok: false, reason: 'attempts_exhausted', pairing };
  if (code !== pairing.pairing_code)
    return {
      ok: false,
      reason: 'code_mismatch',
      pairing: { ...pairing, attempts_left: pairing.attempts_left - 1 },
    };
  return { ok: true, reason: null, pairing: { ...pairing, used: true } };
}

// 承認済みの申請と申請用の秘密で、トークンを 1 回だけ渡す（ADR 0009）。
export function tokenPickup(
  claim: {
    readonly status:
      'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';
    readonly expires_at: string;
  },
  secretMatches: boolean,
  now: string,
): { readonly status: number; readonly code: string | null } {
  if (!secretMatches) return { status: 401, code: 'unauthenticated' };
  if (claim.status === 'consumed' || claim.status === 'rejected')
    return { status: 410, code: 'pairing_failed' };
  if (
    claim.status === 'expired' ||
    Date.parse(now) >= Date.parse(claim.expires_at)
  )
    return { status: 410, code: 'pairing_failed' };
  if (claim.status === 'pending') return { status: 409, code: 'conflict' };
  return { status: 200, code: null };
}

// 端末が使える API の版か。major が一致するときだけ使い、違えば更新を求める。
export function apiCompatibility(
  serverVersion: string,
  clientMajors: readonly number[],
): 'compatible' | 'upgrade_required' {
  const major = Number(serverVersion.split('.')[0]);
  return clientMajors.includes(major) ? 'compatible' : 'upgrade_required';
}
