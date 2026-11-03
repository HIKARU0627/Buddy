// 注入した HTTP と provider の codec を使う LLM アダプター（B10-02、ADR 0080）。
// - 1 回の complete() で送るのは 1 回だけ。timeout・unavailable・不正な応答の後に自動で送り直さない
//   （ADR 0070 / 設計修正案 v1.2 P01・P02）。
// - 送信の前後に中断を確かめる。送った後に中断された場合も、届いた usage は捨てずに返す（費用を記録できるように）。
// - 出力の schema・上限・空・途中の JSON の区別は P3 の検証層が行う。ここでは provider の生の結果だけを返す。
import type { HttpTransport } from './http.js';
import type { ProviderCodec } from './provider.js';
import type { AdapterResult, Cancellation, ModelCommand } from './types.js';

export interface LlmAdapter {
  complete(
    command: ModelCommand,
    cancellation?: Cancellation,
  ): Promise<AdapterResult>;
}

// 中断は送信の前後で別々に読む（同じ値でも、送信の間に変わる）。関数に包んで型の絞り込みを避ける。
const isCancelled = (cancellation?: Cancellation): boolean =>
  cancellation?.aborted === true;

export function createHttpAdapter(
  transport: HttpTransport,
  codec: ProviderCodec,
): LlmAdapter {
  return {
    async complete(command, cancellation) {
      if (isCancelled(cancellation)) return { kind: 'cancelled', usage: null };
      const encoded = codec.encode(command);
      const result = await transport.send({
        method: 'POST',
        url: command.profile.endpoint,
        headers: encoded.headers,
        body: encoded.body,
        timeout_ms: command.profile.timeout_ms,
      });
      if (result.kind === 'timeout') return { kind: 'timeout', usage: null };
      if (result.kind === 'unavailable')
        return { kind: 'unavailable', usage: null };
      let decoded: AdapterResult;
      try {
        decoded = codec.decode(result.response);
      } catch {
        // 応答の封筒が読めない。送った可能性があるので、ここでは usage 不明として呼び出し側へ返す。
        return { kind: 'unavailable', usage: null };
      }
      // 応答が届いた後に中断された場合も、観測した usage は捨てない（費用を記録できるように）。
      if (isCancelled(cancellation))
        return { kind: 'cancelled', usage: decoded.usage };
      return decoded;
    },
  };
}
