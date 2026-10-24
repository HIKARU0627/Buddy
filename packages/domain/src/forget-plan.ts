// 忘却の計画（設計 03 忘却と再取り込み、08 §6、ADR 0008・0040・0044、B06-03）。
// 対象の解決・派生の閉包・台帳のエントリの組み立てを、DB・鍵・時計に触れない純粋な関数で決める。
// 行を読む・消す・台帳へ書くのは Core の同じ transaction（B06-06・B06-07）。この計画はその入力と期待値になる。
//
// 守ること:
// - 検索語は受け取らない。Core が RAM で検索語を当てた結果（一致した対象の参照）だけを受け、計画・確定内容・台帳・知らせに文字列を残さない（U41）。
// - 元情報の ID は台帳へ HMAC だけを書く。HMAC は注入された関数で求め、domain は鍵を持たない（ADR 0040）。
// - 進行中の承認・結果不明の操作は消さず、状態も変えない（08 §6）。計画に操作の取消・失効・再送の項目はない。
// - 由来を引けない派生物は、閉じた側（同じ元の発言・元情報を除外）に倒す（03 の保守的な扱い）。

import type { LedgerSource, MemorySource, SourceHmac } from './memory.js';
import { OPERATION_TRANSITIONS, type OperationState } from './operations.js';

// ---- 種類 ----

export type ForgetRootKind = MemorySource['source_kind'];

// 派生物（記憶以外）の種類。系譜（derivations。ADR 0040 の案）の artifact_kind と同じ名前。
export const FORGET_ARTIFACT_KINDS = [
  // 会話の要約（sessions.summary_blob_id）。
  'session_summary',
  // 流れの区切りにつないだ要約（ADR 0032 の CarriedSummary。永続のものを含む）。
  'carried_summary',
  // 気づきの題・抄録（notification_candidates）。
  'notification_candidate',
  // 依頼の抽出結果（request_entities）。
  'request_entity',
  // 関連解析（related_analyses）。
  'related_analysis',
  // 永続のキャンバスの物（CanvasItem.data.item_refs が由来を指す）。
  'canvas_item',
  // 影モードの比較記録（intent_shadow）。
  'intent_shadow',
  // memory の操作（memory_save・memory_correct・memory_forget）の確定内容（暗号文）。操作の記録そのものは消さない。
  'operation_content',
  // 非同期処理の参照の記録（async_context_guards.source_refs）。
  'async_guard',
] as const;

export type ForgetArtifactKind = (typeof FORGET_ARTIFACT_KINDS)[number];

// 範囲（session）は、由来を引けない派生物が属する会話を表すときだけ使う。
export type ForgetNodeKind = ForgetRootKind | ForgetArtifactKind | 'session';

export interface ForgetNode {
  readonly kind: ForgetNodeKind;
  readonly id: string;
}

const ROOT_KINDS: readonly string[] = ['turn', 'source_item', 'memory'];
const ARTIFACT_KINDS: readonly string[] = FORGET_ARTIFACT_KINDS;

// 物理削除の順序（参照する側から先に消す）。FK の最終の順序は B06-06。
export const FORGET_DELETE_ORDER: readonly ForgetNodeKind[] = [
  'intent_shadow',
  'canvas_item',
  'notification_candidate',
  'related_analysis',
  'request_entity',
  'async_guard',
  'carried_summary',
  'session_summary',
  'memory',
  'turn',
  'source_item',
];

// ---- 対象の解決（聞き返し） ----

export type ForgetRequest =
  // 本人が選んだ対象（記憶の ID など）。
  | { readonly by: 'id'; readonly ref: MemorySource }
  // 検索語を RAM で当てた結果。検索語そのものは受け取らない（U41）。
  | { readonly by: 'query'; readonly matches: readonly MemorySource[] };

