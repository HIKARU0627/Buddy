// 記憶の保存・忘却・期限の規則（設計 03 忘却と再取り込み・保存期限・バックアップ、08 §6、11 §7、ADR 0008）。
// 時刻は UTC の RFC 3339 文字列で受ける。台帳・記憶の行は Core が DB から読んで渡す。

const DAY_MS = 86_400_000;
export const MEMORY_REVIEW_DAYS = 90;
export const MEMORY_DELETE_AFTER_REVIEW_DAYS = 30;
export const MEMORY_EXTRACTION_MIN_EXCHANGES = 4;

export interface MemorySource {
  readonly source_kind: 'turn' | 'source_item' | 'memory';
  readonly source_id: string;
}

export interface ForgetEntry {
  readonly forgetting_generation: string;
  readonly forgotten: readonly MemorySource[];
  readonly blocked_source_ids: readonly string[];
  readonly blocked_content_keys: readonly string[];
}

export interface MemoryCandidateInput {
  readonly origin: 'auto_extraction' | 'explicit_request';
  readonly kind: string;
  readonly target_key: string;
  readonly sources: readonly MemorySource[];
  readonly dedupe_key: string;
  readonly forgetting_generation: string;
  readonly permission_revision: string;
}

export interface StoredMemory {
  readonly memory_id: string;
  readonly kind: string;
  readonly target_key: string;
  readonly dedupe_key: string;
  readonly status: 'active' | 'review_pending' | 'deleted';
}

export interface MemoryAdmissionContext {
  readonly privateConversation: boolean;
  readonly allowedKinds: readonly string[];
  readonly currentForgettingGeneration: string;
  readonly currentPermissionRevision: string;
  // 処理開始時の世代以降を含む、Core が保持する台帳の全件。
  readonly ledger: readonly ForgetEntry[];
  readonly expiredSourceIds: readonly string[];
  readonly existing: readonly StoredMemory[];
}

export interface MemoryAdmission {
  readonly action: 'save' | 'review' | 'duplicate' | 'reject';
  readonly reasons: string[];
  readonly conflictingMemoryIds: string[];
}

const sameSource = (a: MemorySource, b: MemorySource): boolean =>
  a.source_kind === b.source_kind && a.source_id === b.source_id;

// 保存直前の検査（08 §6）。遅れて返った結果も、忘却・許可・期限を現在値で見直す。
// 忘却した由来・派生からの再保存は、台帳の世代の新旧によらず拒否する。
export function memoryAdmission(
  candidate: MemoryCandidateInput,
  context: MemoryAdmissionContext,
): MemoryAdmission {
  const reasons: string[] = [];
  if (context.privateConversation) reasons.push('private_conversation');
  if (!context.allowedKinds.includes(candidate.kind))
    reasons.push('kind_not_allowed');
  if (candidate.permission_revision !== context.currentPermissionRevision)
    reasons.push('permission_changed');
  const base = BigInt(candidate.forgetting_generation);
  const current = BigInt(context.currentForgettingGeneration);
  if (base > current) reasons.push('generation_ahead');
  // 開始後の世代が台帳に揃っていなければ、忘却済みかを判定できない（03 復元）。
  const known = new Set(
    context.ledger.map((entry) => BigInt(entry.forgetting_generation)),
  );
  for (let generation = base + 1n; generation <= current; generation += 1n)
    if (!known.has(generation)) {
      reasons.push('forget_ledger_gap');
      break;
    }
  if (
    context.ledger.some((entry) =>
      candidate.sources.some(
        (source) =>
          entry.forgotten.some((item) => sameSource(item, source)) ||
          entry.blocked_source_ids.includes(source.source_id),
      ),
    )
  )
    reasons.push('source_forgotten');
  // 同じ内容の自動記憶化を黙って再開しない。本人の新しい明示依頼は別に扱う（ADR 0008）。
  if (
    candidate.origin === 'auto_extraction' &&
    context.ledger.some((entry) =>
      entry.blocked_content_keys.includes(candidate.dedupe_key),
    )
  )
    reasons.push('content_forgotten');
  if (
    candidate.sources.some((source) =>
      context.expiredSourceIds.includes(source.source_id),
    )
  )
    reasons.push('source_expired');
  if (reasons.length > 0)
    return { action: 'reject', reasons, conflictingMemoryIds: [] };
  const live = context.existing.filter((memory) => memory.status !== 'deleted');
  if (live.some((memory) => memory.dedupe_key === candidate.dedupe_key))
    return { action: 'duplicate', reasons: [], conflictingMemoryIds: [] };
  // 同じ種類・同じ対象キーで内容が違えば、両方を見直し待ちにする（J15、11 §7）。
  const conflicting = live
    .filter(
      (memory) =>
        memory.kind === candidate.kind &&
        memory.target_key === candidate.target_key,
    )
    .map((memory) => memory.memory_id);
  return conflicting.length > 0
    ? { action: 'review', reasons: [], conflictingMemoryIds: conflicting }
    : { action: 'save', reasons: [], conflictingMemoryIds: [] };
}

const plusDays = (time: string, days: number): string =>
  new Date(Date.parse(time) + days * DAY_MS)
    .toISOString()
    .replace('.000Z', 'Z');

