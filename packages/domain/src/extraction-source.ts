// 抽出の入力として送ったソース（件名・本文・選択した添付）の形と、位置の数え方（B10-05、ADR 0100）。
// 設計 11 §3「根拠の対応付け」: 入力を subject / body / attachment に分け、コードが source_id と source_revision を付ける。
// 位置は Unicode コードポイント単位で、end は含まない（QA11）。UTF-16 の長さ・書記素の数とは違う。

export type ExtractionSourcePart = 'subject' | 'body' | 'attachment';

// コードポイント単位の範囲。end は含まない。
export interface CodePointRange {
  readonly start: number;
  readonly end: number;
}

// モデルへ**実際に送った**ソース。text は切り詰めた後の抽出テキストで、根拠の照合は必ずこの text に対して行う
// （送っていない部分の引用を「一致」にしない）。切り詰めは先頭からの切り出しなので、位置は元の抽出テキストと同じ。
export interface ExtractionSource {
  readonly source_id: string;
  readonly part: ExtractionSourcePart;
  readonly source_revision: string;
  readonly text: string;
  // 引用された範囲（本文だけ。`>` で始まる行。件名・添付は空）。
  readonly quoted_ranges: readonly CodePointRange[];
}

export function codePointLength(text: string): number {
  // 対になったサロゲート（高 + 低）を 1 つに数える。対になっていない単独のサロゲートは 1 つに数える（for-of と同じ）。
  let count = text.length;
  for (let index = 0; index + 1 < text.length; index += 1) {
    const high = text.charCodeAt(index);
    const low = text.charCodeAt(index + 1);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
      count -= 1;
      index += 1;
    }
  }
  return count;
}

// 先頭から n コードポイントを切り出す。サロゲートペアの途中では切らない。
export function takeCodePoints(text: string, count: number): string {
  if (count <= 0) return '';
  let taken = 0;
  let end = 0;
  for (const point of text) {
    if (taken === count) break;
    taken += 1;
    end += point.length;
  }
  return text.slice(0, end);
}

// 引用の行か（行頭の空白・全角空白を除いて `>`）。
export const isQuotedLine = (line: string): boolean =>
  /^[ \t\u{3000}]*>/u.test(line);

// 引用された範囲。行頭（空白・全角空白を除く）が `>` の行を引用とする（プレーンテキストの返信の引用の慣習）。
// HTML や転送の見出し（"Original Message" など）の引用は判定しない（U241）。モデルの in_quoted_text と合わせて、
// どちらかが引用なら引用として扱う（自動実行の対象外にする方向）。
export function quotedRangesOf(text: string): readonly CodePointRange[] {
  const ranges: CodePointRange[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const length = codePointLength(line);
    if (isQuotedLine(line))
      ranges.push({ start: offset, end: offset + length });
    // 改行の 1 文字ぶんを進める。
    offset += length + 1;
  }
  return ranges;
}
