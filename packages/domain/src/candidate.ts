// 気づき（候補）の状態・保持・表示順の規則（設計 11 §4、設計 04 気づきの作成／通知の重複、
// QA12・QA35、ADR 0073）。DB と画面は B11-03・B11-05。ここは純粋な規則だけを持つ。

export const CANDIDATE_STATES = [
  'new',
  'seen',
  'acted',
  'dismissed',
  'snoozed',
  'resolved',
] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];

export const CANDIDATE_EVENTS = [
  'open',
  'act',
  'dismiss',
  'snooze',
  'resolve',
] as const;
export type CandidateEvent = (typeof CANDIDATE_EVENTS)[number];

// 活動中は一覧に残し、解決・却下から 7 日で抄録を消し、notification_key と状態だけを 90 日残す。
const DAY_MS = 86_400_000;
export const CANDIDATE_CONTENT_RETENTION_DAYS = 7;
export const CANDIDATE_IDENTIFIER_RETENTION_DAYS = 90;

const TRANSITIONS: Readonly<
  Record<
    CandidateState,
    Readonly<Partial<Record<CandidateEvent, CandidateState>>>
  >
> = {
  new: {
    open: 'seen',
    act: 'acted',
    dismiss: 'dismissed',
    snooze: 'snoozed',
    resolve: 'resolved',
  },
  seen: {
    act: 'acted',
    dismiss: 'dismissed',
    snooze: 'snoozed',
    resolve: 'resolved',
  },
  // acted は期限まで一覧に残す。解決すると一覧から外れる。
  acted: { resolve: 'resolved' },
  snoozed: {
    open: 'seen',
    act: 'acted',
    dismiss: 'dismissed',
    resolve: 'resolved',
  },
  dismissed: {},
  resolved: {},
};

export function candidateTransition(
  state: CandidateState,
  event: CandidateEvent,
): CandidateState | null {
  return TRANSITIONS[state][event] ?? null;
}

export interface CandidateRetention {
  readonly active: boolean;
  readonly content_until: string | null;
  readonly identifier_until: string | null;
}

// 活動中（new・seen・acted・snoozed）は期限を切らない。resolved・dismissed は
// 状態が変わった時刻から 7 日後に抄録を消し、さらに 90 日後（合計 97 日）に識別子を消す。
export function candidateRetention(
  state: CandidateState,
  changedAt: string,
): CandidateRetention {
  const active =
    state === 'new' ||
    state === 'seen' ||
    state === 'acted' ||
    state === 'snoozed';
  if (active)
    return { active: true, content_until: null, identifier_until: null };
  const at = Date.parse(changedAt);
  const content = new Date(
    at + CANDIDATE_CONTENT_RETENTION_DAYS * DAY_MS,
  ).toISOString();
  const identifier = new Date(
    at +
      (CANDIDATE_CONTENT_RETENTION_DAYS + CANDIDATE_IDENTIFIER_RETENTION_DAYS) *
        DAY_MS,
  ).toISOString();
  return {
    active: false,
    content_until: content,
    identifier_until: identifier,
  };
}
