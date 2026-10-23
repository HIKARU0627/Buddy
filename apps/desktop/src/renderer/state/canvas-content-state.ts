// キャンバスの物の中身（本文）の持ち方と、部品の描き方を決める純粋な関数（UI-07、ADR 0032）。React と DOM に依存せず、
// node:test で試験する。
// - 中身は画面のメモリーだけに置く（保存しない・イベントに入れない）。ロック・停止・切断・世代の変化（記述を捨てた）・物が
//   閉じられた・物のデータが変わったときに捨てる。物のデータ（部品・参照・more_count）が同じなら、版が進んでも持ち続ける
//   （動かす・大きさを変えるだけでは取り直さない）。取れなかった中身は、次の版が届いたときに 1 度だけ取り直す。
// - メールの本文は開いた 1 通だけを持つ（別の 1 通を開くか閉じると捨てる）。
// - 部品の描き方（幅の種類・箱に入る行数・見える列数・時間の列の割り当て・グラフの目盛り・時刻の書き方）もここに置く。
//   位置と大きさは配置のエンジン（UI-06）が決め、部品はその箱の大きさだけを見る。
import type { CanvasContent, DesktopCanvasView } from '@buddy/contracts';
import type { CanvasViewItem } from './canvas-state.js';

export type MailBody = {
  readonly index: number;
  readonly body: string;
};

export interface ItemContent {
  readonly status: 'loading' | 'ready' | 'failed';
  // 取った中身（status が ready のときだけ）。
  readonly content: CanvasContent | null;
  // 取ったときの物のデータの印（signature）。変わったら捨てる。
  readonly signature: string;
  // 取り始めた・失敗した版（失敗した版と同じ間は取り直さない）。
  readonly revision: string;
  // 開いているメールの本文（1 通だけ）。開く途中の行は opening。
  readonly opened: MailBody | null;
  readonly opening: number | null;
}

export interface ContentStore {
  // 捨てるたびに進める。古い世代に始めた取得の応答は反映しない。
  readonly epoch: number;
  readonly items: Readonly<Record<string, ItemContent>>;
}

export const EMPTY_STORE: ContentStore = { epoch: 0, items: {} };

// 物のデータの印。部品・参照（不透明な参照の並び）・more_count が同じなら同じ中身。
export function itemSignature(item: CanvasViewItem): string {
  return JSON.stringify([
    item.component,
    item.data.item_refs.map((entry) => entry.ref),
    item.data.more_count,
  ]);
}

export interface ContentRequest {
  readonly item_id: string;
  readonly signature: string;
  readonly revision: string;
  readonly epoch: number;
}

// 記述が変わった（または描く条件が変わった）。見える物の中身を整える: 物がない・データが変わった中身は捨て、取っていない物と
// （前の版で）取れなかった物の取得を返す。enabled が false（ロック中・停止中・記述なし）なら、すべて捨てる。
export function syncContents(
  store: ContentStore,
  view: DesktopCanvasView | null,
  enabled: boolean,
): { readonly store: ContentStore; readonly requests: ContentRequest[] } {
  if (!enabled || view === null) {
    // すでに空なら何も変えない（進行中の取得は、取った物の項目が残っていないので反映されない）。
    if (Object.keys(store.items).length === 0) return { store, requests: [] };
    return {
      store: { epoch: store.epoch + 1, items: {} },
      requests: [],
    };
  }
  const items: Record<string, ItemContent> = {};
  const requests: ContentRequest[] = [];
  let changed = false;
  for (const item of view.items) {
    if (item.placement !== 'canvas') continue;
    const signature = itemSignature(item);
    const previous = store.items[item.item_id];
    if (previous !== undefined && previous.signature === signature) {
      // 失敗した中身は、新しい版が届いたとき 1 度だけ取り直す。
      if (
        previous.status === 'failed' &&
        previous.revision !== view.canvas_revision
      ) {
        items[item.item_id] = {
          ...previous,
          status: 'loading',
          revision: view.canvas_revision,
        };
        requests.push({
          item_id: item.item_id,
          signature,
          revision: view.canvas_revision,
          epoch: store.epoch,
        });
        changed = true;
      } else items[item.item_id] = previous;
      continue;
    }
    items[item.item_id] = {
      status: 'loading',
      content: null,
      signature,
      revision: view.canvas_revision,
      opened: null,
      opening: null,
    };
    requests.push({
      item_id: item.item_id,
      signature,
      revision: view.canvas_revision,
      epoch: store.epoch,
    });
    changed = true;
  }
  if (Object.keys(items).length !== Object.keys(store.items).length)
    changed = true;
  return {
    store: changed ? { epoch: store.epoch, items } : store,
    requests,
  };
}

