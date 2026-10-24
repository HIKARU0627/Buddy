// 保存案の表ごとの方針（ADR 0010。0003 の表は ADR 0022、0004 の表は ADR 0029、0005 の表は ADR 0030、0006 の表は ADR 0036、0008 の表は ADR 0046）。migrations の全版を適用した表と一致することを scripts/storage.test.mjs で検査する。
// retention は domain の RETENTION_RULES の ID、または期限の持ち方の説明。body は本文の置き場所。
// transaction は同じ短い transaction で書く表の組（08 §3・§5、11 §1A・§9）。

export type BodyPolicy = 'none' | 'sealed_refs';

export interface TablePolicy {
  readonly body: BodyPolicy;
  readonly retention: string;
  readonly transaction: string;
}

export const TABLE_POLICIES: Readonly<Record<string, TablePolicy>> = {
  schema_meta: {
    body: 'none',
    retention: 'permanent',
    transaction: 'migration',
  },
  sealed_blobs: {
    body: 'sealed_refs',
    retention: 'delete_at_of_owner',
    transaction: 'owner',
  },
  devices: {
    body: 'none',
    retention: 'until_revoked_and_removed',
    transaction: 'pairing',
  },
  pairing_sessions: {
    body: 'none',
    retention: 'pairing_code',
    transaction: 'pairing',
  },
  pairing_claims: {
    body: 'none',
    retention: 'pairing_code',
    transaction: 'pairing',
  },
  command_scopes: {
    body: 'none',
    retention: 'command_scope',
    transaction: 'connection',
  },
  // 0003（B03-03、ADR 0022）。MAC・SSID は HMAC だけ。登録は家ごとに 1 つ、報告は端末ごとに最新の 1 件。
  home_networks: {
    body: 'none',
    retention: 'until_replaced',
    transaction: 'home_network',
  },
  home_network_reports: {
    body: 'none',
    retention: 'latest_per_device',
    transaction: 'home_network',
  },
  // 0004（B04-03、ADR 0029）。発言への応答（ID・状態・決まった文だけ）。発言と同じ期限。
  turn_responses: {
    body: 'none',
    retention: 'turn_normal_or_turn_extended',
    transaction: 'conversation',
  },
  connections: {
    body: 'sealed_refs',
    retention: 'until_disconnected',
    transaction: 'connection',
  },
  sessions: {
    body: 'sealed_refs',
    retention: 'turn_normal_or_turn_extended',
    transaction: 'conversation',
  },
  turns: {
    body: 'sealed_refs',
    retention: 'turn_normal_or_turn_extended',
    transaction: 'conversation',
  },
  workflows: {
    body: 'none',
    retention: 'workflow_result',
    transaction: 'conversation',
  },
  input_snapshots: {
    body: 'none',
    retention: 'turn_normal_or_turn_extended',
    transaction: 'conversation',
  },
  operations: {
    body: 'none',
    retention: 'operation_receipt',
    transaction: 'operation',
  },
  operation_versions: {
    body: 'sealed_refs',
    retention: 'operation_receipt',
    transaction: 'operation',
  },
  approvals: {
    body: 'none',
    retention: 'operation_receipt',
    transaction: 'operation',
  },
  operation_attempts: {
    body: 'none',
    retention: 'operation_receipt',
    transaction: 'operation',
  },
  // 0005（ADR 0030）: 用事。題名・期限・本文は確定 intent の暗号文を参照し、複製しない。
  tasks: {
    body: 'none',
    retention: 'operation_receipt',
    transaction: 'operation',
  },
  operation_steps: {
    body: 'none',
    retention: 'operation_receipt',
    transaction: 'operation',
  },
  command_receipts: {
    body: 'none',
    retention: 'command_receipt',
    transaction: 'operation',
  },
  event_outbox: {
    body: 'none',
    retention: 'event_outbox',
    transaction: 'operation',
  },
  async_context_guards: {
    body: 'none',
    retention: 'until_job_finished',
    transaction: 'operation',
  },
  auto_actions: {
    body: 'none',
    retention: 'undo_window',
    transaction: 'operation',
  },
  undo_records: {
    body: 'none',
    retention: 'undo_window',
    transaction: 'operation',
  },
  safety_breaker: {
    body: 'none',
    retention: 'permanent',
    transaction: 'operation',
  },
  safety_window_counts: {
    body: 'none',
    retention: 'window_length',
    transaction: 'operation',
  },
  budget_reservations: {
    body: 'none',
    retention: 'until_settled_and_month_closed',
    transaction: 'budget',
  },
  live_sessions: {
    body: 'none',
    retention: 'until_settled',
    transaction: 'budget',
  },
  // 0006（B07-03、ADR 0036）: 超過枠の個別の承認と、予算月の状態（月ごとに 1 行、書き換えない）。
  budget_overage_approvals: {
    body: 'none',
    retention: 'until_consumed_or_expired_and_month_closed',
    transaction: 'budget',
  },
  budget_months: {
    body: 'none',
    retention: 'permanent',
    transaction: 'budget',
  },
  // 0007（B07-04、ADR 0037）: 本人による予算月の確かめ直し（書き換えない）。
  budget_month_confirmations: {
    body: 'none',
    retention: 'permanent',
    transaction: 'budget',
  },
  // 0008（B05-03、ADR 0046）: 端末ごとの音声の世代と端末単位の停止（戻さない・消さない）。
  device_epochs: {
    body: 'none',
    retention: 'permanent',
    transaction: 'voice',
  },
  // 0008（B05-03、ADR 0046）: 来客モードと全体停止（家ごとに 1 行。再起動で解除しない）。
  io_stop_state: {
    body: 'none',
    retention: 'permanent',
    transaction: 'voice',
  },
  sync_scopes: {
    body: 'none',
    retention: 'until_disconnected',
    transaction: 'sync_publish',
  },
  sync_batches: {
    body: 'none',
    retention: 'sync_batch',
    transaction: 'sync_publish',
  },
  sync_staging: {
    body: 'none',
    retention: 'sync_batch',
    transaction: 'sync_page',
  },
  source_items: {
    body: 'sealed_refs',
    retention: 'source_body',
    transaction: 'sync_publish',
  },
  request_entities: {
    body: 'sealed_refs',
    retention: 'candidate_key',
    transaction: 'analysis',
  },
  request_entity_operations: {
    body: 'none',
    retention: 'candidate_key',
    transaction: 'operation',
  },
  related_analyses: {
    body: 'none',
    retention: 'until_superseded',
    transaction: 'analysis',
  },
  notification_candidates: {
    body: 'sealed_refs',
    retention: 'candidate_excerpt_then_key',
    transaction: 'analysis',
  },
  deliveries: {
    body: 'none',
    retention: 'candidate_key',
    transaction: 'delivery',
  },
  memories: {
    body: 'sealed_refs',
    retention: 'memory_review',
    transaction: 'memory',
  },
  memory_sources: {
    body: 'none',
    retention: 'memory_review',
    transaction: 'memory',
  },
  forget_ledger: {
    body: 'none',
    retention: 'permanent',
    transaction: 'forget',
  },
  forget_ledger_items: {
    body: 'none',
    retention: 'permanent',
    transaction: 'forget',
  },
  user_directives: {
    body: 'sealed_refs',
    retention: 'until_user_removes_or_session_ends',
    transaction: 'conversation',
  },
  intent_shadow: {
    body: 'none',
    retention: 'same_as_turn',
    transaction: 'shadow',
  },
  deployments: {
    body: 'none',
    retention: 'permanent',
    transaction: 'deployment',
  },
  evaluation_results: {
    body: 'none',
    retention: 'permanent',
    transaction: 'deployment',
  },
};

