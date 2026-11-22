// Outlook（Microsoft Graph）添付の取得と抽出（B09-03、設計 04・設計 11 §2・§3、ADR 0140）。
//
// Gmail 用（mail-attachments.ts）と同じく、解析の入口が受ける ExtractionMailInput の添付部分を作る。
// 流れは:
//   メッセージの添付を列挙（connector の listAttachments。内容は含まない）
//   → 取得してよいかを domain の checkAttachment で判定（選択した種類・サイズだけ。provider 非依存）
//   → 許可したものだけ getAttachment で個別に取得（設計 04）
//   → PC 内でテキストを抽出（Gmail と共通の extractMailAttachmentText）
//   → MailAttachmentInput（extracted／failed／範囲外）へ写す。
//
// Gmail との形の違いは provider の API の違いだけ:
// - Gmail は payload の木にパートが入っているが、Graph は添付が別経路（列挙→個別取得）なので、
//   この loader が列挙から持つ。hasAttachments が false のメッセージでは列挙を呼ばない。
// - 列挙そのものが失敗し、添付があることだけが分かっている場合は、添付の ID を作れない。
//   空配列を返すと「添付なし・全部読めた」ことになり条件Bが誤って確定する（設計 11 §2）ため、
//   位置だけの ID（attachment-0）の failed を 1 件返して未読を表す（ADR 0140）。
// - 'item'・'reference' の添付はバイト列で取れない（connector が data: null を返す）ため、
//   許可対象でも取得できたことにせず failed（未読）にする。
// - 添付の読み取りは外部の読み取りなので、保存期限の掃除のゲートを通す（ADR 0053・0058）。
//   閉じていれば列挙も取得もせず、未読を 1 件返す。
// - 添付のバイト列と抽出テキストはここでは保存しない（Gmail と同じ。保存層に置き場所は無い）。
// - 呼び出し側（解析計画が保存済みメールから入力を組み立てる配線）は B10・B11 の後続処理で、
//   ここは Graph のメッセージ 1 通分の部品として閉じる。
import type { MailAttachmentInput } from '@buddy/ai';
import { checkAttachment, classifyAttachment } from '@buddy/domain';
import type { FetchScope, StartupGateDecision } from '@buddy/domain';
import type { GraphMailConnector } from '@buddy/connectors';
import { extractMailAttachmentText } from './mail-attachments.js';

export interface GraphMailAttachmentLoaderOptions {
  // 添付の列挙と取得だけを使う（メッセージの読み取り等は使わない）。
  readonly graph: Pick<GraphMailConnector, 'listAttachments' | 'getAttachment'>;
  // 接続の保存済みの取得範囲。範囲を広げる既定値は作らない（呼び出し側が保存済みの選択を渡す）。
  readonly scope: FetchScope;
  // PDF のテキスト抽出（試験で差し替える）。省略時は unpdf。
  readonly extractPdfText?: (data: Uint8Array) => Promise<string>;
  // 保存期限の掃除のゲート（ADR 0053・0058）。省略時は通さない（試験・模擬用）。
  // 製品では core.ts が RetentionSweeper の ready／gate／lease を渡す。
  readonly retention?: {
    readonly ready: () => Promise<void>;
    readonly gate: () => StartupGateDecision;
    // ゲートの確認から抽出の終わりまでを掃除の本体と直列にする貸し出し。取れないときは null。
    readonly lease: () => (() => void) | null;
  };
}

export interface GraphMailAttachmentLoader {
  load(request: {
    readonly messageId: string;
    // 件名・本文と同じメッセージの版。添付の source_revision に使う（根拠の対応付け、設計 11 §3）。
    readonly messageRevision: string;
    // メッセージの hasAttachments。false なら添付は無いものとして列挙を呼ばない。
    readonly hasAttachments: boolean;
  }): Promise<readonly MailAttachmentInput[]>;
}

