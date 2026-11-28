// 上の中央の島（ADR 0181 の段階 2。従来の窓）に何を出すかを決める。React と DOM に依存しない純粋な関数で、node:test で
// 試験する。色と記号は tones.ts、状態の文言は status-lines.ts・work-state.ts の対応表を使う。
//
// 島は 2 つの形を持つ。
// - 小さい形（いつも出す）: 入出力の記号と文言（ライブ領域）、中枢との接続、停止のボタン（止まっていないときだけ。1 回で効く。
//   ADR 0014・U396）。未受信・ロック中・ロック状態不明では、内容を隠した旨と停止だけにする。
// - 広がる形（本人の決定 4）: 確認が必要な操作が増えたときと、操作の結果が届いたときだけ。下の優先の順で 1 つだけ出す。
//
// 広がる形の優先の順（上ほど先）:
//   1. 内容を隠している（未受信・ロック中・ロック状態不明）なら、広げない。
//   2. 失敗の結果（承認・取消・照合・再試行・状態の確認が拒否された、結果が確認できなかった）。ISLAND_RESULT_MS の間。
//   3. 確認が必要な操作が増えた（記録しない会話の承認を待つ独立した確認を含む。ADR 0197）。ISLAND_ATTENTION_MS の間。
//      件数が減ったら畳む（減ったことは読み上げない）。
//   4. 成功・中立の結果（承認を送った、完了した、実行されなかった、取り消した）と、保存モードが変わった区切り（記録しない
//      会話を始めた・終えた、保存モードを変えた。UI-05 の段階 6、ADR 0189）。ISLAND_RESULT_MS の間。
//   5. どれもなければ小さい形のまま。
// 時間が過ぎても、本人がポインター・キーボードのフォーカスを島に置いている間は畳まない（置いた時点で広がっていたものだけ。
// WCAG 2.2.1。U395）。
//
// 読み上げ（ADR 0181・U394）: 確認が必要な操作が増えたことは polite（status）で件数だけを読む。結果は、成功・中立を status、
// 失敗を alert で読む。ただし、押した行のすぐ下に同じ結果の文言を出して読み上げている（WorkPanel の行の知らせ）ときは、
// 島では読まない（同じ文を 2 か所で読ませない）。
import type {
  DesktopConnectionView,
  DesktopOperationEntry,
  DesktopStatusBar,
  StorageMode,
} from '@buddy/contracts';
import type { StatusLine } from '../tones.js';
import { hubLine, ioLine } from './status-lines.js';
import { storageBoundary } from './storage-mode-state.js';
import type { Notice } from './work-state.js';
import { groupOperations, operationStatus, rowTitle } from './work-state.js';

// 広げておく時間（U395 の暫定の値）。結果は 6 秒、確認が必要な操作が増えたときは件数と行き先を読める 8 秒。
export const ISLAND_RESULT_MS = 6_000;
export const ISLAND_ATTENTION_MS = 8_000;

const NB = ' ';

export const ISLAND_LABELS = {
  region: '状態の島',
  ioLabel: '入出力:',
  hubLabel: '中枢:',
  openAttention: '確認が必要な操作を見る',
  checking: '状態を確かめています。',
  locked: '画面がロックされているため、内容を隠しています。',
  unknown: 'ロック状態を確かめられないため、内容を隠しています。',
} as const;

export function attentionText(count: number): string {
  return `確認が必要な操作が${count}${NB}件あります。`;
}

// 島に出す操作の結果（最後の 1 つ）。
export interface IslandResult {
  readonly line: StatusLine;
  // 失敗（警告・危険）か。失敗は alert で読み、ほかの結果より先に出す。
  readonly failure: boolean;
  // 受け取った時刻（ミリ秒）。
  readonly at: number;
  // 押した行のすぐ下でも同じ結果を出して読み上げている（島では読まない）。
  readonly announcedNearby: boolean;
}

// 島を広げるきっかけ（画面の状態の流れから作る。nextIslandMemory）。
export interface IslandSignals {
  // 確認が必要な操作の件数（承認待ち・結果不明・届いたか分からない。WorkPanel の「確認が必要な操作」と同じ数え方）。
  readonly attentionCount: number;
  // 件数が増えた時刻と、そのときの件数。件数が減ったら null（畳む）。
  readonly attentionRaisedAt: number | null;
  readonly attentionRaisedCount: number;
  readonly result: IslandResult | null;
}

export const NO_ISLAND_SIGNALS: IslandSignals = {
  attentionCount: 0,
  attentionRaisedAt: null,
  attentionRaisedCount: 0,
  result: null,
};

export type IslandLive = 'status' | 'alert' | null;