// 新しい記憶の見直し日。別の記憶から作った記憶は、由来の見直し日より後にしない（再要約で延ばさない）。
export function initialReviewAt(
  createdAt: string,
  sourceMemoryReviewAts: readonly string[],
): string {
  const candidates = [
    plusDays(createdAt, MEMORY_REVIEW_DAYS),
    ...sourceMemoryReviewAts,
  ];
  return candidates.reduce((earliest, time) =>
    Date.parse(time) < Date.parse(earliest) ? time : earliest,
  );
}

export interface MemorySchedule {
  readonly status: 'active' | 'review_pending' | 'deleted';
  readonly review_at: string;
  readonly delete_at: string | null;
}

export type MemoryEvent =
  | 'used'
  | 'resummarized'
  | 'duplicate_extracted'
  | 'review_due'
  | 'explicit_continue'
  | 'delete_due';

// 期限の更新。利用・再要約・重複の再抽出では期限を変えない。
// 明示継続は見直し待ちの記憶だけで、継続した時点から次の 90 日（ADR 0008）。
export function applyMemoryEvent(
  memory: MemorySchedule,
  event: MemoryEvent,
  now: string,
): { readonly memory: MemorySchedule; readonly rejected: string | null } {
  const reject = (reason: string) => ({ memory, rejected: reason });
  if (
    event === 'used' ||
    event === 'resummarized' ||
    event === 'duplicate_extracted'
  )
    return { memory, rejected: null };
  if (event === 'review_due') {
    if (memory.status !== 'active') return reject('not_active');
    if (Date.parse(now) < Date.parse(memory.review_at))
      return reject('not_due');
    return {
      memory: {
        status: 'review_pending',
        review_at: memory.review_at,
        delete_at: plusDays(memory.review_at, MEMORY_DELETE_AFTER_REVIEW_DAYS),
      },
      rejected: null,
    };
  }
  if (event === 'explicit_continue') {
    if (memory.status !== 'review_pending') return reject('not_review_pending');
    return {
      memory: {
        status: 'active',
        review_at: plusDays(now, MEMORY_REVIEW_DAYS),
        delete_at: null,
      },
      rejected: null,
    };
  }
  if (memory.status !== 'review_pending' || memory.delete_at === null)
    return reject('not_review_pending');
  if (Date.parse(now) < Date.parse(memory.delete_at)) return reject('not_due');
  return {
    memory: { ...memory, status: 'deleted' },
    rejected: null,
  };
}

// 期限のある行（発言・記憶）を自動で使えるか。時計が巻き戻ったら、期限内でも整合するまで使わない（03 保存期限）。
export function expiryUsableReasons(
  expiresAt: string | null,
  now: string,
  lastCheckedAt: string,
): string[] {
  const reasons: string[] = [];
  if (expiresAt !== null && Date.parse(now) >= Date.parse(expiresAt))
    reasons.push('expired');
  if (Date.parse(now) < Date.parse(lastCheckedAt))
    reasons.push('clock_regression');
  return reasons;
}

// 自動提案の根拠にできる記憶か。見直し待ち・削除済み・見直し日を過ぎた記憶は使わない。
export function memoryUsableReasons(
  memory: MemorySchedule,
  now: string,
  lastCheckedAt: string,
): string[] {
  const reasons: string[] = [];
  if (memory.status !== 'active') reasons.push(memory.status);
  for (const reason of expiryUsableReasons(
    memory.review_at,
    now,
    lastCheckedAt,
  ))
    reasons.push(reason === 'expired' ? 'review_due' : reason);
  return reasons;
}

export interface ExtractionTrigger {
  readonly trigger: 'conversation_end' | 'idle_30min' | 'none';
  readonly privateConversation: boolean;
  readonly userExchanges: number;
  // memory_save で処理した往復。終了時の抽出から除く（X44）。
  readonly explicitSaveExchanges: number;
}

// 会話の終了時・30 分の無発言時の記憶抽出を行うか（11 §7）。
export function shouldExtractMemories(input: ExtractionTrigger): boolean {
  return (
    input.trigger !== 'none' &&
    !input.privateConversation &&
    input.userExchanges - input.explicitSaveExchanges >=
      MEMORY_EXTRACTION_MIN_EXCHANGES
  );
}

export interface LedgerCopy {
  readonly holder: string;
  readonly forgetting_generation: string;
  readonly complete: boolean;
}

// 復元で記憶・会話を戻せるか（03 バックアップ・復元）。最新の台帳を確認できなければ、非機密の設定だけを戻す。
export function restoreReasons(input: {
  readonly backupForgettingGeneration: string;
  readonly latestKnownGeneration: string | null;
  readonly copies: readonly LedgerCopy[];
}): { readonly restoreMemories: boolean; readonly reasons: string[] } {
  const reasons: string[] = [];
  if (input.latestKnownGeneration === null)
    reasons.push('latest_ledger_unconfirmed');
  else {
    const latest = BigInt(input.latestKnownGeneration);
    const usable = input.copies.filter(
      (copy) => copy.complete && BigInt(copy.forgetting_generation) >= latest,
    );
    if (usable.length === 0) reasons.push('latest_ledger_missing');
    if (BigInt(input.backupForgettingGeneration) > latest)
      reasons.push('backup_newer_than_ledger');
  }
  return { restoreMemories: reasons.length === 0, reasons };
}
