// 試験装置だけの出口（B10-02、ADR 0080）。偽のアダプターと偽の HTTP。製品のコードからは読み込まない。
// 実 API・API キー・実請求は使わない。期待値は試験側に手で書き、偽の実装から作らない。
import type { ModelProfile } from '@buddy/contracts';
import type { LlmAdapter } from './adapter.js';
import type { HttpRequest, HttpResult, HttpTransport } from './http.js';
import type { AdapterResult, ModelCommand } from './types.js';

export type FakeAdapterStep =
  AdapterResult | ((command: ModelCommand) => AdapterResult);

export interface FakeAdapter extends LlmAdapter {
  // 送られた命令の記録（送信回数・profile・timeout の確認に使う）。
  readonly commands: readonly ModelCommand[];
}

export function createFakeAdapter(
  script: FakeAdapterStep | readonly FakeAdapterStep[],
): FakeAdapter {
  const steps = Array.isArray(script) ? [...script] : [script];
  const commands: ModelCommand[] = [];
  let index = 0;
  return {
    commands,
    async complete(command) {
      commands.push(command);
      const step = steps[index];
      index += 1;
      if (step === undefined) throw new Error('fake_adapter_exhausted');
      return typeof step === 'function' ? step(command) : step;
    },
  };
}

export type FakeTransportStep =
  HttpResult | ((request: HttpRequest) => HttpResult | Promise<HttpResult>);

export interface FakeTransport extends HttpTransport {
  readonly requests: readonly HttpRequest[];
}

export function createFakeTransport(
  script: FakeTransportStep | readonly FakeTransportStep[],
): FakeTransport {
  const steps = Array.isArray(script) ? [...script] : [script];
  const requests: HttpRequest[] = [];
  let index = 0;
  return {
    requests,
    async send(request) {
      requests.push(request);
      const step = steps[index];
      index += 1;
      if (step === undefined) throw new Error('fake_transport_exhausted');
      return typeof step === 'function' ? step(request) : step;
    },
  };
}

// 合成の profile（試験専用）。endpoint は予約済みの .invalid ドメインで、実 API・個人の設定を持たない。
// 既定値は意図判定の暫定（D1）に合わせるが、これは模擬の設定で、実 endpoint の能力を確かめた記録ではない。
export type SyntheticProfileInput = Partial<ModelProfile> &
  Pick<ModelProfile, 'profile_id' | 'role'>;

export function syntheticProfile(
  overrides: SyntheticProfileInput,
): ModelProfile {
  return {
    provider: 'synthetic',
    endpoint: 'https://llm.invalid/v1/complete',
    api_version: null,
    sdk_version: null,
    model_request_id: 'synthetic-model-1',
    reasoning: 'low',
    structured_output: 'json_schema_strict',
    output_limit_tokens: 500,
    timeout_ms: 8000,
    max_concurrency: 2,
    price_version: 'price-2026-01',
    reservation_method: 'max_liability',
    verified_capabilities: ['json_schema_strict', 'reasoning:low'],
    ...overrides,
  };
}