// 取れた中身を置く。取り始めたときの世代・データの印と同じときだけ（それ以外は捨てる）。
export function contentArrived(
  store: ContentStore,
  request: ContentRequest,
  content: CanvasContent,
): ContentStore {
  const current = store.items[request.item_id];
  if (
    store.epoch !== request.epoch ||
    current === undefined ||
    current.signature !== request.signature ||
    current.status !== 'loading'
  )
    return store;
  return {
    ...store,
    items: {
      ...store.items,
      [request.item_id]: { ...current, status: 'ready', content },
    },
  };
}

// 取れなかった。同じ条件のときだけ失敗にする。
export function contentFailed(
  store: ContentStore,
  request: ContentRequest,
): ContentStore {
  const current = store.items[request.item_id];
  if (
    store.epoch !== request.epoch ||
    current === undefined ||
    current.signature !== request.signature ||
    current.status !== 'loading'
  )
    return store;
  return {
    ...store,
    items: {
      ...store.items,
      [request.item_id]: { ...current, status: 'failed', content: null },
    },
  };
}

// メールを開き始める（開いている別の 1 通の本文は、この時点で捨てる）。
export function mailOpening(
  store: ContentStore,
  itemId: string,
  index: number,
): ContentStore {
  const current = store.items[itemId];
  if (current === undefined || current.status !== 'ready') return store;
  return {
    ...store,
    items: {
      ...store.items,
      [itemId]: { ...current, opened: null, opening: index },
    },
  };
}

// メールの本文が取れた。開く途中の行と同じときだけ置く。
export function mailOpened(
  store: ContentStore,
  itemId: string,
  signature: string,
  epoch: number,
  mail: MailBody | null,
): ContentStore {
  const current = store.items[itemId];
  if (
    store.epoch !== epoch ||
    current === undefined ||
    current.signature !== signature ||
    current.opening === null ||
    (mail !== null && mail.index !== current.opening)
  )
    return store;
  return {
    ...store,
    items: {
      ...store.items,
      [itemId]: { ...current, opened: mail, opening: null },
    },
  };
}

// メールを閉じる（本文を捨てる）。
export function mailClosed(store: ContentStore, itemId: string): ContentStore {
  const current = store.items[itemId];
  if (
    current === undefined ||
    (current.opened === null && current.opening === null)
  )
    return store;
  return {
    ...store,
    items: {
      ...store.items,
      [itemId]: { ...current, opened: null, opening: null },
    },
  };
}

// --- 部品の描き方 ---

// 幅の種類。160（最小）〜239 は narrow、240〜479 は medium、480 以上は wide。
export type WidthClass = 'narrow' | 'medium' | 'wide';
export const NARROW_BELOW = 240;
export const WIDE_FROM = 480;

export function widthClassOf(width: number): WidthClass {
  if (width < NARROW_BELOW) return 'narrow';
  return width < WIDE_FROM ? 'medium' : 'wide';
}

// カードの箱（配置のエンジンの矩形）から、本文を描ける大きさを求める。Card の余白（上下左右 16・縁 1）・見出しの帯
// （1 行 32）・帯と本文の間（12）の分を引く。狭い箱で見出しの下に道具の行を置くとき（tools）は、その行（28）も引く。
export const CARD_PADDING = 16;
const CARD_BORDER = 1;
const HEADER = 32;
const HEADER_GAP = 12;
const TOOLS_ROW = 28;

