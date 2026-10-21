// 経路の検査に渡す文脈のうち、B03-01 では判定の元がまだないもの（ADR 0020）。
// 後の Issue（自宅判定 B03-03、ロック状態・音声所有権・版の照合 B03-04 以降、申請用の秘密 B03-02）が
// 差し替えられるように注入できる形にし、既定は安全側（検査を満たさない）にする。
// 既定のまま製品で使うと、自宅判定は中枢と同じマシンの端末（hub_local）だけが通り、ロック解除・
// 音声所有権・版の照合・申請用の秘密を求める経路は拒否される。

import type { DeviceRecord } from '@buddy/storage';
import type { JsonObject } from './strict-json.js';

export interface EnvironmentInput {
  readonly operationId: string;
  // 端末トークンで認証した端末。認証前の経路・認証に失敗した要求では null。
  readonly device: DeviceRecord | null;
  // 接続元の IP アドレス（TLS の接続の相手）。
  readonly remoteAddress: string;
  readonly params: Readonly<Record<string, string>>;
  // 形式の検査に通った本文。本文のない経路では null。
  readonly body: JsonObject | null;
  // 要求ヘッダー Buddy-Lock-State で端末の main が申告したロック状態（B03-05、ADR 0025）。
  // ヘッダーがなければ null。値の検査は形式の検査で済ませている。
  readonly declaredLockState: DeclaredLockState | null;
}

// Buddy-Lock-State の値（OpenAPI の components.parameters.LockState）。
export type DeclaredLockState = 'unlocked' | 'locked';
export const DECLARED_LOCK_STATES: readonly DeclaredLockState[] = [
  'unlocked',
  'locked',
];

// 端末の申告したロック状態を使う判定（B03-05、ADR 0025）。端末トークンで認証した端末の申告だけを使い、
// 認証前の要求・申告のない要求は unknown（解除済みと扱わない。07 §2）。
export function declaredLockState(
  input: EnvironmentInput,
): 'unlocked' | 'locked' | 'unknown' {
  if (input.device === null) return 'unknown';
  return input.declaredLockState ?? 'unknown';
}

type Provided<T> = T | Promise<T>;

export interface RequestEnvironment {
  // 自宅判定（11 §10）。中枢と同じマシンのクライアントは免除する（RequestContext の注記）。
  homeNetwork(input: EnvironmentInput): Provided<boolean>;
  // 端末のロック状態（07 §2）。取得できなければ unknown（解除済みと扱わない）。
  lockState(
    input: EnvironmentInput,
  ): Provided<'unlocked' | 'locked' | 'unknown'>;
  // 中枢の画面（hub_screen）か。
  hubLocal(input: EnvironmentInput): Provided<boolean>;
  audioOwner(input: EnvironmentInput): Provided<'self' | 'other' | 'none'>;
  // expected_revision の照合（対象ごとの版）。
  revisionMatches(input: EnvironmentInput): Provided<boolean>;
  // 申請用の秘密（U15、B03-02）。
  claimSecretMatches(input: EnvironmentInput): Provided<boolean>;
}

// B03-01 の既定。判定の元がないものは満たさない側に倒す。
export const SAFE_REQUEST_ENVIRONMENT: RequestEnvironment = {
  // 自宅判定は B03-03。それまでは中枢と同じマシンの端末だけを免除で通し、他は 403 outside_home_network。
  homeNetwork: ({ device }) => device?.hub_local === true,
  lockState: () => 'unknown',
  hubLocal: ({ device }) => device?.hub_local === true,
  audioOwner: () => 'none',
  revisionMatches: () => false,
  claimSecretMatches: () => false,
};
