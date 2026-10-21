// 自己署名証明書を組み立てるための最小の DER の符号化（ITU-T X.690、ADR 0020）。
// 証明書に必要な型（SEQUENCE・SET・INTEGER・OID・文字列・時刻・BIT STRING・OCTET STRING・BOOLEAN・
// 文脈タグ）だけを持つ。読み取り（復号）はしない。組み立てた証明書は X509Certificate で読み戻して検証する。

function lengthBytes(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0)
    throw new RangeError('DER の長さが不正です。');
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256))
    bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, ...parts: readonly Uint8Array[]): Buffer {
  const content = Buffer.concat(parts);
  return Buffer.concat([
    Buffer.from([tag]),
    lengthBytes(content.length),
    content,
  ]);
}

export const sequence = (...parts: readonly Uint8Array[]): Buffer =>
  tlv(0x30, ...parts);

export const set = (...parts: readonly Uint8Array[]): Buffer =>
  tlv(0x31, ...parts);

// 文脈タグ [n] の構造化（EXPLICIT）。
export const explicit = (n: number, ...parts: readonly Uint8Array[]): Buffer =>
  tlv(0xa0 | n, ...parts);

export function boolean(value: boolean): Buffer {
  return tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
}

// 符号なしの整数のバイト列を、DER の最小の 2 の補数の INTEGER にする。
export function unsignedInteger(bytes: Uint8Array): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const trimmed = Buffer.from(bytes.subarray(start));
  if (trimmed.length === 0) return tlv(0x02, Buffer.from([0]));
  const body =
    (trimmed[0] as number) & 0x80
      ? Buffer.concat([Buffer.from([0]), trimmed])
      : trimmed;
  return tlv(0x02, body);
}

export function smallInteger(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 127)
    throw new RangeError('0 から 127 までの整数だけを扱います。');
  return tlv(0x02, Buffer.from([value]));
}

export function objectIdentifier(dotted: string): Buffer {
  const arcs = dotted.split('.').map((arc) => {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(arc))
      throw new RangeError('OID の形式が不正です。');
    return Number(arc);
  });
  const [first, second, ...rest] = arcs;
  if (
    first === undefined ||
    second === undefined ||
    first > 2 ||
    (first < 2 && second > 39)
  )
    throw new RangeError('OID の形式が不正です。');
  const bytes: number[] = [first * 40 + second];
  for (const arc of rest) {
    const chunk: number[] = [arc % 128];
    for (
      let value = Math.floor(arc / 128);
      value > 0;
      value = Math.floor(value / 128)
    )
      chunk.unshift((value % 128) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

export const utf8String = (value: string): Buffer =>
  tlv(0x0c, Buffer.from(value, 'utf8'));

export const octetString = (value: Uint8Array): Buffer => tlv(0x04, value);

// 未使用ビットの数を先頭に置いた BIT STRING。
export function bitString(value: Uint8Array, unusedBits = 0): Buffer {
  if (!Number.isInteger(unusedBits) || unusedBits < 0 || unusedBits > 7)
    throw new RangeError('未使用ビットの数が不正です。');
  return tlv(0x03, Buffer.from([unusedBits]), value);
}

const pad = (value: number, width: number): string =>
  String(value).padStart(width, '0');

// RFC 5280 §4.1.2.5: 2049 年までは UTCTime、2050 年以降は GeneralizedTime。秒まで・Z で終わる。
export function x509Time(date: Date): Buffer {
  const time = date.getTime();
  if (!Number.isFinite(time)) throw new RangeError('時刻が不正です。');
  const year = date.getUTCFullYear();
  if (year < 1950 || year > 9999) throw new RangeError('時刻が範囲外です。');
  const rest =
    pad(date.getUTCMonth() + 1, 2) +
    pad(date.getUTCDate(), 2) +
    pad(date.getUTCHours(), 2) +
    pad(date.getUTCMinutes(), 2) +
    pad(date.getUTCSeconds(), 2) +
    'Z';
  if (year < 2050)
    return tlv(0x17, Buffer.from(pad(year % 100, 2) + rest, 'ascii'));
  return tlv(0x18, Buffer.from(pad(year, 4) + rest, 'ascii'));
}