export function bodySizeOf(
  box: { readonly width: number; readonly height: number },
  options: { readonly stackedTools: boolean },
): { readonly width: number; readonly height: number } {
  const width = box.width - 2 * (CARD_PADDING + CARD_BORDER);
  const height =
    box.height -
    2 * (CARD_PADDING + CARD_BORDER) -
    HEADER -
    HEADER_GAP -
    (options.stackedTools ? TOOLS_ROW : 0);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

// 行が並ぶ部品で、高さに入る行の数（少なくとも 1 行）。pitch は 1 行の高さ＋間。
export function rowCapacity(
  height: number,
  pitch: number,
  gap: number,
): number {
  return Math.max(1, Math.floor((height + gap) / pitch));
}

// 件数の札（「+数」。高さ 24）とその上の間（8）の分。
export const MORE_RESERVE = 32;

// 入りきらない行があるとき（または別の隠れた物があるとき）は、件数の札の分の高さを空けて、行の数を決める。全部入るなら札は
// 出さないので、空けない。total は行の総数、otherHidden は行以外の隠れた物（more_count・入らない列）があるか。
export function rowsThatFit(
  total: number,
  height: number,
  pitch: number,
  gap: number,
  otherHidden: boolean,
): number {
  const full = rowCapacity(height, pitch, gap);
  if (total <= full && !otherHidden) return full;
  return rowCapacity(height - MORE_RESERVE, pitch, gap);
}

// 横に並ぶ列で、幅に入る列の数（少なくとも min、多くても total）。
export function columnCapacity(
  width: number,
  minWidth: number,
  total: number,
  min = 1,
): number {
  return Math.min(total, Math.max(min, Math.floor(width / minWidth)));
}

// 部品の行の高さの目安（ピクセル）。部品の見た目と同じ値（試験で確かめる）。
export const ROW = {
  list: { pitch: 32, narrowPitch: 52, gap: 4 },
  table: { header: 32, row: 32 },
  mail: { pitch: 60, wideExtra: 24, gap: 4 },
  source: { pitch: 48, gap: 4 },
  progress: { pitch: 44, gap: 8 },
  compare: { header: 32, row: 32, narrowRow: 52 },
  textLine: 24,
} as const;

// 件数の札（「+数」）の読み上げの文言。数と単位の間は折り返さない空白。
const NBSP = String.fromCharCode(0xa0);
export const moreLabel = (count: number): string =>
  `ほか${NBSP}${count}${NBSP}件`;
export const moreColumnsLabel = (count: number): string =>
  `ほか${NBSP}${count}${NBSP}列`;

// --- 時間の軸（schedule_timeline） ---

export interface TimelineEvent {
  readonly start_minute: number;
  readonly end_minute: number;
}

export interface LaneSlot {
  // 0 から数える列。重なる予定は別の列に置く。
  readonly lane: number;
  // その予定を含む重なりの塊の列の数（塊の中で同じ幅に分ける。重ならない予定は 1）。
  readonly lanes: number;
  // 別の予定と重なっている。
  readonly overlaps: boolean;
}

// 重なる予定に列を割り当てる。開始の早い順（同じなら元の順）に、空いている最も左の列へ置く。重なりの塊（つながって
// 重なる予定の集まり）ごとに列の数を決め、重ならない予定は全幅。同じ入力から同じ結果を出す（乱数を使わない）。
export function assignLanes(events: readonly TimelineEvent[]): LaneSlot[] {
  return assignLanesWithin(events, Number.POSITIVE_INFINITY).map(
    (slot) => slot ?? { lane: 0, lanes: 1, overlaps: false },
  );
}

// 列の数に上限（読める列の幅から決める）があるときの割り当て。上限の列がすべて埋まっていて置けない予定は null（描かず、
// 省いた件数の札に数える）。置けた予定だけで、重なりの塊・列の数を決める。
export function assignLanesWithin(
  events: readonly TimelineEvent[],
  maxLanes: number,
): (LaneSlot | null)[] {
  const order = events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        a.event.start_minute - b.event.start_minute ||
        a.event.end_minute - b.event.end_minute ||
        a.index - b.index,
    );
  const slots: ({ lane: number; cluster: number } | null)[] = new Array(
    events.length,
  ).fill(null);
  const clusterLanes: number[] = [];
  const clusterSize: number[] = [];
  let laneEnds: number[] = [];
  let cluster = -1;
  let clusterEnd = -1;
  for (const { event, index } of order) {
    const startsCluster = cluster < 0 || event.start_minute >= clusterEnd;
    let lane = startsCluster
      ? -1
      : laneEnds.findIndex((end) => end <= event.start_minute);
    if (lane < 0) {
      // 新しい列が要る。上限に達していれば、この予定は置かない（塊の状態は変えない）。
      if (!startsCluster && laneEnds.length >= maxLanes) continue;
      if (startsCluster) {
        cluster += 1;
        clusterEnd = event.end_minute;
        laneEnds = [];
        clusterLanes[cluster] = 0;
        clusterSize[cluster] = 0;
      }
      lane = laneEnds.length;
      laneEnds.push(event.end_minute);
    } else laneEnds[lane] = event.end_minute;
    clusterEnd = Math.max(clusterEnd, event.end_minute);
    clusterLanes[cluster] = Math.max(clusterLanes[cluster] ?? 0, lane + 1);
    clusterSize[cluster] = (clusterSize[cluster] ?? 0) + 1;
    slots[index] = { lane, cluster };
  }
  return slots.map((slot) =>
    slot === null
      ? null
      : {
          lane: slot.lane,
          lanes: clusterLanes[slot.cluster] ?? 1,
          overlaps: (clusterSize[slot.cluster] ?? 1) > 1,
        },
  );
}