export type ForgetResolution =
  | { readonly outcome: 'resolved'; readonly target: MemorySource }
  | {
      readonly outcome: 'ask_back';
      readonly reason: 'no_match' | 'multiple_matches' | 'target_not_found';
      // 画面に出す候補（参照だけ。本文は表示の権限の範囲で Core が付ける）。
      readonly candidates: readonly MemorySource[];
    };

const sameRef = (a: MemorySource, b: MemorySource): boolean =>
  a.source_kind === b.source_kind && a.source_id === b.source_id;

function distinct(refs: readonly MemorySource[]): MemorySource[] {
  const out: MemorySource[] = [];
  for (const ref of refs)
    if (!out.some((seen) => sameRef(seen, ref)))
      out.push({ source_kind: ref.source_kind, source_id: ref.source_id });
  return out;
}

// 忘却の対象を決める。不明（0 件）・複数は確定せずに聞き返す。確定するのは、今ある行の中でちょうど 1 件に決まるときだけ。
// known は Core が DB から読んだ、今ある（削除されていない）対象の参照。
export function resolveForgetTarget(
  request: ForgetRequest,
  known: readonly MemorySource[],
): ForgetResolution {
  const exists = (ref: MemorySource): boolean =>
    known.some((item) => sameRef(item, ref));
  if (request.by === 'id')
    return exists(request.ref)
      ? {
          outcome: 'resolved',
          target: {
            source_kind: request.ref.source_kind,
            source_id: request.ref.source_id,
          },
        }
      : { outcome: 'ask_back', reason: 'target_not_found', candidates: [] };
  const matches = distinct(request.matches.filter(exists));
  if (matches.length === 0)
    return { outcome: 'ask_back', reason: 'no_match', candidates: [] };
  if (matches.length > 1)
    return {
      outcome: 'ask_back',
      reason: 'multiple_matches',
      candidates: matches,
    };
  return { outcome: 'resolved', target: matches[0] as MemorySource };
}

// 確定する操作（memory_forget）の内容。解決した対象の種類と ID だけ。検索語・本文・候補の文は入れない（U41）。
export interface ForgetOperationContent {
  readonly targets: readonly MemorySource[];
}

export function forgetOperationContent(
  target: MemorySource,
): ForgetOperationContent {
  return {
    targets: [{ source_kind: target.source_kind, source_id: target.source_id }],
  };
}

// ---- 派生の閉包 ----

export interface DerivationEdge {
  // 派生物（記憶を含む）と、その由来。Core が派生物を作る transaction で必ず書いた系譜の 1 行。
  readonly artifact: ForgetNode;
  readonly source: ForgetNode;
}

export interface UnattributedArtifact {
  // 由来を引けない派生物（系譜が書かれていない・旧い）。属する範囲（会話・元情報・発言）だけが分かる。
  readonly artifact: ForgetNode;
  readonly scope: ForgetNode;
}

export interface ForgetGraph {
  readonly edges: readonly DerivationEdge[];
  readonly unattributed: readonly UnattributedArtifact[];
  // 発言がどの会話に属するか（範囲の展開に使う）。
  readonly turn_sessions: readonly {
    readonly turn_id: string;
    readonly session_id: string;
  }[];
  // 今ある記憶と、台帳の blocked_content_keys に残す内容の HMAC（memories.dedupe_key）。
  readonly memories: readonly {
    readonly memory_id: string;
    readonly dedupe_key: string;
  }[];
  // 確定内容を持つ memory の操作の状態（OperationState の文字列）。
  readonly operations: readonly {
    readonly operation_id: string;
    readonly state: string;
  }[];
}

export interface ForgetPlanInput {
  // 解決済みの対象。resolveForgetTarget の結果だけを渡す。
  readonly target: MemorySource;
  // 「〇〇を忘れて」という発言（検索語・対象の言葉を含む）。忘却と同じ transaction で消す（司令塔の判断）。
  readonly instruction_turn_id: string | null;
  // この忘却を今まさに適用している memory_forget の操作。同じ transaction で完了するので、確定内容は消してよい。
  readonly executing_operation_id: string | null;
  readonly graph: ForgetGraph;
  readonly sourceHmac: SourceHmac;
}

