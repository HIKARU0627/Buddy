// 遅れて届いた非同期の結果の検査（設計 08 §6、ADR 0040 の忘却の関連の判定、B06-03）。
// 要約・記憶の候補・表示・次の外部送信のどれでも、保存・表示・送信の直前に同じ規則で見直す。
// 記憶の保存直前の検査（memoryAdmission）と DB 命令の再検査（commandGuard）も、台帳との関係の判定を共有する。
// 台帳・期限・許可の現在値は Core が DB から読んで渡す。元情報の ID の HMAC は注入された関数で求める（鍵は持たない）。

import {
  ledgerRelationReasons,
  type ForgetEntry,
  type MemorySource,
  type SourceHmac,
} from './memory.js';

export type LateResultUse = 'persist' | 'display' | 'send';

export interface LateResult {
  // persist: 保存（記憶・要約など）、display: 自動表示、send: 後続の外部送信・クラウド送信。
  readonly use: LateResultUse;
  // 結果の由来（発言・元情報・別の記憶）。Core が自分の DB の行から作る。
  readonly sources: readonly MemorySource[];
  // 由来の全体を Core が把握しているか。由来を引けない結果（記録が欠けた・旧い）は、閉じた側に倒して破棄する。
  readonly provenance: 'complete' | 'unknown';
  // 処理開始時の値。
  readonly started_generation: string;
  readonly permission_revision: string;
  // 自動抽出の候補の内容の HMAC。明示の保存・表示・送信は null（内容の禁止では止めない。ADR 0008）。
  readonly content_key: string | null;
}

export interface LateResultContext {
  readonly privateConversation: boolean;
  readonly currentForgettingGeneration: string;
  readonly currentPermissionRevision: string;
  // 処理開始時の世代以降を含む、Core が保持する台帳の全件。
  readonly ledger: readonly ForgetEntry[];
  readonly sourceHmac: SourceHmac;
  readonly expiredSourceIds: readonly string[];
}

export interface LateResultDecision {
  readonly action: 'accept' | 'discard';
  readonly reasons: string[];
}

// 遅着の検査。理由の並びは memoryAdmission と同じ（記録しない会話・許可・台帳・期限の順）。
// 世代の新旧ではなく、由来が忘却と関係するかで決める（ADR 0040）。
export function lateResultCheck(
  result: LateResult,
  context: LateResultContext,
): LateResultDecision {
  const reasons: string[] = [];
  // 記録しない会話では保存しない。表示・送信は一時の文脈のまま行える。
  if (result.use === 'persist' && context.privateConversation)
    reasons.push('private_conversation');
  if (result.provenance === 'unknown') reasons.push('provenance_unknown');
  if (result.permission_revision !== context.currentPermissionRevision)
    reasons.push('permission_changed');
  reasons.push(
    ...ledgerRelationReasons({
      sources: result.sources,
      startedGeneration: result.started_generation,
      currentGeneration: context.currentForgettingGeneration,
      ledger: context.ledger,
      sourceHmac: context.sourceHmac,
      contentKey: result.content_key,
    }),
  );
  if (
    result.sources.some((source) =>
      context.expiredSourceIds.includes(source.source_id),
    )
  )
    reasons.push('source_expired');
  return { action: reasons.length === 0 ? 'accept' : 'discard', reasons };
}

// DB 命令の再検査で、忘却の世代の検査を「関係する由来のときだけ」に絞るための入力（commandGuard の options.forgetting）。
export interface ForgettingScope {
  // 命令の由来（確定内容の元になった発言・元情報・記憶）。Core が async_context_guards などから読む。
  readonly sources: readonly MemorySource[];
  // 由来を把握しているか。unknown なら絞らず、世代が変わったら拒否する従来の規則のまま。
  readonly provenance: 'complete' | 'unknown';
  readonly ledger: readonly ForgetEntry[];
  readonly sourceHmac: SourceHmac;
}

// 忘却の世代の検査の理由。空なら通してよい。
// - 判明している由来は、由来の全体が分からなくても、必ず台帳と照合する（忘れた由来を含む命令は通さない）。
// - 世代が同じ: 台帳が由来を忘れていなければ通す（忘れた由来から作った命令は、世代が同じでも通さない）。
// - 世代が進んだ: 由来が忘却と無関係なら通す。台帳に開始後の世代が揃っていなければ判定できないので拒否する。
// - 由来を把握していない: 世代が変わっていれば拒否する（従来どおり）。外部へ送る命令（external）は、由来が不明なら
//   世代が同じでも拒否する（忘れた内容が送られないことを確かめられない）。
// - 台帳との照合に使う HMAC が形（64 桁の小文字 16 進）を満たさなければ拒否する（source_hmac_malformed）。
export function scopedForgettingReasons(
  commandGeneration: string,
  currentGeneration: string,
  scope: ForgettingScope,
  external = false,
): string[] {
  const reasons: string[] = [];
  if (scope.provenance === 'unknown') {
    if (commandGeneration !== currentGeneration)
      reasons.push('forgetting_generation_changed');
    if (external) reasons.push('provenance_unknown');
  }
  reasons.push(
    ...ledgerRelationReasons({
      sources: scope.sources,
      startedGeneration: commandGeneration,
      currentGeneration,
      ledger: scope.ledger,
      sourceHmac: scope.sourceHmac,
      contentKey: null,
    }),
  );
  return reasons;
}
