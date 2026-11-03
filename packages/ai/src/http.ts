// 差し替え可能な HTTP（B10-02、ADR 0080）。実 API のキー・実請求はこの層の外（B15 と本人の承認）に置く。
// アダプターは node:http・fetch を直接使わず、この口だけに依存する。試験は模擬の transport を注入する。

export interface HttpRequest {
  readonly method: 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  // profile の timeout_ms。期限を守るのは transport の責任で、超えたら timeout を返す。
  readonly timeout_ms: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type HttpResult =
  | { readonly kind: 'response'; readonly response: HttpResponse }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unavailable' };

export interface HttpTransport {
  send(request: HttpRequest): Promise<HttpResult>;
}