export interface NoticeItemDraft {
  readonly item_kind: 'turn' | 'source_item' | 'memory' | 'carried_summary';
  readonly item_id: string;
}

export interface OperationContentPlan {
  // 確定内容（暗号文）を今消してよい操作。hash・レシートは残す（J5）。
  readonly purge: readonly string[];
  // 進行中・結果不明の操作。何も変えない（承認・試行・状態・内容のどれも）。終わってから J5 の削除に任せる。
  // send_blocked は常に true。確定内容に忘れた内容が含まれ得るので、Core はこの操作に「送出禁止」の印（本文を持たない）を付け、
  // 送出の直前の検査（dispatch_intent・LocalCommand の適用）で拒否する。承認・試行・状態は変えない。
  // provenance は、その操作の確定内容の由来（発言・記憶の ID と元情報の HMAC。本文なし）。async_guard を消しても、
  // 送出の検査（commandGuard の options.forgetting）はこの由来で台帳と照合できる。
  readonly retained: readonly {
    readonly operation_id: string;
    readonly state: string;
    readonly reason: 'in_flight' | 'state_unknown';
    readonly send_blocked: true;
    readonly provenance: readonly LedgerSource[];
    // 由来が 1 件でも辿れたか。false（空）なら「完全」とは扱わず、送出の検査へ provenance: 'unknown' を渡す。
    readonly provenance_complete: boolean;
  }[];
}

export interface PlannedLedger {
  readonly forgotten: readonly LedgerSource[];
  readonly blocked_source_hmacs: readonly string[];
  readonly blocked_content_keys: readonly string[];
}

export interface ForgetPlan {
  // 本人が選んだ対象と、忘却の指示の発言。
  readonly targets: readonly ForgetNode[];
  // 物理削除する行（記憶・派生物・対象の発言・対象の元情報の本文）。FORGET_DELETE_ORDER の順。操作の記録は入らない。
  readonly deletions: readonly ForgetNode[];
  readonly operation_contents: OperationContentPlan;
  readonly ledger: PlannedLedger;
  // 知らせ（RetentionNotice の forgotten と derived_from_forgotten）。本文・検索語を持たない。
  readonly notice: {
    readonly forgotten: readonly NoticeItemDraft[];
    readonly derived_from_forgotten: readonly NoticeItemDraft[];
  };
}

export type ForgetPlanResult =
  | { readonly ok: true; readonly plan: ForgetPlan }
  | { readonly ok: false; readonly reasons: readonly string[] };

const SHA256_HEX = /^[0-9a-f]{64}$/u;

const nodeKey = (node: ForgetNode): string => `${node.kind}\u0000${node.id}`;

// 操作の確定内容を今消してよい状態。遷移の先がない終端だけ（取消済み・成功・置換済み）を明示して列挙する。
// 送出境界の前後・結果不明・未実行（再試行できる）は、確定内容がまだ要るので消さない。
// 知らない文字列（toString など継承された名前を含む）は終端と見なさない。
const PURGEABLE_OPERATION_STATES: ReadonlySet<string> = new Set([
  'succeeded',
  'cancelled',
  'superseded',
]);

export function operationContentPurgeable(state: string): boolean {
  return PURGEABLE_OPERATION_STATES.has(state);
}

// 操作の状態として知っている名前か（継承された名前は含めない）。
function knownOperationState(state: string): state is OperationState {
  return Object.hasOwn(OPERATION_TRANSITIONS, state);
}

