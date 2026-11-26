// 利用通知メールから家計簿の記録を作る取り込み（ADR 0160）。
//
// 同期がメールを保存した後（走査の公開の後）に、その口座の取得集合で呼ぶ。手順:
// 1. 保存層の household.mail_pending で、まだ確かめていないメールを新しい順に受け取る。口座で初めて呼ぶと、そのときに
//    あったメールは確かめ済みにされ、何も返らない（過去のメールを一度に取りに行かない）。
// 2. メールごとに見出し（metadata）を読み、差出人と、Gmail 自身が一番上に付けた認証結果で送り主を確かめる（domain の
//    checkHouseholdNoticeSender）。件名が利用の通知のときだけ本文（full）を読み、平文にして domain の readHouseholdNotice
//    で読み取る。
// 3. 読み取った利用を recordHouseholdEntry で記録する（出所の鍵＝提供元・口座・メール ID・順番。同じメールから二つ目は
//    作らない）。終わったメールは household.mail_checked で確かめ済みにする。
// 読み取りの失敗（通信・提供元の誤り）や保存の失敗のときは確かめ済みにせず、次の公開の後にやり直す。
// Outlook（Microsoft）のメールは段階 1 では読まない（Graph の読み取りに本文の取得が無い）。
// 本文・店名・金額はログに出さない。ログは件数と理由の名前だけ。

import { createHash, randomUUID } from 'node:crypto';
import {
  checkHouseholdNoticeSender,
  householdNoticeSubjectKind,
  readHouseholdNotice,
} from '@buddy/domain';
import { decodeBase64Url } from '@buddy/connectors';
import type { HouseholdNoticeIssuer, StartupGateDecision } from '@buddy/domain';
import type {
  GoogleGmailMessage,
  GoogleGmailPart,
  GoogleGmailReader,
} from '@buddy/connectors';
import type {
  ConnectionRecord,
  DataKeyMaterial,
  DbWorkerClient,
} from '@buddy/storage';
import { recordHouseholdEntry } from './household-ledger.js';
import type { HouseholdPorts } from './household-ledger.js';

// Gmail が受信の時に付ける認証結果の識別子（authserv-id）。
const GMAIL_AUTHSERV_ID = 'mx.google.com';

// --- Gmail のメールの見出しと本文 ---

function headerValues(
  part: GoogleGmailPart | undefined,
  name: string,
): string[] {
  if (part === undefined) return [];
  const lower = name.toLowerCase();
  return part.headers
    .filter((header) => header.name.toLowerCase() === lower)
    .map((header) => header.value);
}

/**
 * Gmail 自身が付けた認証結果。メールの見出しは新しいものが上に並ぶので、一番上の Authentication-Results が
 * Gmail の付けたものかを確かめ、それだけを返す（送り主が本文に入れた同名の見出しは信じない）。
 */
export function gmailAuthenticationResults(
  message: GoogleGmailMessage,
): string[] {
  const first = headerValues(message.payload, 'Authentication-Results')[0];
  if (first === undefined) return [];
  const authservId = first.split(';')[0]?.trim().toLowerCase();
  return authservId === GMAIL_AUTHSERV_ID ? [first] : [];
}

const CHARSET = /charset\s*=\s*"?([A-Za-z0-9._:-]+)"?/iu;

function decodePart(part: GoogleGmailPart): string | null {
  if (part.bodyData === undefined) return null;
  const bytes = decodeBase64Url(part.bodyData);
  if (bytes === null) return null;
  const contentType = headerValues(part, 'Content-Type')[0] ?? '';
  const label = CHARSET.exec(contentType)?.[1] ?? 'utf-8';
  try {
    const text = new TextDecoder(label, { fatal: true }).decode(bytes);
    return text.startsWith('﻿') ? text.slice(1) : text;
  } catch {
    return null;
  }
}

function findPart(
  part: GoogleGmailPart | undefined,
  mimeType: string,
): GoogleGmailPart | null {
  if (part === undefined) return null;
  // 添付（ファイル名のある部分）は本文として読まない。
  if (
    part.mimeType?.toLowerCase() === mimeType &&
    (part.filename ?? '') === '' &&
    part.bodyData !== undefined
  )
    return part;
  for (const child of part.parts) {
    const found = findPart(child, mimeType);
    if (found !== null) return found;
  }
  return null;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  yen: '¥',
};

