// 期限切れの知らせ（RetentionNotice）を渡すポート（設計 03、ADR 0040・0058、B06-07a-1）。
//
// 掃除の計画の知らせの下書き（ID と理由だけ・256 件まで）から、実際に消せた物だけで契約の RetentionNotice を作り、
// NoticeSink に渡す。運び方（キャンバスの購読への配信）は UI-05 が決める（U40）ので、ここは受け取りの口と試験用の
// 実装までで、運搬の経路は作らない。知らせの配信の失敗は掃除の失敗にしない（消す前提ではなく、消した後の表示の更新）。
// 本文・要約・検索語を入れない（ID と理由だけ）。

import type { RetentionNotice } from '@buddy/contracts';

export interface NoticeSink {
  publish(notice: RetentionNotice): void | Promise<void>;
}

// 知らせの対象の ID の形（契約の OriginalSourceId）。発言・記憶の ID（UUID）もこの形に収まる。
const NOTICE_ITEM_ID = /^[A-Za-z0-9._:=+~-]{1,256}$/u;

export const isNoticeItemId = (value: string): boolean =>
  NOTICE_ITEM_ID.test(value);

// 試験用の実装。渡された知らせをそのまま並べて持つ。
export class RecordingNoticeSink implements NoticeSink {
  readonly notices: RetentionNotice[] = [];
  publish(notice: RetentionNotice): void {
    this.notices.push(notice);
  }
}
