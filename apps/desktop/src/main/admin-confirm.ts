// 承認・拒否・失効の前の OS の確認ダイアログの文言（本人の判断 2026-10-22、ADR 0026）。Electron に依存しない純粋な関数で、
// 値は main が中枢から受け取った一覧の値だけを使う。端末名・OS は申請者の自己申告なので、制御文字・書字方向の制御文字を
// 取り除き、長さを切る。確認コードの見比べを求める文を必ず入れる。
import {
  budgetOrdinalLabel,
  budgetOriginLabel,
  budgetPoolLabel,
  formatMoney,
} from '@buddy/domain';
import type { BudgetConfirmRequest } from './budget-bridge.js';
import type { AdminConfirmRequest, HomeConfirmRequest } from './core-link.js';
import type { OperationConfirmRequest } from './operation-bridge.js';

const PLATFORMS: Readonly<Record<string, string>> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
};

// 制御文字（C0・DEL・C1）、ゼロ幅・書字方向の制御文字を除き、空白をまとめる。
// 表示から除く文字か（C0・DEL・C1 の制御文字、ゼロ幅・行区切り・書字方向の制御文字、BOM）。
function hidden(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  );
}

export function displayText(value: string, max = 60): string {
  const cleaned = [...value]
    .map((char) => (hidden(char.codePointAt(0) ?? 0) ? ' ' : char))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  const chars = [...cleaned];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : cleaned;
}

