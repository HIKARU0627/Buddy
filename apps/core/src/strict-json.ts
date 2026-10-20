// 制御チャネル・ロック・状態ファイル用の厳格な JSON 読み取り（ADR 0012）。
// JSON.parse は重複キーを後勝ちで受け入れるため、構文と重複キーを自前で検査する。
// 外部依存を持たず、scripts/contract-tools.mjs の parseStrictJson と同じ考え方
// （重複キー・不正な Unicode・非有限の数・深すぎる入れ子を拒否）にそろえる。

export type JsonValue =
  null | boolean | number | string | JsonValue[] | JsonObject;
// 原型を持たないオブジェクト。`__proto__` も通常のキーとして扱う。
export interface JsonObject {
  [key: string]: JsonValue;
}

export type StrictJsonErrorCode =
  'invalid_json' | 'duplicate_key' | 'invalid_unicode' | 'too_deep';

export class StrictJsonError extends Error {
  readonly code: StrictJsonErrorCode;
  constructor(code: StrictJsonErrorCode) {
    super(code);
    this.name = 'StrictJsonError';
    this.code = code;
  }
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
// u フラグなしで UTF-16 の符号単位として照合する（lib が ES2023 のため isWellFormed を使わない）。
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

export function parseStrictJson(text: string, maxDepth = 16): JsonValue {
  let pos = 0;
  const fail = (code: StrictJsonErrorCode = 'invalid_json'): never => {
    throw new StrictJsonError(code);
  };
  const skip = () => {
    while (pos < text.length && WHITESPACE.has(text[pos] as string)) pos += 1;
  };
  const expect = (literal: string) => {
    if (!text.startsWith(literal, pos)) fail();
    pos += literal.length;
  };
  const parseString = (): string => {
    expect('"');
    let out = '';
    for (;;) {
      if (pos >= text.length) fail();
      const char = text[pos] as string;
      if (char === '"') {
        pos += 1;
        break;
      }
      if (char.charCodeAt(0) < 0x20) fail();
      if (char === '\\') {
        const next = text[pos + 1];
        if (next === 'u') {
          const hex = text.slice(pos + 2, pos + 6);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail();
          out += String.fromCharCode(Number.parseInt(hex, 16));
          pos += 6;
          continue;
        }
        const escaped = next === undefined ? undefined : ESCAPES[next];
        if (escaped === undefined) fail();
        out += escaped;
        pos += 2;
        continue;
      }
      out += char;
      pos += 1;
    }
    // 対になっていないサロゲートを拒否する。
    if (LONE_SURROGATE.test(out)) fail('invalid_unicode');
    return out;
  };
  // depth は外側にあるオブジェクト・配列の数。入れ子は maxDepth 段まで。
  const parseValue = (depth: number): JsonValue => {
    skip();
    const char = text[pos];
    if ((char === '{' || char === '[') && depth >= maxDepth) fail('too_deep');
    if (char === '{') {
      pos += 1;
      const object = Object.create(null) as JsonObject;
      skip();
      if (text[pos] === '}') {
        pos += 1;
        return object;
      }
      for (;;) {
        skip();
        const key = parseString();
        if (Object.hasOwn(object, key)) fail('duplicate_key');
        skip();
        expect(':');
        object[key] = parseValue(depth + 1);
        skip();
        if (text[pos] === ',') {
          pos += 1;
          continue;
        }
        expect('}');
        return object;
      }
    }
    if (char === '[') {
      pos += 1;
      const array: JsonValue[] = [];
      skip();
      if (text[pos] === ']') {
        pos += 1;
        return array;
      }
      for (;;) {
        array.push(parseValue(depth + 1));
        skip();
        if (text[pos] === ',') {
          pos += 1;
          continue;
        }
        expect(']');
        return array;
      }
    }
    if (char === '"') return parseString();
    if (char === 't') return (expect('true'), true);
    if (char === 'f') return (expect('false'), false);
    if (char === 'n') return (expect('null'), null);
    NUMBER.lastIndex = pos;
    const match = NUMBER.exec(text);
    if (!match) return fail();
    pos += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail();
    return value;
  };
  const value = parseValue(0);
  skip();
  if (pos !== text.length) fail();
  return value;
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 規約どおりの小文字の UUID（8-4-4-4-12）。版は問わない。
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
