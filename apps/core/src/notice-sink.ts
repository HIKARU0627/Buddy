// 期限切れ・記録しない会話の終了の知らせを渡すポート（設計 03、ADR 0040・0058・0059、B06-07）。
//
// 期限切れ: 掃除の計画の知らせの下書き（ID と理由だけ・256 件まで）から、実際に消せた物だけで契約の RetentionNotice を
// 作り、NoticeSink に渡す（07a-1）。記録しない会話の終了: Core の再起動で記録しない区切りの RAM を失ったとき、通常の区切りへ
// 戻したことを契約の StorageBoundaryNotice で渡す（07a-2）。忘却: 消した物を RetentionNotice（kind forgotten）で、台帳が進んだ
// ことを ForgetLedgerNotice で渡す（07b-2、ADR 0180）。保存モードの変更: 流れの保存モードの切り替えで区切りを開き直したことを
// StorageModeNotice で渡す（UI-05 の段階 6、ADR 0189、U477。保存モードと理由だけで、区切りの ID・世代を入れない）。運び方（流れの表示の後始末と WSS の購読への配信）は
// notice-relay.ts（UI-05 の段階 3、ADR 0187）。ここは受け取りの口と試験用の実装まで。知らせの配信の失敗は元の処理の失敗にしない（消す・戻す前提
// ではなく、終えた後の表示の更新）。本文・要約・検索語を入れない（ID と理由と番号だけ）。

import type {
  ForgetLedgerNotice,
  RetentionNotice,
  StorageBoundaryNotice,
  StorageModeNotice,
} from '@buddy/contracts';

export type Notice =
  | RetentionNotice
  | StorageBoundaryNotice
  | ForgetLedgerNotice
  | StorageModeNotice;

export interface NoticeSink {
  publish(notice: Notice): void | Promise<void>;
}

// 知らせの対象の ID の形（契約の OriginalSourceId）。発言・記憶の ID（UUID）もこの形に収まる。
const NOTICE_ITEM_ID = /^[A-Za-z0-9._:=+~-]{1,256}$/u;

export const isNoticeItemId = (value: string): boolean =>
  NOTICE_ITEM_ID.test(value);

// 試験用の実装。渡された知らせをそのまま並べて持つ（期限切れ・忘却と、記録しない会話の終了と、台帳が進んだ知らせを分けて）。
export class RecordingNoticeSink implements NoticeSink {
  readonly notices: RetentionNotice[] = [];
  readonly boundaryNotices: StorageBoundaryNotice[] = [];
  readonly ledgerNotices: ForgetLedgerNotice[] = [];
  readonly modeNotices: StorageModeNotice[] = [];
  publish(notice: Notice): void {
    if (notice.schema === 'buddy.storage-boundary-notice.v1')
      this.boundaryNotices.push(notice);
    else if (notice.schema === 'buddy.forget-ledger-notice.v1')
      this.ledgerNotices.push(notice);
    else if (notice.schema === 'buddy.storage-mode-notice.v1')
      this.modeNotices.push(notice);
    else this.notices.push(notice);
  }
}
