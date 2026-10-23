// キャンバスの物の中身の模擬の読み取り（UI-07、ADR 0032）。実データ（予定・メール・出典・記憶）の取得は B08・B09・B11 で
// 作るので、今は物の部品と参照の件数から決まる合成のデータを返す。決まった入力からは決まった結果を返す（乱数・時刻を
// 使わない）。実在の人名・メール・URL・予定を含まない（example.com などの予約済みのドメインだけ）。
// 本文（メール）は open_index の 1 通だけ。中枢の識別子を中身に含めない（行は item_refs と同じ順・同じ件数の位置で結び付く）。
import type { CanvasContent, CanvasItem } from '@buddy/contracts';

const LIST_TITLES = [
  '歯医者の予約を入れる',
  '書類を郵送する',
  '電球を買う',
  '週のメモを整える',
  '図書館の本を返す',
  '燃えるごみを出す',
  '友人の誕生日の準備',
  '月末の支払いを確かめる',
] as const;
const LIST_STATES = ['open', 'open', 'attention', 'done'] as const;

const TABLE_COLUMNS = ['項目', '場所', '期限', '状態'] as const;
const TABLE_PLACES = [
  '自宅',
  '駅前',
  '図書館',
  '郵便局',
  'オンライン',
] as const;
const TABLE_STATES = ['未了', '調整中', '済み'] as const;

const EVENT_TITLES = [
  '朝の確認',
  '打ち合わせ',
  '資料づくり',
  '昼の散歩',
  '買い物',
  '電話の予約',
  '読書の時間',
  '夕方の整理',
] as const;

const MAIL_FROMS = [
  '山田 花子',
  '佐藤 太郎',
  '町の図書館',
  '宅配の通知',
  '学校の連絡',
] as const;
const MAIL_SUBJECTS = [
  '来週の予定について',
  '荷物をお届けします',
  '貸出期限のお知らせ',
  '資料の確認のお願い',
  '日程のご相談',
] as const;
const MAIL_LABELS = [
  ['連絡'],
  ['荷物', '通知'],
  ['期限'],
  ['仕事', '確認'],
  ['連絡', '日程'],
] as const;
const MAIL_BODY = [
  'お世話になっております。',
  '来週の予定について、いくつか候補を挙げます。',
  '火曜日の午後、または木曜日の午前でしたら調整できます。',
  'ご都合のよい時間を教えてください。',
] as const;

const COMPARE_ROWS = [
  ['場所', '駅から近い', '駅から遠い', '駅から近い'],
  ['時間', '午前', '午後', '午前'],
  ['費用', '安い', '高い', '普通'],
  ['人数', '4 人', '4 人', '2 人'],
] as const;

const PROGRESS_STEPS = [
  ['書類を集める', 4, 5],
  ['申し込みを出す', 1, 2],
  ['支払いを済ませる', 0, 1],
] as const;

const CHART_LABELS = ['月', '火', '水', '木', '金', '土', '日'] as const;

const SOURCE_SITES = [
  ['公共の案内ページ', 'www.example.com', '/guide/overview'],
  ['利用規約の説明', 'docs.example.org', '/terms'],
  ['よくある質問', 'support.example.net', '/faq?topic=schedule'],
] as const;

const TEXT_BODY =
  '今日の予定は 3 件です。午前に打ち合わせがあり、午後は資料づくりに時間を取れます。\n夕方に買い物の予定があるので、早めに切り上げると楽です。';

// 基準の時刻（2026-10-24 00:00 UTC）。期限・受信の時刻はここからの差で決める。
const BASE_MS = Date.UTC(2026, 9, 24, 0, 0, 0);
const iso = (offsetMinutes: number): string =>
  new Date(BASE_MS + offsetMinutes * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/u, 'Z');

const pick = <T>(pool: readonly T[], index: number): T =>
  pool[index % pool.length] as T;

// 物の部品と参照の件数から、模擬の中身を作る。openIndex は本文を開く行（mail_card だけ。範囲外は呼び出し側が拒否する）。
export function mockCanvasContent(
  item: Pick<CanvasItem, 'component' | 'data'>,
  openIndex: number | null,
): CanvasContent {
  // 生成型は上限つきの配列を長さごとの組の和にするので、動的に作った配列は型を合わせるために断定する。形は、返す前に Schema と
  // domain の検査（postCanvasContent）が確かめる。
  return build(item, openIndex) as unknown as CanvasContent;
}

function build(
  item: Pick<CanvasItem, 'component' | 'data'>,
  openIndex: number | null,
): Record<string, unknown> {
  const count = item.data.item_refs.length;
  const indexes = Array.from({ length: count }, (_, index) => index);
  switch (item.component) {
    case 'list':
      return {
        component: 'list',
        rows: indexes.map((index) => ({
          title: pick(LIST_TITLES, index),
          due_at: index % 5 === 4 ? null : iso(60 + index * 150),
          state: pick(LIST_STATES, index),
        })),
      };
    case 'table':
      return {
        component: 'table',
        columns: [...TABLE_COLUMNS],
        rows: indexes.map((index) => ({
          cells: [
            pick(LIST_TITLES, index),
            pick(TABLE_PLACES, index),
            `${10 + (index % 20)} 日`,
            pick(TABLE_STATES, index),
          ],
        })),
      };
    case 'schedule_timeline':
      return {
        component: 'schedule_timeline',
        day_start_minute: 480,
        day_end_minute: 1200,
        events: indexes.map((index) => {
          const start = 480 + ((index * 40) % 600);
          return {
            title: pick(EVENT_TITLES, index),
            start_minute: start,
            end_minute: start + 60,
          };
        }),
      };
    case 'mail_card':
      return {
        component: 'mail_card',
        mails: indexes.map((index) => ({
          from: pick(MAIL_FROMS, index),
          subject: pick(MAIL_SUBJECTS, index),
          received_at: iso(30 + index * 37),
          labels: [...pick(MAIL_LABELS, index)],
          body: index === openIndex ? MAIL_BODY.join('\n') : null,
        })),
      };
    case 'compare':
      return {
        component: 'compare',
        columns: ['案 A', '案 B', '案 C'],
        rows: COMPARE_ROWS.map(([label, ...values]) => ({
          label,
          values: [...values],
        })),
      };
    case 'progress':
      return {
        component: 'progress',
        steps: PROGRESS_STEPS.map(([label, done, total]) => ({
          label,
          done,
          total,
        })),
      };
    case 'chart':
      return {
        component: 'chart',
        x_labels: [...CHART_LABELS],
        series: [
          { label: '今週', mark: 'bar', values: [3, 5, 2, 6, 4, 1, 2] },
          { label: '目標', mark: 'line', values: [4, 4, 4, 4, 4, 4, 4] },
        ],
      };
    case 'source_list':
      return {
        component: 'source_list',
        sources: indexes.map((index) => {
          const [title, host, path] = pick(SOURCE_SITES, index);
          return { title, url: `https://${host}${path}` };
        }),
      };
    case 'text':
      return { component: 'text', text: TEXT_BODY };
  }
}
