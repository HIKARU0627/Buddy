// 気づきの行の文言の規則（設計 11 §4 気づきの行に出すもの、設計 04 気づきの作成、ADR 0115）。
// 送信済み・アーカイブを読まないので、返信の有無を断定しない。メールの候補は常に「対応済みかは未確認」と出す。

import type { CandidateKindName } from './candidate-order.js';

export const CANDIDATE_TITLE_MAX_CODE_POINTS = 60;
export const MAIL_UNCONFIRMED_NOTE = '対応済みかは未確認';
export const PARTIAL_UNREAD_NOTE = '本文・添付の一部は未読';

// 返信・対応がまだ無いと言い切る言い回し。「参加可否の返信：10/7まで」のような依頼の題は許す。
const UNREPLIED_ASSERTIONS: readonly RegExp[] = [
  /未(?:返信|対応|回答)/u,
  /返信(?:が|は|を)?(?:まだ)?(?:していません|していない|されていません|ありません|来ていません|ない)/u,
  /返事(?:が|は)?(?:まだ)?(?:ありません|来ていません|ない)/u,
  /まだ(?:返信|返事|対応|回答)/u,
  /(?:返信|対応|回答)(?:漏れ|忘れ)/u,
  /\bunreplied\b/iu,
  /\bno reply\b/iu,
  /\bnot (?:yet )?replied\b/iu,
];

export type CandidateTitleError =
  'title_empty' | 'title_too_long' | 'asserts_unreplied';

// 題の検査。空・60 文字（コードポイント）超・未返信の断定を拒む。
export function candidateTitleErrors(title: string): CandidateTitleError[] {
  const errors: CandidateTitleError[] = [];
  if (title.trim() === '') errors.push('title_empty');
  if ([...title].length > CANDIDATE_TITLE_MAX_CODE_POINTS)
    errors.push('title_too_long');
  if (UNREPLIED_ASSERTIONS.some((pattern) => pattern.test(title)))
    errors.push('asserts_unreplied');
  return errors;
}

const isMailKind = (kind: CandidateKindName): boolean =>
  kind === 'mail_deadline' || kind === 'mail_reply';

// 行に添える注記。メールの候補は常に「対応済みかは未確認」。一部未読なら未読の注記を続ける。
export function candidateRowNotes(candidate: {
  readonly kind: CandidateKindName;
  readonly unread_partial: boolean;
}): string[] {
  const notes: string[] = [];
  if (isMailKind(candidate.kind)) notes.push(MAIL_UNCONFIRMED_NOTE);
  if (candidate.unread_partial) notes.push(PARTIAL_UNREAD_NOTE);
  return notes;
}
