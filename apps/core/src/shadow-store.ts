// 影モードの比較記録の保存先（`ShadowRecordStore` の SQLite 実装。ADR 0092・0110、B06-06e）。
//
// - DB worker の `intent_shadow.count`・`intent_shadow.save` を 1 命令 1 往復で呼ぶ。
// - 保存の前提（保存モードの record_shadow・入力の版と発言の結び付き・発言と同じ期限）は DB worker 側でも確かめる。
//   ここは記録と観測した保存モードを渡すだけで、判断を写し取らない。
// - 件数が読めなければ例外にする（呼び出し側の `campaignStatus` が null として扱い、比較を始めない）。
//   保存の失敗・拒否は例外にせず `failed` にする（比較の失敗で本線を止めない。ADR 0092）。
// - 結果の理由には ID・件数だけを入れ、本文・SQL・パスを入れない。
import type { DbWorkerClient, IntentShadowRecordInput } from '@buddy/storage';
import type { SaveShadowResult, ShadowRecordStore } from './shadow-mode.js';

export function createDbShadowRecordStore(
  client: Pick<DbWorkerClient, 'intentShadow'>,
): ShadowRecordStore {
  return {
    async count(campaign_id) {
      const result = await client.intentShadow({
        kind: 'intent_shadow.count',
        campaign_id,
      });
      if (!result.ok)
        throw new Error(
          `shadow_count_failed:${result.reasons.join(',') || 'unknown'}`,
        );
      return result.value.count;
    },
    async save(record, limit, storage_mode) {
      // Core が契約（IntentShadowRecord）で検証した記録。storage 側の写しの型へ渡す（形は同じ。
      // 保存側でも最低限の形と前提を確かめ直す）。
      const result = await client.intentShadow({
        kind: 'intent_shadow.save',
        record: record as unknown as IntentShadowRecordInput,
        limit,
        storage_mode,
      });
      return result.ok ? (result.value.result as SaveShadowResult) : 'failed';
    },
  };
}
