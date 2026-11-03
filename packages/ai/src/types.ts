// LLM アダプターの共通の型（B10-02、ADR 0080）。
// クラウドとローカルの差は profile・provider の codec・注入した HTTP の内側に閉じ込め、
// 呼び出し側（Core・B10-03 以降）は ModelCommand と AdapterResult だけを扱う。
// 契約（WireResponse・ModelUsage・ModelOutcome）は packages/contracts を正本にし、ここで複製しない。
import type { ModelProfile, ModelUsage } from '@buddy/contracts';

export type ModelRole = ModelProfile['role'];

// profile の reasoning に書ける思考レベル（設計 05 モデルの振り分け）。
export type ReasoningLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

// provider に依存しない 1 回の呼び出し。output_schema はローカルの完全検証に使う JSON Schema で、
// provider へ送る形（pattern・format を落とした部分集合）は codec が作る。
export interface ModelCommand {
  readonly request_id: string;
  readonly role: ModelRole;
  readonly profile: ModelProfile;
  readonly messages: readonly ModelMessage[];
  readonly output_schema: unknown | null;
}

// 呼び出し側の中断。DOM の AbortSignal を持ち込まず、アダプターは送信の前後でだけ確かめる。
export interface Cancellation {
  readonly aborted: boolean;
}

// provider から受け取った生の応答（出力の検証より前）。refused・truncated は provider の終了理由で、
// 本文が空でも成功として扱わない。usage は観測できなければ null（推測で埋めない）。
export interface AdapterResponse {
  readonly kind: 'response';
  readonly text: string;
  readonly usage: ModelUsage | null;
  readonly provider_request_id: string | null;
  readonly refused: boolean;
  readonly truncated: boolean;
}

export type AdapterFailureKind = 'timeout' | 'unavailable' | 'cancelled';

// 送信そのものが成立しなかった結果。usage が分かる範囲だけを持つ（timeout の後に届いた usage を含む）。
export interface AdapterFailure {
  readonly kind: AdapterFailureKind;
  readonly usage: ModelUsage | null;
}

export type AdapterResult = AdapterResponse | AdapterFailure;
