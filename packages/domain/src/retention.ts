// 削除期限の計算（設計 03 保存期限・今回選ぶ会話以外の運用データの扱い、08 §5、11 §4、J12、ADR 0010）。
// 期限は起点の時刻から一度だけ計算して保存し、利用・継続・再要約では計算し直さない。

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface RetentionRule {
  readonly anchor:
    'created' | 'occurred' | 'issued' | 'fetched' | 'completed' | 'closed';
  readonly ms: number;
}

export const RETENTION_RULES: Readonly<Record<string, RetentionRule>> = {
  // 会話の全文（03）。発言の生成から。
  turn_normal: { anchor: 'created', ms: 7 * DAY_MS },
  turn_extended: { anchor: 'created', ms: 30 * DAY_MS },
  // 本文なしの運用メタデータ（08 §5）。
  command_receipt: { anchor: 'created', ms: 7 * DAY_MS },
  event_outbox: { anchor: 'occurred', ms: 7 * DAY_MS },
  command_scope: { anchor: 'issued', ms: DAY_MS },
  pairing_code: { anchor: 'created', ms: 5 * 60_000 },
  // 取得した本文のキャッシュ（03）。sync_batch / staging もこの範囲で削除する。
  source_body: { anchor: 'fetched', ms: 24 * HOUR_MS },
  sync_batch: { anchor: 'created', ms: 24 * HOUR_MS },
  // 完了した依頼の結果・未確定案（03）。
  workflow_result: { anchor: 'completed', ms: 7 * DAY_MS },
  // 完了後の本文なし操作レシート（03）。
  operation_receipt: { anchor: 'completed', ms: 90 * DAY_MS },
  // 自動実行の取り消し一覧と取り消しに必要な情報（J12）。
  undo_window: { anchor: 'completed', ms: 30 * DAY_MS },
  // 気づきの抄録と、再通知の重複を防ぐキー（11 §4）。
  candidate_excerpt: { anchor: 'closed', ms: 7 * DAY_MS },
  candidate_key: { anchor: 'closed', ms: 97 * DAY_MS },
};

export function deleteAt(ruleId: string, anchorTime: string): string {
  const rule = RETENTION_RULES[ruleId];
  if (!rule) throw new Error(`unknown retention rule ${ruleId}`);
  return new Date(Date.parse(anchorTime) + rule.ms)
    .toISOString()
    .replace('.000Z', 'Z');
}

// 会話の保存モードごとの発言の期限。記録しない会話は保存しないので期限もない。
export function turnRetentionRule(
  storageMode: 'normal' | 'extended' | 'private',
): string | null {
  if (storageMode === 'private') return null;
  return storageMode === 'extended' ? 'turn_extended' : 'turn_normal';
}

// 削除してよいか。時計が巻き戻ったときは期限を延ばさず、整合するまで自動利用だけを止める（memory.ts の expiryUsableReasons）。
export function isDue(deleteAtTime: string, now: string): boolean {
  return Date.parse(now) >= Date.parse(deleteAtTime);
}
