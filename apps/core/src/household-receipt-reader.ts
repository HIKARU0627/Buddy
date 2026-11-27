// レシートの写真の読み取りの口の Gemini の実装と profile（家計簿 段階 3 の一部、ADR 0177・0178、U368）。
//
// - 送るのは、固定の指示文（HOUSEHOLD_RECEIPT_INSTRUCTIONS）と、中枢で確かめ済みの JPEG 1 枚だけ（generateContent の
//   systemInstruction と inlineData）。要求の ID・本人の名前・端末の情報・ほかの家計の記録は送らない。
// - API キーは起動の環境変数（BUDDY_GEMINI_API_KEY）から CLI が渡し、x-goog-api-key のヘッダーにだけ入れる。URL・
//   profile・ログ・例外には入れない。鍵がなければ読み取りの設定を作らない（unavailable のまま）。
// - 1 回の read で送るのは 1 回だけで、自動で送り直さない。中断されたら HTTPS の要求を切ってすぐ返す（ADR 0177 の追補 2）。
// - 応答の封筒は packages/ai の Gemini の codec で読み、本文の検査は呼び出し側（household-receipt.ts の厳格な JSON と
//   domain の readHouseholdReceiptReply）が行う。ここでは本文を読まない。
// - 記録は理由の名前だけ（HTTP の状態の番号・時間切れなど）。画像・応答の中身・API キーは出さない。
// - モデル・単価の系列・期限・出力の上限は暫定（ADR 0178、U371〜U375）。実 API では確かめていない。
import { Buffer } from 'node:buffer';
import type { ModelProfile } from '@buddy/contracts';
import {
  GEMINI_PROVIDER,
  createGeminiCodec,
  encodeGeminiImageRequest,
  modelProfileErrors,
} from '@buddy/ai';
import type { AdapterResult, HttpRequest, HttpResult } from '@buddy/ai';
import { RECEIPT_REPLY_ITEMS_MAX } from '@buddy/domain';
import type { PriceCategory } from '@buddy/domain';
import type {
  ReceiptImageReader,
  ReceiptReadingSetup,
} from './household-receipt.js';

// 鍵を受け取る環境変数（ADR 0144 の OAuth のクライアントシークレットと同じく、起動の環境からだけ受け取る）。
export const RECEIPT_API_KEY_ENV = 'BUDDY_GEMINI_API_KEY';

