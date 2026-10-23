// 模擬 provider の合成データ（設計 09 §2）。実メール・実予定は使わない。

/** 時計。設計 09 §2 の 2026-10-05T09:00+09:00。 */
export const SYNTHETIC_CLOCK = '2026-10-05T09:00:00+09:00';

/** H01 の fixture（packages/contracts/fixtures/h01.json）と同じ合成の口座。 */
export const SYNTHETIC_ACCOUNT_ID = '00000000-0000-4000-8000-000000000002';

export interface MockMail {
  remote_id: string;
  source_revision: string;
  mailbox: string;
  labels: string[];
  subject: string;
  from: string;
  /** 受信日時（承認画面で対象のメールを見分けるための表示用。合成の値）。 */
  received_at: string;
}

export interface MockEvent {
  event_id: string;
  title: string;
  start: string;
  end: string;
}

export interface MockDraft {
  draft_id: string;
  /** 作成した要求の識別。正確な対象の lookup（operation_id と step_id）に使う。 */
  operation_id: string;
  attempt_id: string;
  step_id: string | null;
  /** 操作の目印（buddy-op:<operation_id>:<content_version>）。結果不明のときの照合で探す。付けない要求は null。 */
  marker: string | null;
  /** 返信元のメールの ID。返信でない下書きは null。 */
  in_reply_to: string | null;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  status: 'draft' | 'sent';
  /** 送信した回数。重複した送信要求も消さずに数える。 */
  send_count: number;
}

export interface MockPermission {
  account_id: string;
  /** 口座の表示名（承認画面で口座を見分けるための表示用。合成の値）。 */
  account_label: string;
  permission_revision: string;
  scopes: string[];
}

/** 受信記録 1 件（fault-points.json の mock_service.records）。 */
export interface MockReceipt {
  receive_order: number;
  received_at: string;
  route: string;
  operation_id: string | null;
  attempt_id: string | null;
  step_id: string | null;
  /** 適用した変更。適用していなければ null（拒否・保留中・不正な要求）。 */
  applied_change: AppliedChange | null;
  /** 応答を返したか。応答を返さず接続を切った・保留中は false。 */
  responded: boolean;
  response_status: number | null;
}

export type AppliedChange =
  | {
      kind: 'mail.labels.change';
      remote_id: string;
      add: string[];
      remove: string[];
      labels_after: string[];
    }
  | { kind: 'mail.draft.create'; draft_id: string }
  | { kind: 'mail.draft.send'; draft_id: string };

export interface ProviderState {
  schema: 'buddy.mock-provider.v1';
  permission: MockPermission;
  mails: Record<string, MockMail>;
  events: MockEvent[];
  drafts: Record<string, MockDraft>;
  /** 状態の変更の回数。受信記録の件数（要求の回数）とは別に数える。 */
  state_changes: number;
  next_draft: number;
  next_receive_order: number;
  receipts: MockReceipt[];
}

export const WRITE_SCOPES = {
  labels: 'mail.labels.change',
  draftCreate: 'mail.drafts.create',
  draftSend: 'mail.drafts.send',
} as const;

export function seedState(): ProviderState {
  return {
    schema: 'buddy.mock-provider.v1',
    permission: {
      account_id: SYNTHETIC_ACCOUNT_ID,
      account_label: 'synthetic-user@example.com',
      permission_revision: '1',
      scopes: [
        'mail.read',
        'calendar.read',
        WRITE_SCOPES.labels,
        WRITE_SCOPES.draftCreate,
        WRITE_SCOPES.draftSend,
      ],
    },
    mails: {
      'mail-001': {
        remote_id: 'mail-001',
        source_revision: 'r1',
        mailbox: 'INBOX',
        labels: [],
        subject: '（合成）来週の打ち合わせの日程',
        from: 'synthetic-sender@example.com',
        received_at: '2026-10-04T18:30:00+09:00',
      },
    },
    // 13:30〜14:00 が重なる 2 件。
    events: [
      {
        event_id: 'event-001',
        title: '（合成）定例の打ち合わせ',
        start: '2026-10-05T13:00:00+09:00',
        end: '2026-10-05T14:00:00+09:00',
      },
      {
        event_id: 'event-002',
        title: '（合成）歯科の予約',
        start: '2026-10-05T13:30:00+09:00',
        end: '2026-10-05T14:30:00+09:00',
      },
    ],
    drafts: {},
    state_changes: 0,
    next_draft: 1,
    next_receive_order: 1,
    receipts: [],
  };
}
