// メール添付の取得と抽出（B08-04、設計 04 J16、設計 11 §2・§3、ADR 0139）。
//
// 解析の入口（mail-extraction.ts）が受ける ExtractionMailInput の添付部分を作る。流れは:
//   payload の木から添付パートを列挙（connector の listAttachmentParts）
//   → 取得してよいかを domain の checkAttachment で判定（選択した種類・サイズだけ）
//   → 許可したものだけ attachments.get（または format=full で届いたインラインのデータ）で取得
//   → PC 内でテキストを抽出（テキスト系は charset を見て復号、PDF は unpdf）
//   → MailAttachmentInput（extracted／failed／範囲外）へ写す。
//
// - 範囲外の添付は取得しない（内容も見ない）。メタデータだけが一覧に残る（設計 04）。
// - 取得・抽出に失敗した許可対象は failed（未読）にする。失敗を「読めた・期限なし」にしない
//   （設計 11 §2: 対象添付が未取得・読取失敗なら条件Bは未確定で、除外の根拠にしない）。
// - 添付のバイト列と抽出テキストはここでは保存しない。抽出テキストは抽出入力としてだけ使い、
//   保持は抽出結果のキャッシュ・抄録の規則（設計 11 §3）に従う。保存層に添付の置き場所は無い。
// - 呼び出し側（解析計画が保存済みメールから入力を組み立てる配線）は B10・B11 の後続処理で、
//   ここは Gmail のメッセージ 1 通分の部品として閉じる。
import type { MailAttachmentInput } from '@buddy/ai';
import { checkAttachment, classifyAttachment } from '@buddy/domain';
import type { FetchScope } from '@buddy/domain';
import type { StartupGateDecision } from '@buddy/domain';
import { decodeBase64Url, listAttachmentParts } from '@buddy/connectors';
import type {
  GoogleGmailAttachmentPart,
  GoogleGmailPart,
  GoogleGmailReader,
} from '@buddy/connectors';

export interface MailAttachmentLoaderOptions {
  // 添付の取得だけを使う（getMessage 等は使わない）。
  readonly gmail: Pick<GoogleGmailReader, 'getAttachment'>;
  // 接続の保存済みの取得範囲。範囲を広げる既定値は作らない（呼び出し側が保存済みの選択を渡す）。
  readonly scope: FetchScope;
  // PDF のテキスト抽出（試験で差し替える）。省略時は unpdf（pdfjs の Node 向けラッパー）。
  readonly extractPdfText?: (data: Uint8Array) => Promise<string>;
  // 保存期限の掃除のゲート（ADR 0053・0058）。省略時は通さない（試験・模擬用）。
  // 製品の配線（B10・B11 の後続）が RetentionSweeper の ready／gate／lease を渡す。
  readonly retention?: {
    readonly ready: () => Promise<void>;
    readonly gate: () => StartupGateDecision;
    // ゲートの確認から取得・抽出の終わりまでを掃除の本体と直列にする貸し出し。取れないときは null。
    readonly lease: () => (() => void) | null;
  };
}

export interface MailAttachmentLoader {
  load(request: {
    readonly messageId: string;
    // 件名・本文と同じメッセージの版。添付の source_revision に使う（根拠の対応付け、設計 11 §3）。
    readonly messageRevision: string;
    readonly payload: GoogleGmailPart;
  }): Promise<readonly MailAttachmentInput[]>;
}

// unpdf（pdfjs の Node 向けラッパー）のうち、テキスト抽出に使う最小の形。
// unpdf の配布する型は DOM の型を前提にしていて、このリポジトリの skipLibCheck: false の型検査へ
// 持ち込めない。そのため静的な import はせず、実行時にだけ読み込み、この狭い形でだけ扱う（ADR 0139）。
interface UnpdfModule {
  getDocumentProxy(data: Uint8Array): Promise<unknown>;
  extractText(
    pdf: unknown,
    options: { readonly mergePages: true },
  ): Promise<{ readonly text: string }>;
}

const UNPDF_MODULE = 'unpdf';
let unpdfPromise: Promise<UnpdfModule> | null = null;
function loadUnpdf(): Promise<UnpdfModule> {
  unpdfPromise ??= import(UNPDF_MODULE) as Promise<UnpdfModule>;
  return unpdfPromise;
}

// PDF のテキスト抽出の既定実装。ページ区切りは改行にして 1 つのテキストにまとめる。
async function defaultExtractPdfText(data: Uint8Array): Promise<string> {
  const unpdf = await loadUnpdf();
  const pdf = await unpdf.getDocumentProxy(data);
  const { text } = await unpdf.extractText(pdf, { mergePages: true });
  return text;
}

// Content-Type の値（例: text/plain; charset="shift_jis"）から charset のラベルを取り出す。無ければ null。
function charsetOf(contentType: string | null): string | null {
  if (contentType === null) return null;
  const match = /charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const label = match?.[1] ?? match?.[2];
  return label === undefined || label === '' ? null : label;
}