// 本文・宛先・要約を平文で持ってはいけない列名。暗号文は *_blob_id で sealed_blobs を参照する。
export const PLAINTEXT_COLUMN_NAMES: readonly string[] = [
  'body',
  'text',
  'subject',
  'quote',
  'title',
  'summary',
  'excerpt',
  'content',
  'transcript',
  'email',
  'address',
  'recipients',
  'token',
  'secret',
  'utterance',
];

export interface ObservedPragmas {
  readonly journal_mode: string;
  readonly synchronous: number;
  readonly fullfsync: number;
  readonly foreign_keys: number;
}

// 書込み接続の PRAGMA の読み戻し（08 §3、11 §9）。一つでも違えば外部変更を開始しない。
// 一致しても電源断で記録が残ることの証明ではない（X60 は未実施）。
export function pragmaReasons(
  observed: ObservedPragmas,
  platform: 'macos' | 'windows' | 'linux',
): string[] {
  const reasons: string[] = [];
  if (observed.journal_mode.toLowerCase() !== 'wal')
    reasons.push('journal_mode_not_wal');
  if (observed.synchronous !== 2) reasons.push('synchronous_not_full');
  if (platform === 'macos' && observed.fullfsync !== 1)
    reasons.push('fullfsync_off');
  if (observed.foreign_keys !== 1) reasons.push('foreign_keys_off');
  return reasons;
}
