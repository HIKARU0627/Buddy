// 外部のモデルへの HTTPS の送信（家計簿のレシートの写真の読み取り。ADR 0178）。
//
// packages/ai は node:* を読まない（ADR 0080）ので、HttpRequest を実際に送る口は Core に置く。形は packages/ai の
// HttpRequest・HttpResult のまま使う。
// - https: の URL だけに送る。それ以外は接続せずに unavailable。
// - 1 回の send で送るのは 1 回だけで、自動で送り直さない（ADR 0070・0080）。
// - 期限（request.timeout_ms）を過ぎたら接続を切って timeout。中断（signal）されたら接続を切ってすぐ unavailable を返す
//   （呼び出し側が中断として扱う。ADR 0177 の追補 2: 中断されたらすぐ返す）。
// - 応答の本文は maxResponseBytes まで読み、超えたら接続を切って unavailable。
// - 送った本文と受け取った断片の Buffer は、終えた後に 0 で埋める（画像の base64・応答の中身。文字列は埋められない）。
// - 要求・応答の中身・ヘッダー（API キーを含む）をログに出さない。ここでは何も記録しない。
import { request as httpsRequest } from 'node:https';
import type { Agent } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { HttpRequest, HttpResult } from '@buddy/ai';

// 応答の本文の上限（バイト）。レシートの読み取りの応答（JSON 1 つ）には十分な大きさ。
export const MODEL_RESPONSE_MAX_BYTES = 1024 * 1024;

export interface ModelHttpsTransport {
  send(request: HttpRequest, signal?: AbortSignal): Promise<HttpResult>;
}

export interface ModelHttpsOptions {
  // 試験だけ: 接続の設定（模擬の HTTPS サーバーの証明書を信頼する）。製品は省略し、Node の既定（信頼する CA と名前の
  // 検証）を使う。
  readonly agent?: Agent;
  readonly maxResponseBytes?: number;
}

const headerText = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value.join(', ') : (value ?? '');

export function createModelHttpsTransport(
  options: ModelHttpsOptions = {},
): ModelHttpsTransport {
  const maxBytes = options.maxResponseBytes ?? MODEL_RESPONSE_MAX_BYTES;
  return {
    send(request, signal) {
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return Promise.resolve({ kind: 'unavailable' });
      }
      if (url.protocol !== 'https:' || signal?.aborted === true)
        return Promise.resolve({ kind: 'unavailable' });
      const body = Buffer.from(request.body, 'utf8');
      let outgoing: ReturnType<typeof httpsRequest>;
      try {
        outgoing = httpsRequest(url, {
          method: request.method,
          headers: {
            ...request.headers,
            'content-length': String(body.length),
          },
          ...(options.agent === undefined ? {} : { agent: options.agent }),
        });
      } catch {
        // ヘッダーの値が不正など、接続を始める前に失敗した。
        body.fill(0);
        return Promise.resolve({ kind: 'unavailable' });
      }
      return new Promise<HttpResult>((resolve) => {
        const chunks: Buffer[] = [];
        let done = false;
        let timer: NodeJS.Timeout | null = null;
        const finish = (result: HttpResult) => {
          if (done) return;
          done = true;
          if (timer !== null) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          outgoing.destroy();
          body.fill(0);
          for (const chunk of chunks) chunk.fill(0);
          chunks.length = 0;
          resolve(result);
        };
        const onAbort = () => finish({ kind: 'unavailable' });
        outgoing.on('error', () => finish({ kind: 'unavailable' }));
        outgoing.on('response', (incoming: IncomingMessage) => {
          let received = 0;
          incoming.on('data', (chunk: Buffer) => {
            if (done) return;
            received += chunk.length;
            chunks.push(chunk);
            if (received > maxBytes) finish({ kind: 'unavailable' });
          });
          incoming.on('error', () => finish({ kind: 'unavailable' }));
          incoming.on('aborted', () => finish({ kind: 'unavailable' }));
          incoming.on('end', () => {
            if (done) return;
            const joined = Buffer.concat(chunks);
            const text = joined.toString('utf8');
            joined.fill(0);
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(incoming.headers))
              headers[name.toLowerCase()] = headerText(value);
            finish({
              kind: 'response',
              response: {
                status: incoming.statusCode ?? 0,
                headers,
                body: text,
              },
            });
          });
        });
        timer = setTimeout(
          () => finish({ kind: 'timeout' }),
          request.timeout_ms,
        );
        signal?.addEventListener('abort', onAbort, { once: true });
        outgoing.end(body);
      });
    },
  };
}