type LoadRequest = Parameters<GraphMailAttachmentLoader['load']>[0];

export function createGraphMailAttachmentLoader(
  options: GraphMailAttachmentLoaderOptions,
): GraphMailAttachmentLoader {
  // 添付があるのに中身へ進めない（列挙の失敗・掃除ゲートが閉じている）ときの未読 1 件。
  // ID を作れないので位置だけの ID で表す（空配列＝「全部読めた」にしない。設計 11 §2、ADR 0140）。
  const unreadOne = (messageRevision: string): MailAttachmentInput[] => [
    {
      attachment_id: 'attachment-0',
      permitted: true,
      state: 'failed',
      source_revision: messageRevision,
    },
  ];

  async function loadAttachments(
    request: LoadRequest,
  ): Promise<readonly MailAttachmentInput[]> {
    const listed = await options.graph.listAttachments(request.messageId);
    if (listed.kind !== 'ok') return unreadOne(request.messageRevision);
    const results: MailAttachmentInput[] = [];
    // 名前の無い添付（インライン等）は添付として扱わない（Gmail の列挙と同じ）。
    const attachments = listed.value.attachments.filter(
      (attachment) => attachment.name !== '',
    );
    for (const attachment of attachments) {
      const attachmentId = attachment.attachment_id;
      const mimeType = attachment.content_type ?? '';
      const check = checkAttachment(options.scope, {
        mimeType,
        filename: attachment.name,
        sizeBytes: attachment.size_bytes,
      });
      if (!check.ok) {
        // 範囲外は取得しない。未読にも数えない（permitted: false が抽出入力側の印）。
        results.push({
          attachment_id: attachmentId,
          permitted: false,
          state: 'unread',
          source_revision: null,
        });
        continue;
      }
      const failed: MailAttachmentInput = {
        attachment_id: attachmentId,
        permitted: true,
        state: 'failed',
        source_revision: request.messageRevision,
      };
      const fetched = await options.graph.getAttachment(
        request.messageId,
        attachmentId,
      );
      // 取得の失敗と、バイト列で取れない添付（'item'・'reference'）は未読にする。
      if (fetched.kind !== 'ok' || fetched.value.data === null) {
        results.push(failed);
        continue;
      }
      const data = fetched.value.data;
      // 申告サイズで検査を通っていても、実物が上限を超えていたら使わない（広げない）。
      if (data.length > options.scope.attachmentMaxBytes) {
        results.push(failed);
        continue;
      }
      const classified = classifyAttachment({
        mimeType,
        filename: attachment.name,
      });
      // checkAttachment を通っているので種類は決まっている。決まらなければ失敗として扱う。
      if (classified.kind === null) {
        results.push(failed);
        continue;
      }
      // 抽出は Gmail と共通。charset は contentType の宣言（あれば）に従う。
      const text = await extractMailAttachmentText({
        kind: classified.kind,
        data,
        contentType: attachment.content_type,
        extractPdfText: options.extractPdfText,
      });
      if (text === null) {
        results.push(failed);
        continue;
      }
      results.push({
        attachment_id: attachmentId,
        permitted: true,
        state: 'extracted',
        source_revision: request.messageRevision,
        text,
      });
    }
    return results;
  }

  return {
    async load(request) {
      if (!request.hasAttachments) return [];
      // 掃除が済むまで外部の読み取りを始めない（ADR 0053・0058。同期の実行器と同じ）。
      let release: (() => void) | null = null;
      if (options.retention !== undefined) {
        for (let attempt = 0; release === null && attempt < 3; attempt += 1) {
          await options.retention.ready();
          const gate = options.retention.gate();
          if (!gate.search || !gate.auto_use)
            return unreadOne(request.messageRevision);
          release = options.retention.lease();
        }
        if (release === null) return unreadOne(request.messageRevision);
      }
      try {
        return await loadAttachments(request);
      } finally {
        release?.();
      }
    },
  };
}
