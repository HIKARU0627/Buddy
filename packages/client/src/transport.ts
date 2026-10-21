// 端末側の接続の状態機械が使う通信・時計・形式検査の境界（ADR 0025）。
// 実装はデスクトップの main（TLS のピン留め・ws）が持ち、この包みは Node・DOM・Electron の API を使わない。
// 試験では模擬の実装を渡す。

// 要求に付けるロック状態。unknown のときは申告しない（中枢は解除済みと扱わない。07 §2）。
export type ClientLockState = 'unlocked' | 'locked' | 'unknown';

export interface ClientApiRequest {
  // PUT は置き換える要求（自宅の登録。B03-08）。
  readonly method: 'GET' | 'POST' | 'PUT';
  // /v1/... のパス（クエリーを含む）。
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
  // 本人の画面操作として送る（Buddy-Input-Origin: screen）。
  readonly screenOperation?: boolean;
  readonly lockState: ClientLockState;
}

export type ClientApiOutcome =
  // 中枢が応答した（2xx 以外も含む）。本文は JSON として読めなければ null。
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly body: unknown;
    }
  // 接続できない・時間切れ・応答の前に切れた。命令なら成否不明（自動で再送しない）。
  | { readonly kind: 'unreachable'; readonly reason: string }
  // 中枢の証明書がピン留めした指紋と違う。要求は 1 バイトも送っていない。
  | { readonly kind: 'certificate_mismatch' };

export type ClientStreamEvent =
  | { readonly type: 'message'; readonly data: unknown }
  // 中枢からの ping など、接続が生きている印。
  | { readonly type: 'alive' }
  | { readonly type: 'closed'; readonly code: number; readonly reason: string };

export interface ClientStreamHandle {
  close(): void;
}

export type ClientStreamOpen =
  | { readonly kind: 'open'; readonly stream: ClientStreamHandle }
  // 切り替えの前に HTTP で拒否された。
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly body: unknown;
    }
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'certificate_mismatch' };

export interface ClientTransport {
  request(request: ClientApiRequest): Promise<ClientApiOutcome>;
  // WSS /v1/events/stream?cursor=...。listener は open の後のメッセージ・印・切断を受け取る。
  openStream(
    cursor: string,
    lockState: ClientLockState,
    listener: (event: ClientStreamEvent) => void,
  ): Promise<ClientStreamOpen>;
}

export type CancelTimer = () => void;

export interface ClientClock {
  // UTC のミリ秒。
  now(): number;
  setTimer(ms: number, run: () => void): CancelTimer;
  // [0, 1) の値（再接続の間隔の揺らぎ）。
  random(): number;
  // 要求の request_id（UUID v4）。
  newRequestId(): string;
}

// 契約（JSON Schema）の形式の検査。デスクトップは Ajv で契約の schema を検査する実装を渡す。
export type ClientContractName =
  | 'Bootstrap'
  | 'Snapshot'
  | 'EventStreamMessage'
  | 'OperationSnapshot'
  | 'CommandReceipt'
  | 'ApiError';

export interface ClientContract {
  valid(name: ClientContractName, value: unknown): boolean;
}