// パートの MIME。mimeType が空なら Content-Type ヘッダーの種類部分で補う（分類の正本は domain）。
function effectiveMimeType(part: GoogleGmailAttachmentPart): string {
  if (part.mimeType !== '') return part.mimeType;
  if (part.contentType === null) return '';
  return part.contentType.split(';')[0]?.trim() ?? '';
}

// テキスト系の復号。charset は Content-Type の宣言に従い（既定は UTF-8）、対応できないラベルや
// 不正なバイト列は失敗にする（化けたテキストを「抽出できた」としない）。先頭の BOM は落とす。
function decodeTextBytes(
  data: Uint8Array,
  contentType: string | null,
): string | null {
  const label = charsetOf(contentType) ?? 'utf-8';
  let text: string;
  try {
    text = new TextDecoder(label, { fatal: true }).decode(data);
  } catch {
    return null;
  }
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

export function createMailAttachmentLoader(
  options: MailAttachmentLoaderOptions,
): MailAttachmentLoader {
  const extractPdfText = options.extractPdfText ?? defaultExtractPdfText;

  // 許可した添付 1 件のバイト列を得る。取得できなければ null（理由は持たない。失敗は failed に写す）。
  const fetchBytes = async (
    messageId: string,
    part: GoogleGmailAttachmentPart,
  ): Promise<Uint8Array | null> => {
    let data: Uint8Array;
    if (part.inlineData !== null) {
      // format=full で一緒に届いたデータ。申告サイズと一致するものだけを使う。
      const decoded = decodeBase64Url(part.inlineData);
      if (decoded === null) return null;
      // 申告サイズがある（0 でない）場合は実物と一致するものだけを使う。
      if (
        part.sizeBytes !== null &&
        part.sizeBytes > 0 &&
        decoded.length !== part.sizeBytes
      )
        return null;
      data = decoded;
    } else if (part.attachmentId !== null) {
      let attachment: { readonly data: Uint8Array };
      try {
        attachment = await options.gmail.getAttachment({
          messageId,
          attachmentId: part.attachmentId,
        });
      } catch {
        return null;
      }
      data = attachment.data;
    } else {
      // 取得する手段（識別子もインラインのデータも無い）がない。
      return null;
    }
    // 申告サイズで検査を通っていても、実物が上限を超えていたら使わない（広げない）。
    if (data.length > options.scope.attachmentMaxBytes) return null;
    return data;
  };

  const loadAll = async (
    request: Parameters<MailAttachmentLoader['load']>[0],
    mayFetch: boolean,
  ): Promise<readonly MailAttachmentInput[]> => {
    const parts = listAttachmentParts(request.payload);
    const results: MailAttachmentInput[] = [];
    for (const [index, part] of parts.entries()) {
      const attachmentId = part.partId ?? `attachment-${index}`;
      const mimeType = effectiveMimeType(part);
      const check = checkAttachment(options.scope, {
        mimeType,
        filename: part.filename,
        sizeBytes: part.sizeBytes,
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
      if (!mayFetch) {
        // 掃除のゲートが閉じている間は取得しない。許可した添付は未読（failed）に倒す。
        results.push(failed);
        continue;
      }
      const data = await fetchBytes(request.messageId, part);
      if (data === null) {
        results.push(failed);
        continue;
      }
      const classified = classifyAttachment({
        mimeType,
        filename: part.filename,
      });
      // checkAttachment を通っているので種類は決まっている。決まらなければ失敗として扱う。
      if (classified.kind === null) {
        results.push(failed);
        continue;
      }
      if (classified.kind === 'text') {
        const text = decodeTextBytes(data, part.contentType);
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
        continue;
      }
      // PDF。テキストが取れない（画像だけ・暗号化など）ものは未読（failed）にする。
      let pdfText: string;
      try {
        pdfText = await extractPdfText(data);
      } catch {
        results.push(failed);
        continue;
      }
      if (pdfText.trim() === '') {
        results.push(failed);
        continue;
      }
      results.push({
        attachment_id: attachmentId,
        permitted: true,
        state: 'extracted',
        source_revision: request.messageRevision,
        text: pdfText,
      });
    }
    return results;
  };

  return {
    async load(request) {
      // 掃除が済むまで外部の読み取りを始めない（ADR 0053）。ゲートの確認と貸し出しの取得は同じ区間で行い、
      // 取得・抽出が終わるまで貸し出しを持つ。ゲートが閉じている・貸し出しが取れないときは取得せず、
      // 許可した添付を未読（failed）にする（読めたことにしない）。
      let release: (() => void) | null = null;
      let mayFetch = options.retention === undefined;
      if (options.retention !== undefined) {
        for (let attempt = 0; release === null && attempt < 3; attempt += 1) {
          await options.retention.ready();
          const gate = options.retention.gate();
          if (!gate.search || !gate.auto_use) break;
          release = options.retention.lease();
        }
        mayFetch = release !== null;
      }
      try {
        return await loadAll(request, mayFetch);
      } finally {
        release?.();
      }
    },
  };
}