/** HTML のメールを、行の区切りを残した文字だけにする（表の行・段落・改行は改行に、表の欄は空白に）。 */
export function householdHtmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section)\s*>/giu, '\n')
    .replace(/<\/(td|th)\s*>/giu, ' ')
    .replace(/<[^>]*>/gu, '')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (whole, name: string) => {
      if (name.startsWith('#x') || name.startsWith('#X')) {
        const code = Number.parseInt(name.slice(2), 16);
        return Number.isFinite(code) && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      if (name.startsWith('#')) {
        const code = Number.parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/[ \t\u00a0]+/gu, ' ')
    .replace(/ *\n */gu, '\n');
}

/** メールの本文の平文。text/plain があればそれを、なければ text/html を文字にしたものを返す。読めなければ null。 */
export function gmailNoticeText(message: GoogleGmailMessage): string | null {
  const plain = findPart(message.payload, 'text/plain');
  if (plain !== null) {
    const text = decodePart(plain);
    if (text !== null && text.trim() !== '') return text;
  }
  const html = findPart(message.payload, 'text/html');
  if (html === null) return null;
  const text = decodePart(html);
  return text === null ? null : householdHtmlToText(text);
}

/** 受信の時刻（ミリ秒）を、本人のタイムゾーンの日付（YYYY-MM-DD）にする。 */
export function householdLocalDate(millis: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(millis));
  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// --- 取り込み ---

export interface HouseholdMailIntakeTarget {
  readonly connection: ConnectionRecord;
  readonly account_id: string;
  readonly scope_id: string;
}

export interface HouseholdMailIntakeSummary {
  readonly outcome: 'done' | 'skipped' | 'stopped';
  // skipped・stopped の理由（provider_unsupported・reader_unavailable・key_unavailable・pending_failed・
  // read_failed・record_failed・check_failed・already_running・retention_closed・intake_off）。
  // intake_off は本人が家計簿の画面で取り込みを止めている（ADR 0163）。
  readonly reason: string | null;
  // 初回で、いまあるメールを確かめ済みにしたか。
  readonly baseline: boolean;
  // 確かめ終えたメールの数。
  readonly checked: number;
  // 新しく作った記録の数。
  readonly recorded: number;
}

export interface HouseholdMailIntakeOptions {
  readonly store: Pick<DbWorkerClient, 'household'>;
  // 接続の Gmail の読み取り。null なら読まない（トークンが無いなど）。
  readonly gmailFor: (connection: ConnectionRecord) => GoogleGmailReader | null;
  // データ鍵（使うたびに読む）。null なら取り込まない。
  readonly dataKey: () => Promise<DataKeyMaterial | null>;
  // 本人のタイムゾーン（IANA）。
  readonly timeZone: () => string;
  readonly now?: () => Date;
  readonly newId?: () => string;
  // 一度に確かめるメールの上限。
  readonly limit?: number;
  // 送信元の一覧。省略時は domain の組み込みの一覧（本人が足す手段は U324 で決める）。
  readonly issuers?: readonly HouseholdNoticeIssuer[];
  readonly log?: (message: string) => void;
  // 保存期限の掃除のゲート（ADR 0053・0058）。省略時は通さない（試験用）。
  // 製品では core.ts が RetentionSweeper の ready／gate／lease を渡す。
  readonly retention?: {
    readonly ready: () => Promise<void>;
    readonly gate: () => StartupGateDecision;
    // ゲートの確認から記録の終わりまでを掃除の本体と直列にする貸し出し。取れないときは null。
    readonly lease: () => (() => void) | null;
  };
}

export interface HouseholdMailIntake {
  run(target: HouseholdMailIntakeTarget): Promise<HouseholdMailIntakeSummary>;
}

const DEFAULT_LIMIT = 50;

const summary = (
  outcome: HouseholdMailIntakeSummary['outcome'],
  reason: string | null,
  counts: { baseline: boolean; checked: number; recorded: number },
): HouseholdMailIntakeSummary => ({ outcome, reason, ...counts });

export function createHouseholdMailIntake(
  options: HouseholdMailIntakeOptions,
): HouseholdMailIntake {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  const limit = options.limit ?? DEFAULT_LIMIT;
  const log = options.log ?? (() => undefined);
  const running = new Set<string>();

  async function runOnce(
    target: HouseholdMailIntakeTarget,
  ): Promise<HouseholdMailIntakeSummary> {
    const counts = { baseline: false, checked: 0, recorded: 0 };
    const { connection } = target;
    if (connection.provider !== 'google')
      return summary('skipped', 'provider_unsupported', counts);
    const gmail = options.gmailFor(connection);
    if (gmail === null) return summary('skipped', 'reader_unavailable', counts);
    const dataKey = await options.dataKey();
    if (dataKey === null) return summary('skipped', 'key_unavailable', counts);
    const ports: HouseholdPorts = {
      client: options.store,
      dataKey,
      sha256Hex: (material) =>
        createHash('sha256').update(material, 'utf8').digest('hex'),
      newId,
      now: () => now().toISOString(),
    };
    const listed = await options.store.household({
      kind: 'household.mail_pending',
      provider: 'google',
      account_id: target.account_id,
      scope_id: target.scope_id,
      limit,
      now: now().toISOString(),
    });
    if (!listed.ok) return summary('stopped', 'pending_failed', counts);
    // 本人が止めている（同じ transaction で設定を読んだ結果。基準も作っていない）。
    if (listed.value.paused) return summary('skipped', 'intake_off', counts);
    counts.baseline = listed.value.baseline;
    const markChecked = async (remoteId: string): Promise<boolean> => {
      const marked = await options.store.household({
        kind: 'household.mail_checked',
        provider: 'google',
        account_id: target.account_id,
        remote_id: remoteId,
        now: now().toISOString(),
      });
      if (!marked.ok) return false;
      counts.checked += 1;
      return true;
    };
    for (const remoteId of listed.value.remote_ids) {
      let head: GoogleGmailMessage;
      try {
        head = await gmail.getMessage({ id: remoteId, format: 'metadata' });
      } catch {
        return summary('stopped', 'read_failed', counts);
      }
      const sender = checkHouseholdNoticeSender(
        {
          from: headerValues(head.payload, 'From')[0] ?? '',
          authentication_results: gmailAuthenticationResults(head),
        },
        options.issuers,
      );
      const subject = headerValues(head.payload, 'Subject')[0] ?? '';
      if (
        !sender.ok ||
        householdNoticeSubjectKind(sender.issuer, subject) !== 'usage'
      ) {
        if (!(await markChecked(remoteId)))
          return summary('stopped', 'check_failed', counts);
        continue;
      }
      let full: GoogleGmailMessage;
      try {
        full = await gmail.getMessage({ id: remoteId, format: 'full' });
      } catch {
        return summary('stopped', 'read_failed', counts);
      }
      const text = gmailNoticeText(full);
      const receivedMillis = Number(full.internalDate ?? head.internalDate);
      const receivedOn = householdLocalDate(
        Number.isFinite(receivedMillis) ? receivedMillis : now().getTime(),
        options.timeZone(),
      );
      const reading =
        text === null
          ? null
          : readHouseholdNotice({
              issuer: sender.issuer,
              subject,
              text,
              received_on: receivedOn,
            });
      if (reading?.outcome === 'entries') {
        for (const entry of reading.entries) {
          const recorded = await recordHouseholdEntry(
            ports,
            {
              kind: 'mail_notice',
              provider: 'google',
              account_id: target.account_id,
              remote_id: remoteId,
              index: entry.index,
            },
            entry.content,
          );
          if (recorded.outcome === 'created') counts.recorded += 1;
          else if (recorded.outcome !== 'duplicate') {
            // 中身の誤り（拒否）はやり直しても変わらないので確かめ済みにする。保存の不明・停止はやり直す。
            if (
              recorded.outcome === 'unknown' ||
              recorded.reasons.some(
                (reason) =>
                  reason === 'worker_halted' ||
                  reason === 'database_busy' ||
                  reason.startsWith('worker_'),
              )
            )
              return summary('stopped', 'record_failed', counts);
            log(
              `家計簿の利用通知の記録を作れませんでした（${recorded.reasons.join(', ')}）。`,
            );
          }
        }
        if (reading.skipped.length > 0)
          log(
            `家計簿の利用通知のうち ${String(reading.skipped.length)} 件を記録しませんでした（${[
              ...new Set(reading.skipped.map((skip) => skip.reason)),
            ].join(', ')}）。`,
          );
      }
      if (!(await markChecked(remoteId)))
        return summary('stopped', 'check_failed', counts);
    }
    return summary('done', null, counts);
  }

  return {
    async run(target) {
      const key = `${target.connection.connection_id}\0${target.account_id}`;
      if (running.has(key))
        return summary('skipped', 'already_running', {
          baseline: false,
          checked: 0,
          recorded: 0,
        });
      running.add(key);
      // 掃除が済むまでメールを読まない（ADR 0053）。ゲートの確認と貸し出しの取得は同じ区間で行い、
      // 読み取り・記録が終わるまで貸し出しを持つ。取れないときは読まず、次の公開の後に読む。
      let release: (() => void) | null = null;
      try {
        if (options.retention !== undefined) {
          for (let attempt = 0; release === null && attempt < 3; attempt += 1) {
            await options.retention.ready();
            const gate = options.retention.gate();
            if (!gate.search || !gate.auto_use) break;
            release = options.retention.lease();
          }
          if (release === null)
            return summary('skipped', 'retention_closed', {
              baseline: false,
              checked: 0,
              recorded: 0,
            });
        }
        return await runOnce(target);
      } finally {
        release?.();
        running.delete(key);
      }
    },
  };
}
