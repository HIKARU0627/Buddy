// 中枢側の Tailscale の状態の取得（設計 11 §10、X42、ADR 0022）。
//
// `tailscale status --json` を CommandRunner 経由で実行し（shell を通さない）、接続元のアドレスから
// ピアを特定して、直接経路か（CurAddr）・DERP か（Relay）・ピアの中継か（PeerRelay）を返す。
// 自宅 LAN の中かどうかの判定は domain の homeNetworkDecision が行う（ここではアドレスを渡すだけ）。
// - 取得できない・読めない・Tailscale が動いていない（BackendState が Running でない）は unavailable。
//   推測で直接経路にしない。
// - 状態は短い間（既定 5 秒）だけ保持し、それを過ぎたら取り直す（「短い周期で取り直す」）。失敗も同じ間だけ保持する。
// - 出力（ホスト名・アドレス）はログ・例外・理由に入れない。
// 試験では模擬の runner に合成の JSON を渡し、実機の tailscale は呼ばない。
import type { CommandRunner } from './runner.js';

// 中枢の Tailscale から見た、接続元のピアへの経路（domain の TailscalePeerPath と同じ形）。
export type TailscalePeerPath =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'peer_not_found' }
  | {
      readonly kind: 'peer';
      readonly cur_addr: string;
      readonly relay: string;
      readonly peer_relay: string;
    };

export interface TailscalePeer {
  readonly tailscale_ips: readonly string[];
  readonly cur_addr: string;
  readonly relay: string;
  readonly peer_relay: string;
}

export type TailscaleStatus =
  | { readonly ok: true; readonly peers: readonly TailscalePeer[] }
  | { readonly ok: false; readonly reason: string };

export interface TailscaleStatusSource {
  // 接続元のアドレス（TLS の接続の相手）に合うピアへの経路。
  peerPath(remoteAddress: string): Promise<TailscalePeerPath>;
}

// tailscale の実行ファイルの候補（macOS）。先に見つかったものを使う。
// 1. Mac App Store 版・スタンドアロン版のアプリに同梱の CLI
// 2. Homebrew（Apple シリコン・Intel）や手動で入れた CLI
// launchd から起動すると PATH が短いので、名前だけの指定は最後にする。
export const TAILSCALE_COMMANDS: readonly string[] = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  'tailscale',
];

export const TAILSCALE_STATUS_ARGS: readonly string[] = ['status', '--json'];
export const DEFAULT_TAILSCALE_TTL_MS = 5_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const stringOr = (value: unknown, fallback: string): string | null =>
  value === undefined || value === null
    ? fallback
    : typeof value === 'string'
      ? value
      : null;

// `tailscale status --json` の出力を読む。形が合わない・Running でないときは理由を返す。
export function parseTailscaleStatus(output: string): TailscaleStatus {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return { ok: false, reason: 'tailscale_output_invalid' };
  }
  if (!isRecord(value))
    return { ok: false, reason: 'tailscale_output_invalid' };
  if (value['BackendState'] !== 'Running')
    return { ok: false, reason: 'tailscale_not_running' };
  const rawPeers = value['Peer'];
  // ピアが一つもないときは Peer が null・省略になる。
  if (rawPeers !== undefined && rawPeers !== null && !isRecord(rawPeers))
    return { ok: false, reason: 'tailscale_output_invalid' };
  const peers: TailscalePeer[] = [];
  for (const raw of Object.values(rawPeers ?? {})) {
    if (!isRecord(raw))
      return { ok: false, reason: 'tailscale_output_invalid' };
    const ips = raw['TailscaleIPs'];
    const curAddr = stringOr(raw['CurAddr'], '');
    const relay = stringOr(raw['Relay'], '');
    const peerRelay = stringOr(raw['PeerRelay'], '');
    if (
      (ips !== undefined &&
        ips !== null &&
        (!Array.isArray(ips) || !ips.every((ip) => typeof ip === 'string'))) ||
      curAddr === null ||
      relay === null ||
      peerRelay === null
    )
      return { ok: false, reason: 'tailscale_output_invalid' };
    peers.push({
      tailscale_ips: (ips ?? []) as string[],
      cur_addr: curAddr,
      relay,
      peer_relay: peerRelay,
    });
  }
  return { ok: true, peers };
}

// 接続元のアドレスを比べられる形にする（IPv4 射影の IPv6・大文字・ゾーンを除く）。
export function normalizeRemoteAddress(address: string): string {
  let text = address.trim().toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (text.startsWith('::ffff:') && text.slice(7).includes('.'))
    text = text.slice(7);
  return text;
}