// 暫定のモデル（意図の判定・抽出の暫定 D1 と同じ Gemini 3.8 Flash。U371）。
export const HOUSEHOLD_RECEIPT_MODEL = 'gemini-3.8-flash';
// generateContent の endpoint（公開の API の URL。鍵は含めない。U372）。
export const HOUSEHOLD_RECEIPT_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${HOUSEHOLD_RECEIPT_MODEL}:generateContent`;
export const HOUSEHOLD_RECEIPT_PROFILE_ID = 'household-receipt.gemini';
// profile の設定の版（モデル・思考・出力の上限・期限・指示文・応答の形を変えたら上げる）。
export const HOUSEHOLD_RECEIPT_PROFILE_REVISION = '1';
// 単価の系列（budget-runtime.json の PriceVersion.price_key）。単価の値は本人が設定に書き、リポジトリに置かない（U373）。
export const HOUSEHOLD_RECEIPT_PRICE_KEY = 'gemini.gemini-3.8-flash';
// 読み取りの期限（RECEIPT_READ_TIMEOUT_MAX_MS の 60 秒以内。U374）。
export const HOUSEHOLD_RECEIPT_TIMEOUT_MS = 45_000;
// 出力（思考を含む）の上限。品目 100 件の JSON と思考に足りる見込みの暫定の値（U374）。
export const HOUSEHOLD_RECEIPT_OUTPUT_LIMIT_TOKENS = 4096;
// 指示文と画像 1 枚の入力の上限（予約の最大負担の入力の量）。画像の token の数え方を実 API で確かめていないので、大きめの
// 暫定の値（U374）。
export const HOUSEHOLD_RECEIPT_MAX_INPUT_TOKENS = 8192;

const nullable = (type: string) => ({
  anyOf: [{ type }, { type: 'null' }],
});

// 構造化出力の形（domain の readHouseholdReceiptReply が確かめる形と同じキー）。provider の構造化出力は手助けで、検査の
// 正本は domain の検査（応答はこの形に合っていても信用しない）。
export const HOUSEHOLD_RECEIPT_REPLY_SCHEMA = {
  type: 'object',
  properties: {
    readable: { type: 'boolean' },
    receipt_count: { type: 'integer', minimum: 0 },
    currency: nullable('string'),
    total: nullable('integer'),
    date: nullable('string'),
    time: nullable('string'),
    merchant: nullable('string'),
    payment: nullable('string'),
    items: {
      type: 'array',
      maxItems: RECEIPT_REPLY_ITEMS_MAX,
      items: {
        type: 'object',
        properties: {
          name: nullable('string'),
          amount: { type: 'integer' },
        },
        required: ['name', 'amount'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'readable',
    'receipt_count',
    'currency',
    'total',
    'date',
    'time',
    'merchant',
    'payment',
    'items',
  ],
  additionalProperties: false,
} as const;

// レシートの読み取りの profile。price_version は起動の時点で予算の設定から見積もれた版（記録用。受付では予算の門が受付の
// 時刻で版を選び直す）。verified_capabilities は docs/b10/model-routing.md の表と同じく模擬の設定の値で、実 endpoint で
// 確かめた記録ではない（U372）。
export function householdReceiptProfile(input: {
  readonly price_version: string;
  // 試験だけ: endpoint を差し替える（.invalid の名前・模擬の HTTPS サーバー）。
  readonly endpoint?: string;
}): ModelProfile {
  return {
    profile_id: HOUSEHOLD_RECEIPT_PROFILE_ID,
    role: 'background_text',
    provider: GEMINI_PROVIDER,
    endpoint: input.endpoint ?? HOUSEHOLD_RECEIPT_ENDPOINT,
    api_version: 'v1beta',
    sdk_version: null,
    model_request_id: HOUSEHOLD_RECEIPT_MODEL,
    reasoning: 'low',
    structured_output: 'json_schema_strict',
    output_limit_tokens: HOUSEHOLD_RECEIPT_OUTPUT_LIMIT_TOKENS,
    timeout_ms: HOUSEHOLD_RECEIPT_TIMEOUT_MS,
    max_concurrency: 2,
    price_version: input.price_version,
    reservation_method: 'max_liability',
    verified_capabilities: ['json_schema_strict', 'reasoning:low'],
  };
}

// HTTPS の送信の口（model-https.ts の createModelHttpsTransport。試験は模擬に差し替える）。中断されたら接続を切ってすぐ
// 返すこと。
export interface ReceiptHttpTransport {
  send(request: HttpRequest, signal: AbortSignal): Promise<HttpResult>;
}

export interface GeminiReceiptReaderOptions {
  readonly apiKey: string;
  readonly transport: ReceiptHttpTransport;
  // 中身を出さない記録（理由の名前だけ）。
  readonly log?: (message: string) => void;
}

// API キーとしてヘッダーに入れてよい文字（表示できる ASCII で、空白・改行を含まない）。
const API_KEY_FORMAT = /^[\x21-\x7e]{1,512}$/u;

export const receiptApiKeyUsable = (apiKey: string): boolean =>
  API_KEY_FORMAT.test(apiKey);

export function createGeminiReceiptReader(
  options: GeminiReceiptReaderOptions,
): ReceiptImageReader {
  const codec = createGeminiCodec();
  const transport = options.transport;
  const log = options.log ?? (() => undefined);
  // 鍵はこの関数の中にだけ置き、返す口のプロパティにしない。
  const apiKey = options.apiKey;
  const note = (reason: string) =>
    log(
      `家計簿のレシートの写真の読み取りで応答を得られませんでした（${reason}）。`,
    );
  return {
    async read(command, cancellation): Promise<AdapterResult> {
      if (cancellation.aborted) return { kind: 'cancelled', usage: null };
      if (command.profile.provider !== GEMINI_PROVIDER) {
        note('provider_mismatch');
        return { kind: 'unavailable', usage: null };
      }
      // 写しを作らずに base64 にする（バイト列は呼び出し側が終わった後に 0 で埋める。base64 の文字列は埋められない）。
      const view = command.image.bytes;
      const data = Buffer.from(
        view.buffer,
        view.byteOffset,
        view.byteLength,
      ).toString('base64');
      const encoded = encodeGeminiImageRequest({
        profile: command.profile,
        instructions: command.instructions,
        image: { media_type: command.image.media_type, data_base64: data },
        output_schema:
          command.profile.structured_output === 'none'
            ? null
            : HOUSEHOLD_RECEIPT_REPLY_SCHEMA,
      });
      let result: HttpResult;
      try {
        result = await transport.send(
          {
            method: 'POST',
            url: command.profile.endpoint,
            headers: { ...encoded.headers, 'x-goog-api-key': apiKey },
            body: encoded.body,
            timeout_ms: command.profile.timeout_ms,
          },
          cancellation,
        );
      } catch {
        // 送った可能性がある。usage は分からない。
        if (cancellation.aborted) return { kind: 'cancelled', usage: null };
        note('transport_failed');
        return { kind: 'unavailable', usage: null };
      }
      if (cancellation.aborted && result.kind !== 'response')
        return { kind: 'cancelled', usage: null };
      if (result.kind === 'timeout') {
        note('timeout');
        return { kind: 'timeout', usage: null };
      }
      if (result.kind === 'unavailable') {
        note('unavailable');
        return { kind: 'unavailable', usage: null };
      }
      const status = result.response.status;
      if (status !== 200)
        note(
          Number.isSafeInteger(status) && status >= 100 && status <= 599
            ? `http_status_${status}`
            : 'http_status_invalid',
        );
      let decoded: AdapterResult;
      try {
        decoded = codec.decode(result.response);
      } catch {
        // 封筒が読めない（JSON でない・候補がない・終了の理由が分からない）。送った可能性があるので usage 不明。
        note('response_unreadable');
        decoded = { kind: 'unavailable', usage: null };
      }
      // 応答が届いた後に中断された場合も、観測した usage は捨てない（費用を精算できるように）。
      if (cancellation.aborted)
        return { kind: 'cancelled', usage: decoded.usage };
      return decoded;
    },
  };
}

// 起動の環境変数から鍵を値のまま読む。未設定・空は null（鍵がない。記録しない既定の状態）。形の違う値（末尾の空白・
// \r など）はここでは落とさず、householdReceiptSetup が receipt_api_key_invalid として記録して使えなくする（「鍵が
// ない」と「形が違う」を分ける。値は記録に出さない）。
export function receiptApiKeyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const value = env[RECEIPT_API_KEY_ENV];
  return value === undefined || value === '' ? null : value;
}

// 鍵を送ってよい宛先のホスト。製品の起動では、ここ以外へは設定の段階で送らない（U372）。
export const HOUSEHOLD_RECEIPT_ENDPOINT_HOST =
  'generativelanguage.googleapis.com';

// 製品の宛先として許せる URL か。https で、ホストが固定で、ポート指定・ユーザー情報がないもの。
export function receiptEndpointAllowed(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === HOUSEHOLD_RECEIPT_ENDPOINT_HOST &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  );
}

export interface HouseholdReceiptProviderOptions {
  // API キー。null・空なら読み取りを使わない（unavailable）。
  readonly apiKey: string | null;
  readonly transport: ReceiptHttpTransport;
  // 予算の設定で、今の時刻にこの単価の系列を見積もれるときの版（BudgetGate.priceVersionFor）。
  readonly priceVersionFor: (request: {
    readonly price_key: string;
    readonly quantities: Readonly<Partial<Record<PriceCategory, string>>>;
    readonly timeout_ms: number;
  }) => string | null;
  // 試験だけ: endpoint の差し替え。製品の起動の検査（ホストの固定）は中枢の起動の設定（core.ts）にある。
  readonly endpoint?: string;
  readonly log?: (message: string) => void;
}

// 中枢の起動の設定（ReceiptReadingSetup）を作る。鍵がない・形が違う・予算の設定に確認済みの単価の版がない・profile の
// 検査に通らないときは null（読み取りは unavailable のまま）。
export function householdReceiptSetup(
  options: HouseholdReceiptProviderOptions,
): ReceiptReadingSetup | null {
  const log = options.log ?? (() => undefined);
  if (options.apiKey === null || options.apiKey === '') return null;
  if (!receiptApiKeyUsable(options.apiKey)) {
    log(
      '家計簿のレシートの写真の読み取りを使えなくしました（receipt_api_key_invalid）。',
    );
    return null;
  }
  const priceVersion = options.priceVersionFor({
    price_key: HOUSEHOLD_RECEIPT_PRICE_KEY,
    quantities: {
      input_tokens: String(HOUSEHOLD_RECEIPT_MAX_INPUT_TOKENS),
      output_tokens: String(HOUSEHOLD_RECEIPT_OUTPUT_LIMIT_TOKENS),
    },
    timeout_ms: HOUSEHOLD_RECEIPT_TIMEOUT_MS,
  });
  if (priceVersion === null) {
    log(
      '家計簿のレシートの写真の読み取りを使えなくしました（receipt_price_version_unavailable）。',
    );
    return null;
  }
  const profile = householdReceiptProfile({
    price_version: priceVersion,
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
  });
  if (modelProfileErrors(profile).length > 0) {
    log(
      '家計簿のレシートの写真の読み取りを使えなくしました（receipt_profile_invalid）。',
    );
    return null;
  }
  return {
    reader: createGeminiReceiptReader({
      apiKey: options.apiKey,
      transport: options.transport,
      ...(options.log === undefined ? {} : { log: options.log }),
    }),
    profile,
    profile_revision: HOUSEHOLD_RECEIPT_PROFILE_REVISION,
    price_key: HOUSEHOLD_RECEIPT_PRICE_KEY,
    max_input_tokens: HOUSEHOLD_RECEIPT_MAX_INPUT_TOKENS,
  };
}
