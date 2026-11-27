// 本人の明示の依頼（「〇〇を覚えて」の memory_save と、古い記憶を直す memory_correct）からの記憶の保存の準備（ADR 0191）。
//
// - 保存してよい種類の設定・台帳・今ある記憶を保存層から同じ時点で読み（memory.admission_facts）、domain の memoryAdmission
//   で判定する（記録しない会話・許可していない種類・設定の版・台帳との関係・重複・同じ対象の食い違い）。
// - 由来はこの発言だけ。由来の台帳用 HMAC と、内容・対象キーの HMAC は、台帳の鍵（ledger_hmac_key。バックアップの設定で CLI が
//   作って復旧キーで包む）から導いた鍵で求める（ADR 0040）。台帳の鍵がなければ保存しない（ここで鍵を作らない。U385 と同じ）。
// - 保存してよいと判定したら、本文と対象キーをデータ鍵で封じて、発言と同じ transaction（turn.record の memory）へ渡す。
//   保存層は同じ transaction で設定・台帳・重複・食い違いを照合し直す（最後の保証）。
// - 判定の結果（保存する・保存しない理由）を返し、本文・HMAC はログ・理由に入れない。

import { createHmac, hkdfSync, randomUUID } from 'node:crypto';
import {
  explicitMemoryText,
  ledgerSubkeyHkdfInput,
  memoryAdmission,
} from '@buddy/domain';
import { restoreSourceHmac, sealBlob } from '@buddy/storage';
import type {
  DataKeyMaterial,
  DbWorkerClient,
  MemoryAdmissionFacts,
  MemoryKindName,
  SealedBlobInput,
  TurnMemoryInput,
} from '@buddy/storage';

// 保存しなかった理由（応答の決まった文に写す。コードは画面に出さない）。
export type MemoryNotSavedReason =
  // 本文が空・制御文字を含む・80 文字を超える。
  | 'text_empty'
  | 'text_too_long'
  | 'text_control_character'
  // 種類が分からない（モデルが種類を返さなかった）。
  | 'kind_missing'
  // 保存してよい種類に入っていない（既定は空）。
  | 'kind_not_allowed'
  // 処理の間に保存してよい種類の設定が変わった。
  | 'settings_changed'
  // 記録しない会話の間。
  | 'private_conversation'
  // 同じ内容の記憶がある（二重に保存しない）。
  | 'duplicate'
  // 同じ種類・同じ対象で内容の違う記憶がある（U111。保存せずに知らせる）。
  | 'conflict'
  // 忘却と関係する（台帳の欠け・忘れた由来など。明示の新しい発言ではふつう起きない）。
  | 'forgotten'
  // 台帳の鍵・データ鍵がない、保存層を読めない（中枢の準備が整っていない）。
  | 'not_ready';

export type ExplicitMemoryPlan =
  | {
      readonly kind: 'save';
      readonly memory_kind: MemoryKindName;
      readonly memory: TurnMemoryInput;
    }
  | {
      readonly kind: 'not_saved';
      readonly memory_kind: MemoryKindName | null;
      readonly reason: MemoryNotSavedReason;
    };

export interface ExplicitMemoryInput {
  readonly body: string;
  readonly memory_kind: MemoryKindName | null;
  // 保存する発言の ID（由来）。発言と同じ transaction で保存する。
  readonly turn_id: string;
  // 保存境界の保持者が記録しない会話か（ふつうは RAM の経路へ分かれて、ここへは来ない。重ねた守り）。
  readonly private_conversation: boolean;
  readonly data_key: DataKeyMaterial;
}

export interface ExplicitMemoryDeps {
  readonly store: Pick<DbWorkerClient, 'memory'>;
  // 台帳の HMAC の鍵（32 バイト）。バックアップの設定の前・読めなければ null。
  readonly ledgerKey: () => Promise<Uint8Array | null>;
  readonly newId?: () => string;
}

// 台帳の鍵から、記憶の内容の HMAC の鍵を導く（ADR 0040: info = buddy/memory/dedupe/v1、salt は空）。
function dedupeSubkey(ledgerKey: Uint8Array): Buffer {
  const input = ledgerSubkeyHkdfInput('memory_dedupe');
  return Buffer.from(
    hkdfSync(
      input.hash,
      ledgerKey,
      Buffer.from(input.salt),
      Buffer.from(input.info),
      input.length,
    ),
  );
}

// 内容・対象キーの HMAC の入力: 用途の名前 ‖ 0x00 ‖ 種類 ‖ 0x00 ‖ 本文（UTF-8）。用途の名前で内容と対象キーを分ける。
function keyedHash(
  subkey: Buffer,
  use: 'content' | 'target',
  kind: MemoryKindName,
  text: string,
): string {
  return createHmac('sha256', subkey)
    .update(Buffer.from(`buddy/memory/${use}/v1`, 'utf8'))
    .update(Buffer.from([0]))
    .update(Buffer.from(kind, 'utf8'))
    .update(Buffer.from([0]))
    .update(Buffer.from(text, 'utf8'))
    .digest('hex');
}

