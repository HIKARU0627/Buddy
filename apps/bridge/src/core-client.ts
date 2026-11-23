// 中枢への要求の組み立て（bootstrap・接続範囲・request_id・再送の規則。ADR 0143）。
//
// - bootstrap で接続範囲（command_scope_id）を受け取り、命令の本文へ差し込む。再接続・期限切れでは取り直す（07 §3）。
// - 接続範囲が古い（410 expired_scope）ときだけ、bootstrap を取り直して 1 回だけ送り直す。そのとき request_id は
//   新しくする（受付の記録は接続範囲と request_id の組で引くので、古い範囲の受付と混ざらない）。
// - 接続できない（成否不明）の命令は自動で再送しない（AGENTS.md の規則）。読み取りは呼び出し側の判断でよいが、
//   ここでは一律に再送しない。
// - ロック状態は unlocked を申告する。ブリッジは画面を持たない常駐の端末で、画面のロックという概念が無い
//   （申告しないと unknown として全ての読み取りが device_locked になる）。代替の門はブリッジの認証トークンと
//   端末の失効で、根拠と残るリスクは ADR 0143 に書く。

import { randomUUID } from 'node:crypto';
import type { CoreTransport, CoreTransportOutcome } from './core-transport.js';

export type CoreClientOutcome = CoreTransportOutcome;

export interface CoreClient {
  // 読み取り（接続範囲を求めない経路。getBootstrap 自身も含む）。
  read(path: string): Promise<CoreClientOutcome>;
  // 命令（本文へ request_id と command_scope_id を差し込む）。inputOrigin は付ける経路だけに渡す。
  command(
    method: 'POST' | 'PUT',
    path: string,
    body: Readonly<Record<string, unknown>>,
    options?: { readonly inputOrigin?: 'chat' },
  ): Promise<CoreClientOutcome>;
  // 認証前の要求（ペアリングの申請・受取り）。トークンも接続範囲も付けない。
  preAuth(
    method: 'POST',
    path: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<CoreClientOutcome>;
}

export interface CoreClientOptions {
  readonly transport: CoreTransport;
  // 端末トークン（ペアリング前は null。その場合 command/read は unauthenticated 相当の失敗を返す）。
  readonly deviceToken: string | null;
  readonly newRequestId?: () => string;
  readonly now?: () => number;
}

interface ScopeState {
  readonly scopeId: string;
  // 期限（UTC ミリ秒）。過ぎたら使う前に取り直す。
  readonly expiresAtMs: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function createCoreClient(options: CoreClientOptions): CoreClient {
  const newRequestId = options.newRequestId ?? randomUUID;
  const now = options.now ?? Date.now;
  let scope: ScopeState | null = null;
  let bootstrapping: Promise<boolean> | null = null;

  const bootstrap = async (): Promise<boolean> => {
    if (options.deviceToken === null) return false;
    const outcome = await options.transport.request({
      method: 'GET',
      path: '/v1/bootstrap',
      deviceToken: options.deviceToken,
      lockState: 'unlocked',
    });
    if (outcome.kind !== 'response' || outcome.status !== 200) return false;
    if (!isRecord(outcome.body)) return false;
    const scopeId = outcome.body['command_scope_id'];
    const expiresAt = outcome.body['command_scope_expires_at'];
    if (typeof scopeId !== 'string' || typeof expiresAt !== 'string')
      return false;
    const expiresAtMs = Date.parse(expiresAt);
    if (Number.isNaN(expiresAtMs)) return false;
    scope = { scopeId, expiresAtMs };
    return true;
  };

  // 接続範囲を用意する。同時の要求では bootstrap を 1 回にまとめる。
  const ensureScope = async (): Promise<ScopeState | null> => {
    if (scope !== null && now() < scope.expiresAtMs) return scope;
    if (bootstrapping === null) {
      bootstrapping = bootstrap().finally(() => {
        bootstrapping = null;
      });
    }
    const ok = await bootstrapping;
    return ok ? scope : null;
  };

  const read = async (path: string): Promise<CoreClientOutcome> => {
    if (options.deviceToken === null)
      return { kind: 'unreachable', reason: 'device_not_paired' };
    return options.transport.request({
      method: 'GET',
      path,
      deviceToken: options.deviceToken,
      lockState: 'unlocked',
    });
  };

  const preAuth: CoreClient['preAuth'] = async (method, path, body) =>
    options.transport.request({ method, path, body, deviceToken: null });

  const command: CoreClient['command'] = async (
    method,
    path,
    body,
    commandOptions = {},
  ) => {
    if (options.deviceToken === null)
      return { kind: 'unreachable', reason: 'device_not_paired' };
    const send = async (current: ScopeState): Promise<CoreClientOutcome> =>
      options.transport.request({
        method,
        path,
        body: {
          ...body,
          request_id: newRequestId(),
          command_scope_id: current.scopeId,
        },
        deviceToken: options.deviceToken as string,
        lockState: 'unlocked',
        ...(commandOptions.inputOrigin === undefined
          ? {}
          : { inputOrigin: commandOptions.inputOrigin }),
      });
    const current = await ensureScope();
    if (current === null)
      return { kind: 'unreachable', reason: 'bootstrap_failed' };
    const first = await send(current);
    // 接続範囲が古いときだけ取り直して 1 回だけ送り直す（受付はされていないので二重にならない）。
    if (
      first.kind === 'response' &&
      first.status === 410 &&
      isRecord(first.body) &&
      first.body['code'] === 'expired_scope'
    ) {
      scope = null;
      const refreshed = await ensureScope();
      if (refreshed === null) return first;
      return send(refreshed);
    }
    return first;
  };

  return { read, command, preAuth };
}
