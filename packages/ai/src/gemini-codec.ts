// Gemini（generateContent）の codec（B10-03 P2、ADR 0091）。設計 10 §6A「呼び出しは generateContent、thinkingLevel を
// 必ず指定、temperature は指定しない、出力は構造化出力（関数呼び出しは使わない）」。
// - **模擬の HTTP でだけ確かめた**。実 endpoint の wire 形式・usage の欄・終了理由・モデルの名前は未確認で、確認は B15 と本人の
//   承認まで行わない（実 API は未実施）。
// - API キー・認証ヘッダーは持たない（transport の外で足す。ADR 0080）。endpoint は profile の値をそのまま使う。
// - 送る schema は契約の JSON Schema から $ref を展開し、pattern・format などの注釈を落とした部分集合。ローカルの完全検証は
//   契約の schema で別に行う（形式の検査の正本は契約）。
import type { ModelUsage } from '@buddy/contracts';
import type { HttpResponse } from './http.js';
import type { EncodedRequest, ProviderCodec } from './provider.js';
import type { AdapterResponse, AdapterResult, ModelCommand } from './types.js';

export const GEMINI_PROVIDER = 'gemini';

// provider へ送らない注釈（形式の検査はローカルで契約の schema が行う）。
const DROPPED_KEYWORDS: ReadonlySet<string> = new Set([
  'pattern',
  'format',
  '$schema',
  '$id',
  '$defs',
  'description',
  'title',
  'uniqueItems',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// $ref（#/$defs/<名前>）を根の $defs から展開する。循環・未知の参照は例外（契約の schema にはない形）。
function wireSchema(
  node: unknown,
  root: Record<string, unknown>,
  seen: readonly string[],
): unknown {
  if (Array.isArray(node))
    return node.map((item) => wireSchema(item, root, seen));
  if (!isRecord(node)) return node;
  const ref = node['$ref'];
  if (typeof ref === 'string') {
    const match = /^#\/\$defs\/([A-Za-z0-9_]+)$/u.exec(ref);
    const defs = root['$defs'];
    const name = match?.[1];
    if (name === undefined || !isRecord(defs) || defs[name] === undefined)
      throw new Error('gemini_schema_ref_unknown');
    if (seen.includes(name)) throw new Error('gemini_schema_ref_cycle');
    return wireSchema(defs[name], root, [...seen, name]);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED_KEYWORDS.has(key)) continue;
    // properties の中の名前が注釈と同じ（例: title）でも落とさない。
    out[key] =
      key === 'properties' && isRecord(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, child]) => [
              name,
              wireSchema(child, root, seen),
            ]),
          )
        : wireSchema(value, root, seen);
  }
  return out;
}

export function geminiWireSchema(schema: unknown): unknown {
  if (!isRecord(schema)) throw new Error('gemini_schema_invalid');
  return wireSchema(schema, schema, []);
}

const REFUSAL_REASONS: ReadonlySet<string> = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
]);

const countOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

// usageMetadata から契約の ModelUsage を作る。必須の欄が読めなければ null（推測で埋めない）。
// 出力は思考を含む（契約の説明）: candidatesTokenCount + thoughtsTokenCount。cached は input の内数。
function usageOf(metadata: unknown): ModelUsage | null {
  if (!isRecord(metadata)) return null;
  const input = countOf(metadata['promptTokenCount']);
  const candidates = countOf(metadata['candidatesTokenCount']);
  if (input === null || candidates === null) return null;
  const thoughtsRaw = metadata['thoughtsTokenCount'];
  const thoughts = thoughtsRaw === undefined ? 0 : countOf(thoughtsRaw);
  const cachedRaw = metadata['cachedContentTokenCount'];
  const cached = cachedRaw === undefined ? 0 : countOf(cachedRaw);
  if (thoughts === null || cached === null || cached > input) return null;
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: candidates + thoughts,
    reasoning_tokens: thoughtsRaw === undefined ? null : thoughts,
    usage_complete: true,
  };
}

export function createGeminiCodec(): ProviderCodec {
  return {
    provider: GEMINI_PROVIDER,
    encode(command: ModelCommand): EncodedRequest {
      const system = command.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n');
      const generationConfig: Record<string, unknown> = {};
      if (command.output_schema !== null) {
        generationConfig['responseMimeType'] = 'application/json';
        generationConfig['responseJsonSchema'] = geminiWireSchema(
          command.output_schema,
        );
      }
      if (command.profile.output_limit_tokens !== null)
        generationConfig['maxOutputTokens'] =
          command.profile.output_limit_tokens;
      // 3.8 の既定は medium で思考は切れない。thinkingLevel を必ず指定し、temperature は指定しない。
      if (command.profile.reasoning !== null)
        generationConfig['thinkingConfig'] = {
          thinkingLevel: command.profile.reasoning,
        };
      return {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(system === ''
            ? {}
            : { systemInstruction: { parts: [{ text: system }] } }),
          contents: command.messages
            .filter((message) => message.role !== 'system')
            .map((message) => ({
              role: message.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: message.content }],
            })),
          generationConfig,
        }),
      };
    },
    decode(response: HttpResponse): AdapterResult {
      // 想定外の状態は、送った可能性のある利用不可として扱う（自動の再送はしない）。
      if (response.status !== 200) return { kind: 'unavailable', usage: null };
      const root: unknown = JSON.parse(response.body);
      if (!isRecord(root)) throw new Error('gemini_response_invalid');
      const usage = usageOf(root['usageMetadata']);
      const providerRequestId =
        typeof root['responseId'] === 'string' ? root['responseId'] : null;
      const done = (
        text: string,
        flags: Pick<AdapterResponse, 'refused' | 'truncated'>,
      ): AdapterResponse => ({
        kind: 'response',
        text,
        usage,
        provider_request_id: providerRequestId,
        ...flags,
      });
      const feedback = root['promptFeedback'];
      if (isRecord(feedback) && typeof feedback['blockReason'] === 'string')
        return done('', { refused: true, truncated: false });
      const candidates = root['candidates'];
      const first: unknown = Array.isArray(candidates) ? candidates[0] : null;
      if (!isRecord(first)) throw new Error('gemini_candidate_missing');
      const finish = first['finishReason'];
      const content = first['content'];
      const parts =
        isRecord(content) && Array.isArray(content['parts'])
          ? content['parts']
          : [];
      // 思考の要約（thought: true）は出力に混ぜない。
      const text = parts
        .filter(
          (part): part is Record<string, unknown> =>
            isRecord(part) &&
            typeof part['text'] === 'string' &&
            part['thought'] !== true,
        )
        .map((part) => part['text'] as string)
        .join('');
      if (typeof finish === 'string' && REFUSAL_REASONS.has(finish))
        return done('', { refused: true, truncated: false });
      if (finish === 'MAX_TOKENS')
        return done(text, { refused: false, truncated: true });
      if (finish !== 'STOP') throw new Error('gemini_finish_reason_unknown');
      return done(text, { refused: false, truncated: false });
    },
  };
}