const clock = (utc: string): string => {
  const date = new Date(utc);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export interface AdminConfirmText {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  // 0 番は「やめる」（既定・取り消し）、1 番が確定。
  readonly buttons: readonly [string, string];
}

// 自宅の登録・登録し直しの確認（B03-08）。出すのは伏せた値（MAC は最後の 2 組、SSID は先頭の 1 文字と文字数）
// だけ。何と見比べるかと、Wi-Fi 名を確かめるかどうか、置き換えて元に戻せないことを書く。
export function homeConfirmText(request: HomeConfirmRequest): AdminConfirmText {
  // 数字と単位の間・「MAC アドレス」の間は改行しない空白（U+00A0。画面の文言と同じ。UI レビュー M6）。
  const nb = '\u00a0';
  const macAddress = `MAC${nb}アドレス`;
  const mask = '·';
  const mac = `${mask.repeat(2)}:${mask.repeat(2)}:${mask.repeat(2)}:${mask.repeat(2)}:${displayText(request.macTail, 5)}`;
  const ssid =
    request.includeSsid && request.ssidHint !== null
      ? `確かめる（${request.ssidHint.first === null ? '' : displayText(request.ssidHint.first, 1)}${mask.repeat(request.ssidHint.length - (request.ssidHint.first === null ? 0 : 1))}・${request.ssidHint.length}${nb}文字）`
      : '確かめない（Wi-Fi 名は送りません）';
  const lines = [
    `ルーターの ${macAddress}（最後の${nb}2${nb}組）: ${mac}`,
    `ルーターのラベルや管理画面の ${macAddress}の、最後の${nb}2${nb}組と同じかを確かめてください。`,
    `サブネット: ${displayText(request.subnet, 18)}`,
    'ルーターの管理画面の、LAN 側のアドレスの範囲です。',
    `Wi-Fi 名（SSID）: ${ssid}`,
    ...(request.includeSsid
      ? []
      : [
          `Wi-Fi 名は確かめず、ルーターの ${macAddress}・サブネット・Tailscale の直接経路で判定します。`,
        ]),
    '',
    '登録すると、ほかのマシンの端末は、このネットワークにつながっていて Tailscale で直接つながっているときだけ中枢に接続できます。',
  ];
  if (request.ssidChange === 'removed')
    lines.push('登録し直すと、Wi-Fi 名は確かめなくなります。');
  if (request.ssidChange === 'added')
    lines.push(
      '登録し直すと、Wi-Fi 名も確かめるようになります（Wi-Fi 名の違う端末は接続できなくなります）。',
    );
  if (request.replacing)
    lines.push(
      '今の登録は置き換わり、元に戻せません。前のネットワークにいる端末は接続できなくなります。',
    );
  return {
    title: request.replacing ? '自宅の登録し直し' : '自宅の登録',
    message: request.replacing
      ? '自宅の登録を今のネットワークで置き換えますか'
      : 'このネットワークを自宅として登録しますか',
    detail: lines.join('\n'),
    buttons: ['やめる', request.replacing ? '登録し直す' : '登録する'],
  };
}

const OPERATION_TITLES: Readonly<Record<string, string>> = {
  'mail.labels.change': 'メールのラベルの変更',
  'mail.draft.create': '返信の下書きの作成',
  'task.create': '用事の登録',
};

const SERVICE_NAMES: Readonly<Record<string, string>> = {
  mock: '模擬のメール',
  gmail: 'Gmail',
  microsoft_graph: 'Microsoft のメール',
  buddy: 'Buddy の用事',
};

const FIELD_NAMES: Readonly<Record<string, string>> = {
  labels_add: '付けるラベル',
  labels_remove: '外すラベル',
  draft_to: '宛先',
  draft_cc: 'Cc',
  draft_subject: '件名',
  draft_body: '本文',
  task_title: '題名',
  task_due: '期限',
  task_body: 'メモ',
};

const STATE_NAMES: Readonly<Record<string, string>> = {
  awaiting_approval: '承認待ち',
  approved: '承認済み（実行を待っています）',
  preparing: '実行を準備しています',
  dispatching: '実行しています',
  reconciling: '結果を確認しています',
  succeeded: '完了',
  unknown_held: '結果を確認できていません',
  not_executed: '実行されませんでした',
  cancelled: '取り消し済み',
  superseded: '内容が更新されたため使われません',
};

// 変更の承認・取消・再試行の確認（B04-05、D2 と、取消・再試行への適用）。値は main が中枢から読んだもので、画面から
// 受け取らない。受け取った文字列は制御文字・書字方向の制御文字を除き、長さを切って出す（本文は先頭だけ）。
export function operationConfirmText(
  request: OperationConfirmRequest,
): AdminConfirmText {
  const title = OPERATION_TITLES[request.operationKind] ?? '変更';
  if (request.action !== 'approve_operation') {
    const cancel = request.action === 'cancel_operation';
    const lines = [`操作: ${title}`];
    if (request.headline !== null)
      lines.push(`内容: ${displayText(request.headline, 80)}`);
    if (request.detail !== null)
      lines.push(`補足: ${displayText(request.detail, 100)}`);
    lines.push(
      `今の状態: ${STATE_NAMES[request.state] ?? displayText(request.state, 30)}`,
      '',
      cancel
        ? '取り消せるのは、実行の前だけです。実行に進んでいる場合は、取り消さずに結果の確認へ回ります。'
        : '同じ内容・同じ承認で、もう一度実行します。実行されなかったと確かめた操作だけに使えます。',
    );
    return {
      title: cancel ? '操作の取消' : '操作の再試行',
      message: cancel
        ? `「${title}」を取り消しますか`
        : `「${title}」をもう一度実行しますか`,
      detail: lines.join('\n'),
      buttons: ['やめる', cancel ? '取り消す' : '再試行する'],
    };
  }
  const lines = [
    `変更先: ${SERVICE_NAMES[request.service] ?? displayText(request.service, 20)}`,
  ];
  if (request.accountLabel !== null)
    lines.push(`アカウント: ${displayText(request.accountLabel, 60)}`);
  const mail = request.targetDetail;
  if (mail !== null) {
    if (mail.subject !== null)
      lines.push(`対象の件名: ${displayText(mail.subject, 80)}`);
    if (mail.sender !== null)
      lines.push(`差出人: ${displayText(mail.sender, 60)}`);
    if (mail.received_at !== null)
      lines.push(`受信: ${displayText(mail.received_at, 40)}`);
  } else if (request.target !== null) {
    lines.push(`対象: ${displayText(request.target, 60)}`);
  }
  for (const field of request.fields) {
    const max = field.field === 'draft_body' ? 200 : 80;
    lines.push(
      `${FIELD_NAMES[field.field] ?? displayText(field.field, 20)}: ${field.values.map((value) => displayText(value, max)).join('、')}`,
    );
  }
  lines.push(
    '',
    request.operationKind === 'task.create'
      ? '承認すると、Buddy の用事に登録します。'
      : '承認すると、中枢がこの内容で実行します。メールを送ることはありません。',
    '取り消せるのは、実行の前だけです。',
  );
  return {
    title: '変更の承認',
    message: `「${title}」を承認しますか`,
    detail: lines.join('\n'),
    buttons: ['やめる', '承認する'],
  };
}

// 予算の確認（B07-05、ADR 0039）の確認。値は main が中枢の利用状況から読んだもので、手での精算の実費・照合 ID だけは本人が
// 入力した値。金額は本人の設定に基づく実行時の値（個人の金額なので、試験・撮影には合成の XTS だけを使う）。
export function budgetConfirmText(
  request: BudgetConfirmRequest,
): AdminConfirmText {
  // 枠の内部の ID は出さず、用途の名前で言う。対象を見分けられるよう、発生した日時・用途・モデルの名前も出す
  // （中枢が記録していない値は出さない）。
  const pool = `枠: ${budgetPoolLabel(request.poolId)}（${displayText(request.budgetMonth, 7)}）`;
  const identity: (string | null)[] = [
    request.occurredAt === null ? null : `発生: ${clock(request.occurredAt)}`,
    // 表示が重なる項目の順番（一覧・読み上げと同じ言い方）。
    request.ordinal === null
      ? null
      : budgetOrdinalLabel(request.ordinal.position, request.ordinal.of),
    request.origin === null
      ? null
      : `用途: ${budgetOriginLabel(request.origin)}`,
    request.profileId === null
      ? null
      : `モデル: ${displayText(request.profileId, 60)}`,
  ];
  const detail = (lines: readonly (string | null)[]): string =>
    lines.filter((line): line is string => line !== null).join('\n');
  const actual =
    request.actualGross === null ? null : formatMoney(request.actualGross);
  switch (request.action) {
    case 'approve_overage':
      return {
        title: '超過枠の承認',
        message: `この依頼の最大負担 ${formatMoney(request.maxLiability)} を、超過枠から使うことを承認しますか`,
        detail: detail([
          pool,
          ...identity,
          `最大負担 M: ${formatMoney(request.maxLiability)}`,
          request.overageRemaining === null
            ? null
            : `超過枠の残り: ${formatMoney(request.overageRemaining)}`,
          request.expiresAt === null
            ? null
            : `承認の期限: ${clock(request.expiresAt)}`,
          '',
          '承認は、この依頼と最大負担だけに使います。別の依頼や、より大きな負担には使えません。',
        ]),
        buttons: ['やめる', '承認する'],
      };
    case 'review_overrun':
      return {
        title: 'M 超過の確認',
        message: '最大負担を超えた実費を確認しましたか',
        detail: detail([
          pool,
          ...identity,
          actual === null ? null : `記録した実費: ${actual}`,
          `最大負担 M: ${formatMoney(request.maxLiability)}`,
          request.actualGross === null
            ? null
            : `超過: ${formatMoney({
                currency: request.actualGross.currency,
                amount: (
                  BigInt(request.actualGross.amount) -
                  BigInt(request.maxLiability.amount)
                ).toString(),
              })}`,
          '',
          '確認すると、この枠と下位の枠の新しい受付が再開します。実費と計上先は変わりません。',
        ]),
        buttons: ['やめる', '確認した'],
      };
    case 'settle_manual':
      return {
        title: '不明な費用の精算',
        message: `不明な費用を ${actual ?? ''} で精算しますか`,
        detail: detail([
          pool,
          ...identity,
          `保持している最大負担 M: ${formatMoney(request.maxLiability)}`,
          actual === null ? null : `入力した実費: ${actual}`,
          request.reconciliationId === null
            ? null
            : `照合 ID: ${displayText(request.reconciliationId, 70)}`,
          '',
          '精算は一度だけで、元の月・元の枠に計上します。請求の照合で確かめた値だけを入力してください。',
        ]),
        buttons: ['やめる', '精算する'],
      };
  }
}

export function adminConfirmText(
  request: AdminConfirmRequest,
): AdminConfirmText {
  if (request.action === 'register_home') return homeConfirmText(request);
  if ('operationKind' in request) return operationConfirmText(request);
  if ('poolId' in request) return budgetConfirmText(request);
  const name = displayText(request.deviceName) || '（名前なし）';
  const platform =
    PLATFORMS[request.platform] ?? displayText(request.platform, 20);
  const at = clock(request.at);
  const check =
    request.claimCheck === null
      ? null
      : displayText(request.claimCheck, 8).replace(/^(.{4})(.{4})$/u, '$1 $2');
  switch (request.action) {
    case 'approve':
      return {
        title: '申請の承認',
        message: `「${name}」（${platform}・${at} の申請）を承認しますか`,
        detail: `確認コード: ${check ?? '-'}\n\n申請した端末の画面の確認コードと、8 桁すべて同じときだけ承認してください。承認すると、その端末はこの中枢に接続できるようになります。`,
        buttons: ['やめる', '承認する'],
      };
    case 'reject':
      return {
        title: '申請の拒否',
        message: `「${name}」（${platform}・${at} の申請）を拒否しますか`,
        detail: `確認コード: ${check ?? '-'}\n\n拒否した申請は使えなくなります。登録するには、端末側でペアリングを最初からやり直します。`,
        buttons: ['やめる', '拒否する'],
      };
    case 'revoke':
      return {
        title: '端末の失効',
        message: `「${name}」（${platform}・${at} の登録）を失効しますか`,
        detail:
          '失効すると、その端末はすぐに切断され、元に戻せません。もう一度使うには、端末側で登録し直します。他の端末には影響しません。',
        buttons: ['やめる', '失効する'],
      };
  }
}