export function planForget(input: ForgetPlanInput): ForgetPlanResult {
  const { graph } = input;
  const reasons: string[] = [];
  // 知らない種類の派生物は、見落とすより計画を作らない（閉じた側）。
  // 派生した発言（忘却の指示への Buddy の返答など）は turn のまま派生物になれる。
  const artifactOk = (node: ForgetNode): boolean =>
    node.kind === 'memory' ||
    node.kind === 'turn' ||
    ARTIFACT_KINDS.includes(node.kind);
  const sourceOk = (node: ForgetNode): boolean =>
    ROOT_KINDS.includes(node.kind) || ARTIFACT_KINDS.includes(node.kind);
  for (const edge of graph.edges) {
    if (!artifactOk(edge.artifact)) reasons.push('unknown_artifact_kind');
    if (!sourceOk(edge.source)) reasons.push('unknown_source_kind');
  }
  for (const item of graph.unattributed)
    if (
      !artifactOk(item.artifact) ||
      item.artifact.kind === 'memory' ||
      !(item.scope.kind === 'session' || ROOT_KINDS.includes(item.scope.kind))
    )
      reasons.push('unattributed_invalid');
  const memoryKeys = new Map(
    graph.memories.map((memory) => [memory.memory_id, memory.dedupe_key]),
  );
  if (
    input.target.source_kind === 'memory' &&
    !memoryKeys.has(input.target.source_id)
  )
    reasons.push('target_memory_unknown');
  for (const memory of graph.memories)
    if (!SHA256_HEX.test(memory.dedupe_key))
      reasons.push('dedupe_key_malformed');
  if (reasons.length > 0) return { ok: false, reasons: [...new Set(reasons)] };

  // doomed: 消す物すべて。core: 忘れる対象から確かに作られた物（対象・指示の発言・下流）。
  // 残りの doomed は広げた物（除外する由来を共有するだけで、忘れる内容を含むかを証明できない派生物）。
  const doomed = new Map<string, ForgetNode>();
  const core = new Set<string>();
  const origins = new Map<string, ForgetNode>();
  const targets: ForgetNode[] = [
    { kind: input.target.source_kind, id: input.target.source_id },
  ];
  if (input.instruction_turn_id !== null)
    targets.push({ kind: 'turn', id: input.instruction_turn_id });
  for (const node of targets) {
    doomed.set(nodeKey(node), node);
    core.add(nodeKey(node));
  }

  const sessionTurns = (sessionId: string): ForgetNode[] =>
    graph.turn_sessions
      .filter((row) => row.session_id === sessionId)
      .map((row) => ({ kind: 'turn' as const, id: row.turn_id }));
  const scopeMembers = (scope: ForgetNode): ForgetNode[] =>
    scope.kind === 'session' ? sessionTurns(scope.id) : [scope];

  // 閉包は固定点まで繰り返す（派生物の派生物、広げた由来からの派生、範囲の展開が互いに影響する）。
  let changed = true;
  while (changed) {
    changed = false;
    // A. 忘れる物から作られた派生物は、種類によらず忘れる。core から作られた物は core、
    //    広げた物から作られた物は広げた物（core に昇格できるのは、後で core から届いたときだけ）。
    for (const edge of graph.edges) {
      const key = nodeKey(edge.artifact);
      const fromCore = core.has(nodeKey(edge.source));
      if (fromCore && !core.has(key)) {
        doomed.set(key, edge.artifact);
        core.add(key);
        changed = true;
      } else if (
        !fromCore &&
        doomed.has(nodeKey(edge.source)) &&
        !doomed.has(key)
      ) {
        doomed.set(key, edge.artifact);
        changed = true;
      }
    }
    // B. 忘れる記憶（core）の元の発言・元情報は、再登録を禁じる由来にする（消さない）。
    //    別の記憶が由来のときは広げない。広げた記憶の由来は、さらに広げない。
    for (const edge of graph.edges)
      if (
        edge.artifact.kind === 'memory' &&
        core.has(nodeKey(edge.artifact)) &&
        (edge.source.kind === 'turn' || edge.source.kind === 'source_item') &&
        !doomed.has(nodeKey(edge.source)) &&
        !origins.has(nodeKey(edge.source))
      ) {
        origins.set(nodeKey(edge.source), edge.source);
        changed = true;
      }
    // C. 除外する由来を共有する派生物は、忘れる内容を含まないと証明できないので、種類によらず消す
    //    （要約・気づき・依頼・関連解析・キャンバス・影モード・操作の確定内容・別の記憶）。部分ごとの由来が
    //    記録できるようになるまでの閉じた側（ADR 0044 U59）。
    for (const edge of graph.edges)
      if (
        origins.has(nodeKey(edge.source)) &&
        !doomed.has(nodeKey(edge.artifact))
      ) {
        doomed.set(nodeKey(edge.artifact), edge.artifact);
        changed = true;
      }
    // D. 由来を引けない派生物。範囲が忘れる物（core）に触れるなら消し、範囲全体（同じ会話・同じ元情報）を除外する。
    //    範囲が除外する由来に触れるだけなら、種類によらず消す。
    for (const item of graph.unattributed) {
      if (doomed.has(nodeKey(item.artifact))) continue;
      const members = scopeMembers(item.scope);
      if (members.some((member) => core.has(nodeKey(member)))) {
        doomed.set(nodeKey(item.artifact), item.artifact);
        core.add(nodeKey(item.artifact));
        for (const member of members)
          if (!doomed.has(nodeKey(member)) && !origins.has(nodeKey(member)))
            origins.set(nodeKey(member), member);
        changed = true;
      } else if (
        members.some(
          (member) =>
            origins.has(nodeKey(member)) || doomed.has(nodeKey(member)),
        )
      ) {
        // 除外する由来、または広げて消す物に属する派生物。消す（操作の確定内容は後で状態に応じて扱う）。
        // core には上げず、範囲の由来をさらに除外へ広げない（連鎖して消えるのを防ぐ境界）。
        doomed.set(nodeKey(item.artifact), item.artifact);
        changed = true;
      }
    }
  }

  // 後から忘れる物に加わった由来は、台帳の forgotten が覆うので、除外の一覧から外す。
  for (const key of origins.keys()) if (doomed.has(key)) origins.delete(key);

  // 台帳。元情報は HMAC だけ。HMAC が 64 桁の 16 進でなければ（生の ID を返す関数など）台帳に書かない。
  const hmac = (node: ForgetNode): string =>
    input.sourceHmac({
      source_kind: node.kind as ForgetRootKind,
      source_id: node.id,
    });
  const forgotten: LedgerSource[] = [];
  const hmacProblems: string[] = [];
  const checkHmac = (value: string): string => {
    if (!SHA256_HEX.test(value)) hmacProblems.push('source_hmac_malformed');
    return value;
  };
  const doomedList = [...doomed.values()];
  for (const node of doomedList) {
    if (node.kind === 'turn' || node.kind === 'memory')
      forgotten.push({ source_kind: node.kind, source_id: node.id });
    else if (node.kind === 'source_item')
      forgotten.push({
        source_kind: 'source_item',
        source_id_hmac: checkHmac(hmac(node)),
      });
  }
  const blockedSources = [...origins.values()].map((node) =>
    checkHmac(hmac(node)),
  );
  if (hmacProblems.length > 0)
    return { ok: false, reasons: [...new Set(hmacProblems)] };
  const blockedContent = doomedList
    .filter((node) => node.kind === 'memory')
    .map((node) => memoryKeys.get(node.id))
    .filter((key): key is string => key !== undefined);

  // 物理削除（操作の確定内容は別に扱う）。
  const deletions = doomedList
    .filter((node) => node.kind !== 'operation_content')
    .sort(
      (a, b) =>
        FORGET_DELETE_ORDER.indexOf(a.kind) -
          FORGET_DELETE_ORDER.indexOf(b.kind) || compare(a.id, b.id),
    );

  // 操作の確定内容。進行中・結果不明は触れない。
  const states = new Map(
    graph.operations.map((operation) => [
      operation.operation_id,
      operation.state,
    ]),
  );
  const purge: string[] = [];
  const retained: {
    operation_id: string;
    state: string;
    reason: 'in_flight' | 'state_unknown';
    send_blocked: true;
    provenance: LedgerSource[];
    provenance_complete: boolean;
  }[] = [];
  // 残す操作の確定内容の由来（本文なし）。間接の由来（確定内容 ← 要約 ← 記憶 ← 元情報）も辿る。
  // 由来を引けない派生物は、属する範囲の構成要素から辿る。元情報は HMAC に通す。
  const provenanceOf = (operationId: string): LedgerSource[] => {
    const out = new Map<string, LedgerSource>();
    const seen = new Set<string>();
    const queue: ForgetNode[] = [
      { kind: 'operation_content', id: operationId },
    ];
    while (queue.length > 0) {
      const current = queue.shift() as ForgetNode;
      const key = nodeKey(current);
      if (seen.has(key)) continue;
      seen.add(key);
      if (current.kind === 'source_item')
        out.set(key, {
          source_kind: 'source_item',
          source_id_hmac: checkHmac(hmac(current)),
        });
      else if (current.kind === 'turn' || current.kind === 'memory')
        out.set(key, { source_kind: current.kind, source_id: current.id });
      for (const edge of graph.edges)
        if (nodeKey(edge.artifact) === key) queue.push(edge.source);
      for (const item of graph.unattributed)
        if (nodeKey(item.artifact) === key)
          queue.push(...scopeMembers(item.scope));
    }
    return [...out.values()].sort(compareLedgerSource);
  };
  // 由来が 1 件も辿れない操作は、由来が完全とは言えない（Core は送出の検査に provenance: 'unknown' を渡す）。
  const provenanceFor = (
    operationId: string,
  ): { provenance: LedgerSource[]; provenance_complete: boolean } => {
    const provenance = provenanceOf(operationId);
    return { provenance, provenance_complete: provenance.length > 0 };
  };
  for (const node of doomedList.filter((n) => n.kind === 'operation_content')) {
    const state = states.get(node.id);
    if (input.executing_operation_id === node.id) purge.push(node.id);
    else if (state !== undefined && operationContentPurgeable(state))
      purge.push(node.id);
    else {
      const known = state !== undefined && knownOperationState(state);
      retained.push({
        operation_id: node.id,
        state: known ? state : 'unknown',
        reason: known ? 'in_flight' : 'state_unknown',
        send_blocked: true,
        ...provenanceFor(node.id),
      });
    }
  }
  if (hmacProblems.length > 0)
    return { ok: false, reasons: [...new Set(hmacProblems)] };
  purge.sort(compare);
  retained.sort((a, b) => compare(a.operation_id, b.operation_id));

  // 知らせ。本人が選んだ対象と指示の発言は forgotten、そこから作られて消えた物は derived_from_forgotten。
  const targetKeys = new Set(targets.map(nodeKey));
  const toNotice = (node: ForgetNode): NoticeItemDraft | null =>
    node.kind === 'turn' ||
    node.kind === 'source_item' ||
    node.kind === 'memory' ||
    node.kind === 'carried_summary'
      ? { item_kind: node.kind, item_id: node.id }
      : null;
  const noticeFor = (wantTarget: boolean): NoticeItemDraft[] =>
    doomedList
      .filter((node) => targetKeys.has(nodeKey(node)) === wantTarget)
      .map(toNotice)
      .filter((item): item is NoticeItemDraft => item !== null)
      .sort(
        (a, b) =>
          compare(a.item_kind, b.item_kind) || compare(a.item_id, b.item_id),
      );

  return {
    ok: true,
    plan: {
      targets,
      deletions,
      operation_contents: { purge, retained },
      ledger: {
        forgotten: forgotten.sort(compareLedgerSource),
        blocked_source_hmacs: [...new Set(blockedSources)].sort(compare),
        blocked_content_keys: [...new Set(blockedContent)].sort(compare),
      },
      notice: {
        forgotten: noticeFor(true),
        derived_from_forgotten: noticeFor(false),
      },
    },
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function ledgerSourceId(item: LedgerSource): string {
  return item.source_kind === 'source_item'
    ? item.source_id_hmac
    : item.source_id;
}

function compareLedgerSource(a: LedgerSource, b: LedgerSource): number {
  return (
    compare(a.source_kind, b.source_kind) ||
    compare(ledgerSourceId(a), ledgerSourceId(b))
  );
}

// 知らせの 1 件の上限（RetentionNotice.items の maxItems）。超えるときは複数の知らせに分ける。
export const RETENTION_NOTICE_ITEM_LIMIT = 256;

export function chunkNoticeItems(
  items: readonly NoticeItemDraft[],
): NoticeItemDraft[][] {
  const out: NoticeItemDraft[][] = [];
  for (
    let index = 0;
    index < items.length;
    index += RETENTION_NOTICE_ITEM_LIMIT
  )
    out.push(items.slice(index, index + RETENTION_NOTICE_ITEM_LIMIT));
  return out;
}

// ---- 台帳のエントリの組み立て ----

export interface ForgetLedgerEntryDraft {
  readonly schema: 'buddy.forget-ledger.v1';
  readonly entry_id: string;
  readonly forgetting_generation: string;
  readonly recorded_at: string;
  readonly forgotten: readonly LedgerSource[];
  readonly blocked_source_hmacs: readonly string[];
  readonly blocked_content_keys: readonly string[];
}

export interface LedgerEntryMeta {
  readonly entry_id: string;
  // 台帳の最新の世代（なければ "0"）。新しい世代はこの次で、1 件ごとに 1 つだけ進む。
  readonly previous_generation: string;
  readonly recorded_at: string;
}

const DECIMAL = /^(0|[1-9][0-9]*)$/u;

export type LedgerEntryResult =
  | { readonly ok: true; readonly entry: ForgetLedgerEntryDraft }
  | { readonly ok: false; readonly reasons: readonly string[] };

// 計画の台帳の部分から、台帳の 1 件（contracts の ForgetLedgerEntry）を組み立てる。
// 入力は解決済みの対象から作った計画と HMAC だけで、文字列を直接受ける口はない（ADR 0040）。
// 契約の検査（64 桁の 16 進・重複なし・忘れた対象が 1 件以上）を、書く前に必ず確かめる。
export function buildLedgerEntry(
  ledger: PlannedLedger,
  meta: LedgerEntryMeta,
): LedgerEntryResult {
  const reasons: string[] = [];
  if (!DECIMAL.test(meta.previous_generation))
    reasons.push('previous_generation_invalid');
  if (meta.entry_id.length === 0) reasons.push('entry_id_empty');
  if (ledger.forgotten.length === 0) reasons.push('forgotten_empty');
  const hmacs = [
    ...ledger.blocked_source_hmacs,
    ...ledger.blocked_content_keys,
    ...ledger.forgotten.flatMap((item) =>
      item.source_kind === 'source_item' ? [item.source_id_hmac] : [],
    ),
  ];
  if (hmacs.some((value) => !SHA256_HEX.test(value)))
    reasons.push('hmac_malformed');
  const forgottenKeys = ledger.forgotten.map(
    (item) => `${item.source_kind}\u0000${ledgerSourceId(item)}`,
  );
  if (new Set(forgottenKeys).size !== forgottenKeys.length)
    reasons.push('duplicate_forgotten');
  if (
    new Set(ledger.blocked_source_hmacs).size !==
    ledger.blocked_source_hmacs.length
  )
    reasons.push('duplicate_blocked_source');
  if (
    new Set(ledger.blocked_content_keys).size !==
    ledger.blocked_content_keys.length
  )
    reasons.push('duplicate_blocked_content');
  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    entry: {
      schema: 'buddy.forget-ledger.v1',
      entry_id: meta.entry_id,
      forgetting_generation: String(BigInt(meta.previous_generation) + 1n),
      recorded_at: meta.recorded_at,
      forgotten: ledger.forgotten,
      blocked_source_hmacs: ledger.blocked_source_hmacs,
      blocked_content_keys: ledger.blocked_content_keys,
    },
  };
}