function seal(
  dataKey: DataKeyMaterial,
  memoryId: string,
  purpose: 'memory_text' | 'memory_target_key',
  text: string,
): SealedBlobInput | null {
  const sealed = sealBlob(dataKey, Buffer.from(text, 'utf8'), {
    ownerTable: 'memories',
    ownerId: memoryId,
    ownerVersion: 0,
    purpose,
  });
  if (!sealed.ok) return null;
  return {
    blob_id: randomUUID(),
    format_version: sealed.envelope.formatVersion,
    key_id: sealed.envelope.keyId,
    nonce: sealed.envelope.nonce,
    ciphertext: sealed.envelope.ciphertext,
    tag: sealed.envelope.tag,
  };
}

// memoryAdmission の拒否の理由を、応答に出す理由へまとめる（優先は記録しない会話 → 種類 → 設定の版 → 忘却との関係）。
function rejectionReason(reasons: readonly string[]): MemoryNotSavedReason {
  if (reasons.includes('private_conversation')) return 'private_conversation';
  if (reasons.includes('kind_not_allowed')) return 'kind_not_allowed';
  if (reasons.includes('permission_changed')) return 'settings_changed';
  if (
    reasons.some((reason) =>
      [
        'source_forgotten',
        'content_forgotten',
        'forget_ledger_gap',
        'generation_ahead',
      ].includes(reason),
    )
  )
    return 'forgotten';
  return 'not_ready';
}

// 保存層の turn.record が memory_rejected で返した理由を、応答の理由へまとめる（処理の間に変わったときの最後の保証）。
export function storageRejectionReason(
  reasons: readonly string[],
): MemoryNotSavedReason {
  if (reasons.includes('memory_duplicate')) return 'duplicate';
  if (reasons.includes('memory_conflict_review_required')) return 'conflict';
  return rejectionReason(reasons);
}

export async function planExplicitMemory(
  deps: ExplicitMemoryDeps,
  input: ExplicitMemoryInput,
): Promise<ExplicitMemoryPlan> {
  const kind = input.memory_kind;
  const notSaved = (reason: MemoryNotSavedReason): ExplicitMemoryPlan => ({
    kind: 'not_saved',
    memory_kind: kind,
    reason,
  });
  const text = explicitMemoryText(input.body);
  if (!text.ok)
    return notSaved(
      text.reason === 'empty'
        ? 'text_empty'
        : text.reason === 'too_long'
          ? 'text_too_long'
          : 'text_control_character',
    );
  if (kind === null) return notSaved('kind_missing');
  // 記録しない会話では、鍵・保存層を読む前に断る（記録しない間の発言の痕跡を作らない）。
  if (input.private_conversation) return notSaved('private_conversation');
  let ledgerKey: Uint8Array | null;
  try {
    ledgerKey = await deps.ledgerKey();
  } catch {
    ledgerKey = null;
  }
  if (ledgerKey === null || ledgerKey.length !== 32)
    return notSaved('not_ready');
  const read = await deps.store.memory({ kind: 'memory.admission_facts' });
  if (!read.ok) return notSaved('not_ready');
  const facts = read.value as MemoryAdmissionFacts;
  const subkey = dedupeSubkey(ledgerKey);
  const sourceHmac = restoreSourceHmac(ledgerKey);
  const source = { source_kind: 'turn' as const, source_id: input.turn_id };
  const dedupeKey = keyedHash(subkey, 'content', kind, text.text);
  // 対象キーは本文そのもの（明示の依頼の引数に対象キーはない。U488）。同じ種類・同じ本文は重複として扱われる。
  const targetKeyHash = keyedHash(subkey, 'target', kind, text.text);
  const admission = memoryAdmission(
    {
      origin: 'explicit_request',
      kind,
      target_key: targetKeyHash,
      sources: [source],
      dedupe_key: dedupeKey,
      forgetting_generation: facts.forgetting_generation,
      permission_revision: facts.settings.settings_revision,
    },
    {
      privateConversation: input.private_conversation,
      allowedKinds: facts.settings.allowed_kinds,
      currentForgettingGeneration: facts.forgetting_generation,
      currentPermissionRevision: facts.settings.settings_revision,
      ledger: facts.ledger,
      sourceHmac,
      expiredSourceIds: [],
      existing: facts.existing,
    },
  );
  if (admission.action === 'reject')
    return notSaved(rejectionReason(admission.reasons));
  if (admission.action === 'duplicate') return notSaved('duplicate');
  if (admission.action === 'review') return notSaved('conflict');
  const memoryId = (deps.newId ?? randomUUID)();
  const sealedText = seal(input.data_key, memoryId, 'memory_text', text.text);
  const sealedKey = seal(
    input.data_key,
    memoryId,
    'memory_target_key',
    text.text,
  );
  if (sealedText === null || sealedKey === null) return notSaved('not_ready');
  return {
    kind: 'save',
    memory_kind: kind,
    memory: {
      memory_id: memoryId,
      memory_kind: kind,
      text: sealedText,
      target_key: sealedKey,
      target_key_hash: targetKeyHash,
      dedupe_key: dedupeKey,
      source_hmac: sourceHmac(source),
      forgetting_generation: facts.forgetting_generation,
      settings_revision: facts.settings.settings_revision,
    },
  };
}