export interface IslandExpanded {
  readonly reason: 'result' | 'attention';
  readonly line: StatusLine;
  // ライブ領域の種類（null なら島では読まない）。
  readonly live: IslandLive;
  // 「確認が必要な操作を見る」（同じ画面の一覧の見出しへ移る。島から確認・承認はしない）を出すか。
  readonly openAttention: boolean;
}

export type IslandView =
  | {
      // 内容を隠す（未受信・ロック中・ロック状態不明）。隠した旨（ライブ領域）と停止だけ。
      readonly kind: 'hidden';
      readonly text: string;
      readonly icon: 'none' | 'info' | 'warning';
    }
  | {
      readonly kind: 'shown';
      readonly io: StatusLine;
      readonly hub: StatusLine;
      // 停止のボタンを出すか（止まっていないときだけ。ADR 0024 UI レビュー 2 回目 1）。
      readonly stop: boolean;
      readonly expanded: IslandExpanded | null;
    };

// その出来事が今も広がっているか。時間内か、本人が島に触れた時点で時間内だった（触れている間は畳まない）。
function stillOpen(
  at: number,
  duration: number,
  now: number,
  holdingSince: number | null,
): boolean {
  if (now - at < duration) return true;
  return (
    holdingSince !== null && holdingSince >= at && holdingSince - at < duration
  );
}

export function islandView(input: {
  readonly status: DesktopStatusBar | null;
  readonly connection: DesktopConnectionView | null;
  readonly now: number;
  readonly signals: IslandSignals | null;
  // 本人がポインター・キーボードのフォーカスを島に置いた時刻（置いていなければ null）。
  readonly holdingSince: number | null;
}): IslandView {
  const { status, now, holdingSince } = input;
  if (status === null)
    return { kind: 'hidden', text: ISLAND_LABELS.checking, icon: 'none' };
  if (status.visibility === 'hidden')
    return status.lock_state === 'locked'
      ? { kind: 'hidden', text: ISLAND_LABELS.locked, icon: 'info' }
      : { kind: 'hidden', text: ISLAND_LABELS.unknown, icon: 'warning' };
  const signals = input.signals ?? NO_ISLAND_SIGNALS;
  const result = signals.result;
  const resultOpen =
    result !== null &&
    stillOpen(result.at, ISLAND_RESULT_MS, now, holdingSince);
  const attentionOpen =
    signals.attentionRaisedAt !== null &&
    signals.attentionCount > 0 &&
    signals.attentionCount === signals.attentionRaisedCount &&
    stillOpen(
      signals.attentionRaisedAt,
      ISLAND_ATTENTION_MS,
      now,
      holdingSince,
    );
  const resultView = (r: IslandResult): IslandExpanded => ({
    reason: 'result',
    line: r.line,
    live: r.announcedNearby ? null : r.failure ? 'alert' : 'status',
    openAttention: false,
  });
  let expanded: IslandExpanded | null = null;
  if (resultOpen && result.failure) expanded = resultView(result);
  else if (attentionOpen)
    expanded = {
      reason: 'attention',
      line: {
        tone: 'warning',
        mark: 'circle',
        text: attentionText(signals.attentionCount),
      },
      live: 'status',
      openAttention: true,
    };
  else if (resultOpen) expanded = resultView(result);
  return {
    kind: 'shown',
    io: ioLine(status),
    hub: hubLine(status, input.connection, now),
    stop: status.stop_scope === 'none',
    expanded,
  };
}

// --- きっかけの作り方（画面の状態の流れから） ---

type OperationState = DesktopOperationEntry['state'];

// 結果を待っている状態（ここから下の TERMINAL へ移ったら「結果が届いた」とみなす）。
const WAITING: ReadonlySet<OperationState> = new Set([
  'awaiting_approval',
  'approved',
  'preparing',
  'dispatching',
  'reconciling',
]);
// 結果の状態。内容の更新で使われなくなった（superseded）は本人の操作の結果ではないので含めない。
const TERMINAL: ReadonlySet<OperationState> = new Set([
  'succeeded',
  'unknown_held',
  'not_executed',
  'cancelled',
]);

export interface IslandMemory {
  readonly signals: IslandSignals;
  // 前に見た操作の状態（参照 → 状態。届いたか分からない保留は状態に関わらず「待っている」とみなす）。
  readonly states: ReadonlyMap<string, OperationState | 'delivery_unknown'>;
  // 前に見た行の知らせ（同じ物なら新しい結果ではない）。
  readonly notices: Readonly<Record<string, Notice>>;
  // 前に見た保存モード（中枢の値。受け取っていなければ null。ADR 0189）。
  readonly storageMode: StorageMode | null;
}