// 時間の軸の目盛り（時）。高さに合わせて、目盛りの間が 28 ピクセル以上になる最も細かい間隔（1・2・3・4・6 時間）。
export function hourTicks(
  startMinute: number,
  endMinute: number,
  height: number,
): number[] {
  const hours = (endMinute - startMinute) / 60;
  const perHour = hours > 0 ? height / hours : height;
  const step = [1, 2, 3, 4, 6].find((value) => value * perHour >= 28) ?? 6;
  const first = Math.ceil(startMinute / 60);
  const ticks: number[] = [];
  for (let hour = first; hour * 60 <= endMinute; hour += 1)
    if ((hour - first) % step === 0) ticks.push(hour);
  return ticks;
}

// --- グラフ ---

export interface Scale {
  readonly min: number;
  readonly max: number;
  readonly ticks: number[];
}

// 目盛り: 棒を含むときは 0 から。きりのよい刻み（1・2・5 × 10 の冪）で、最大値を含む。
export function niceScale(
  values: readonly number[],
  options: { readonly includeZero: boolean; readonly maxTicks: number },
): Scale {
  const finite = values.filter((value) => Number.isFinite(value));
  let low = Math.min(...finite);
  let high = Math.max(...finite);
  if (finite.length === 0) {
    low = 0;
    high = 1;
  }
  if (options.includeZero) {
    low = Math.min(low, 0);
    high = Math.max(high, 0);
  }
  if (high === low) high = low + 1;
  const rough = (high - low) / Math.max(1, options.maxTicks - 1);
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  const step =
    (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
  const min = Math.floor(low / step) * step;
  const max = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  const count = Math.round((max - min) / step);
  for (let index = 0; index <= count; index += 1)
    ticks.push(Number((min + index * step).toPrecision(12)));
  return { min, max, ticks };
}

// グラフの数の書き方（小数は 2 桁まで。千の位は区切らない）。
export function chartNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}

// --- 時刻・URL ---

// メールの受信・用事の期限の書き方（端末の地域時間。今日は時刻だけ、それ以外は月日つき）。
export function clockLabel(utc: string, now: number): string {
  const date = new Date(utc);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const today = new Date(now);
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

// 0 時からの分を「9:00」の形にする。
export function minuteLabel(minute: number): string {
  return `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}`;
}

// 出典の URL を、リンクにしてよいか確かめる（https だけ。ユーザー名・パスワードを含まない）。main の externalOpenTarget と
// 同じ規則（main も開くときにもう一度確かめる）。ホスト名（表示用）と、解析した URL を返す。リンクにできなければ null。
export function httpsLink(
  url: string,
): { readonly href: string; readonly host: string } | null {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.hostname === ''
    )
      return null;
    return { href: parsed.toString(), host: parsed.hostname };
  } catch {
    return null;
  }
}
