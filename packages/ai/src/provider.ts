// provider ごとの差（クラウド・ローカルの wire 形式・usage の読み方・終了理由）を吸収する codec（B10-02、ADR 0080）。
// 認証ヘッダーは transport の外（Core の設定）で足す。codec は API キーを持たない・ログに出さない。
import type { HttpResponse } from './http.js';
import type { AdapterResult, ModelCommand } from './types.js';

export interface EncodedRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ProviderCodec {
  // profile.provider と同じ値（例: 'gemini'・'local'）。
  readonly provider: string;
  encode(command: ModelCommand): EncodedRequest;
  // 応答の封筒を読む。壊れている・想定外の形なら例外を投げてよい（アダプターが unavailable にする）。
  decode(response: HttpResponse): AdapterResult;
}
