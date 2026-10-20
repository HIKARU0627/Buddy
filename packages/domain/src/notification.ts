// 通知の再送と一覧表示の分離（設計 08 §7、11 §4、ADR 0010）。

export type DeliveryTrigger =
  'new_candidate' | 'refetch' | 'reconnect' | 'device_move' | 'user_reminder';

export interface DeliveryRecord {
  readonly notification_key: string;
  readonly reminder_id: string;
  readonly status: 'intent_saved' | 'delivered' | 'delivery_unknown';
}

// ポップアップ・読み上げを新しく出すか。再取得・再接続・端末移動では新しいアラートを作らない。
// 本人が指定した再通知だけが別の reminder_id で一度出る。一覧は現在状態の投影で、ここでは扱わない。
export function deliveryDecision(
  existing: readonly DeliveryRecord[],
  request: {
    readonly notification_key: string;
    readonly trigger: DeliveryTrigger;
    readonly reminder_id: string | null;
  },
): { readonly deliver: boolean; readonly reason: string | null } {
  if (request.trigger === 'user_reminder' && request.reminder_id === null)
    return { deliver: false, reason: 'reminder_id_required' };
  if (request.trigger !== 'user_reminder' && request.reminder_id !== null)
    return { deliver: false, reason: 'reminder_id_only_for_user' };
  if (
    request.trigger === 'refetch' ||
    request.trigger === 'reconnect' ||
    request.trigger === 'device_move'
  )
    return { deliver: false, reason: 'not_a_new_alert' };
  const reminder = request.reminder_id ?? '';
  if (
    existing.some(
      (record) =>
        record.notification_key === request.notification_key &&
        record.reminder_id === reminder,
    )
  )
    return { deliver: false, reason: 'already_delivered' };
  return { deliver: true, reason: null };
}

// 配信の ACK を失ったら delivery_unknown にし、自動で鳴らし直さない。既読とも表示しない。
export function deliveryAfterAck(
  record: DeliveryRecord,
  ack: 'received' | 'lost',
): DeliveryRecord {
  if (record.status !== 'intent_saved') return record;
  return {
    ...record,
    status: ack === 'received' ? 'delivered' : 'delivery_unknown',
  };
}