// 接続元のアドレスに合うピアを探す。複数のピアが同じアドレスを持つ（読み違い）ときは見つからない扱い。
export function findPeerPath(
  status: TailscaleStatus,
  remoteAddress: string,
): TailscalePeerPath {
  if (!status.ok) return { kind: 'unavailable' };
  const remote = normalizeRemoteAddress(remoteAddress);
  if (remote === '') return { kind: 'peer_not_found' };
  const matches = status.peers.filter((peer) =>
    peer.tailscale_ips.some((ip) => normalizeRemoteAddress(ip) === remote),
  );
  if (matches.length !== 1) return { kind: 'peer_not_found' };
  const peer = matches[0] as TailscalePeer;
  return {
    kind: 'peer',
    cur_addr: peer.cur_addr,
    relay: peer.relay,
    peer_relay: peer.peer_relay,
  };
}

// tailscale を一度実行して状態を読む。候補を順に試し、起動できなかったもの（exitCode null）は次へ進む。
export async function fetchTailscaleStatus(
  runner: CommandRunner,
  commands: readonly string[] = TAILSCALE_COMMANDS,
): Promise<TailscaleStatus> {
  let reason = 'tailscale_command_unavailable';
  for (const command of commands) {
    let result;
    try {
      result = await runner.run(command, TAILSCALE_STATUS_ARGS);
    } catch {
      reason = 'tailscale_command_failed';
      continue;
    }
    if (result.exitCode === null) continue;
    if (result.exitCode !== 0)
      return { ok: false, reason: 'tailscale_status_failed' };
    return parseTailscaleStatus(result.stdout);
  }
  return { ok: false, reason };
}

export interface TailscaleStatusSourceOptions {
  readonly runner: CommandRunner;
  readonly commands?: readonly string[];
  // 状態を保持する時間（ミリ秒）。0 なら毎回取り直す。
  readonly ttlMs?: number;
  readonly monotonicNow?: () => number;
}

export interface CachedTailscaleStatusSource extends TailscaleStatusSource {
  // 保持している状態を捨てる（次の peerPath で取り直す）。
  invalidate(): void;
  // 最後に取得した状態の理由（診断用。成功なら null）。
  readonly lastFailure: string | null;
}

export function createTailscaleStatusSource(
  options: TailscaleStatusSourceOptions,
): CachedTailscaleStatusSource {
  const ttl = options.ttlMs ?? DEFAULT_TAILSCALE_TTL_MS;
  const now = options.monotonicNow ?? (() => performance.now());
  let cached: { readonly at: number; readonly status: TailscaleStatus } | null =
    null;
  let inflight: Promise<TailscaleStatus> | null = null;
  let lastFailure: string | null = null;
  const current = async (): Promise<TailscaleStatus> => {
    const at = now();
    if (cached !== null && at >= cached.at && at - cached.at < ttl)
      return cached.status;
    // 同時の要求は一度の実行にまとめる。
    inflight ??= fetchTailscaleStatus(options.runner, options.commands)
      .catch((): TailscaleStatus => ({
        ok: false,
        reason: 'tailscale_command_failed',
      }))
      .then((status) => {
        cached = { at, status };
        lastFailure = status.ok ? null : status.reason;
        inflight = null;
        return status;
      });
    return inflight;
  };
  return {
    async peerPath(remoteAddress) {
      return findPeerPath(await current(), remoteAddress);
    },
    invalidate() {
      cached = null;
    },
    get lastFailure() {
      return lastFailure;
    },
  };
}

// 試験用の模擬。渡した関数の結果をそのまま返す（実機の tailscale を呼ばない）。
export function createMockTailscaleStatusSource(
  respond: (remoteAddress: string) => TailscalePeerPath,
): TailscaleStatusSource & { readonly kind: 'mock'; readonly calls: string[] } {
  const calls: string[] = [];
  return {
    kind: 'mock',
    calls,
    peerPath(remoteAddress) {
      calls.push(remoteAddress);
      return Promise.resolve(respond(remoteAddress));
    },
  };
}

// 取得の手段がないとき（設定なし）の既定。常に unavailable（安全側、自宅判定は不成立）。
export const UNAVAILABLE_TAILSCALE_STATUS: TailscaleStatusSource = {
  peerPath: () => Promise.resolve({ kind: 'unavailable' }),
};