export const EMPTY_ISLAND_MEMORY: IslandMemory = {
  signals: NO_ISLAND_SIGNALS,
  states: new Map(),
  notices: {},
  storageMode: null,
};

// 新しい結果のうち、島に出す 1 つを選ぶ。失敗を先に、同じ重さなら島で読むもの（行で読んでいない）を先にする。
function moreImportant(a: IslandResult, b: IslandResult | null): boolean {
  if (b === null) return true;
  if (a.failure !== b.failure) return a.failure;
  return !a.announcedNearby && b.announcedNearby;
}

export function nextIslandMemory(
  previous: IslandMemory,
  input: {
    // 確認が必要な操作を見せてよいか（ロック解除済み・登録済み・中枢に接続中。WorkPanel と同じ条件）。
    readonly shown: boolean;
    readonly operations: readonly DesktopOperationEntry[];
    // 行のすぐ下の知らせ（WorkPanel。参照 → 知らせ）。
    readonly notices: Readonly<Record<string, Notice>>;
    // 状態欄の保存モード（中枢の値。受け取っていなければ null。省略は null。ADR 0189）。
    readonly storageMode?: StorageMode | null;
    // 承認を待つ記録しない会話の独立した確認の数（ADR 0197。確認が必要な操作に足して数える）。省略は 0。
    readonly privateConfirmations?: number;
  },
  at: number,
): IslandMemory {
  // 見せられない間は何も覚えない（ロック・切断で捨てる。戻ったときの件数は 0 から数える）。
  if (!input.shown) return EMPTY_ISLAND_MEMORY;
  const byRef = new Map(input.operations.map((entry) => [entry.ref, entry]));
  let found: IslandResult | null = null;
  // 行の知らせ（本人が押した操作の受付・拒否）。行のすぐ下で読み上げているので、島では読まない。
  for (const [ref, notice] of Object.entries(input.notices)) {
    if (previous.notices[ref] === notice) continue;
    const entry = byRef.get(ref);
    const failure = notice.tone === 'warning';
    const candidate: IslandResult = {
      line: {
        tone: failure ? 'warning' : 'success',
        mark: failure ? 'warning' : 'dot',
        text:
          entry === undefined
            ? notice.text
            : `${rowTitle(entry)}: ${notice.text}`,
      },
      failure,
      at,
      announcedNearby: true,
    };
    if (moreImportant(candidate, found)) found = candidate;
  }
  // 結果を待っていた操作が結果の状態へ移った（承認・再試行・照合・取消の後、中枢から届く）。行では読み上げないので島で読む。
  const states = new Map<string, OperationState | 'delivery_unknown'>();
  for (const entry of input.operations) {
    const now = entry.delivery_unknown ? 'delivery_unknown' : entry.state;
    states.set(entry.ref, now);
    const before = previous.states.get(entry.ref);
    if (
      before === undefined ||
      now === 'delivery_unknown' ||
      !TERMINAL.has(now) ||
      !(before === 'delivery_unknown' || WAITING.has(before))
    )
      continue;
    const line = operationStatus(entry);
    const failure = line.tone === 'warning' || line.tone === 'danger';
    const candidate: IslandResult = {
      line: { ...line, text: `${rowTitle(entry)}: ${line.text}` },
      failure,
      at,
      announcedNearby: false,
    };
    if (moreImportant(candidate, found)) found = candidate;
  }
  // 保存モードが変わった（記録しない会話を始めた・終えた、保存モードを変えた。ADR 0189）。区切りは島で読む（切り替えの欄は
  // 押しただけで、結果を読み上げない）。受け取っていなかった値からの変化（接続・ロック解除の直後）は区切りにしない。
  const storageMode = input.storageMode ?? null;
  const boundary = storageBoundary(previous.storageMode, storageMode);
  if (boundary !== null) {
    const candidate: IslandResult = {
      line: boundary.line,
      failure: false,
      at,
      announcedNearby: false,
    };
    if (moreImportant(candidate, found)) found = candidate;
  }
  const count =
    groupOperations(input.operations).attention.length +
    (input.privateConfirmations ?? 0);
  const before = previous.signals;
  const raised =
    count > before.attentionCount
      ? { attentionRaisedAt: at, attentionRaisedCount: count }
      : count < before.attentionCount
        ? { attentionRaisedAt: null, attentionRaisedCount: 0 }
        : {
            attentionRaisedAt: before.attentionRaisedAt,
            attentionRaisedCount: before.attentionRaisedCount,
          };
  return {
    signals: {
      attentionCount: count,
      ...raised,
      result: found ?? before.result,
    },
    states,
    notices: input.notices,
    storageMode,
  };
}
