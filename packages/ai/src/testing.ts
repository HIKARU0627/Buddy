// 試験装置だけの出口（B10-02、ADR 0080）。偽のアダプターと偽の HTTP。製品のコードからは読み込まない。
// 実 API・API キー・実請求は使わない。期待値は試験側に手で書き、偽の実装から作らない。
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
