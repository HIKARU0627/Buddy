// 封筒（sealed_blobs の 1 行）を開いて、画面に返す短い本文にする（記憶の一覧の本文・忘却の計画の消える指示の本文。
// ADR 0183・0185）。
// - データ鍵と所有者（表・ID・版・用途）で開く。開けない・UTF-8 でない・空・上限（文字数。コードポイントで数える）を
//   超える本文は null（呼び出し側が「一覧全体を 503」「読めない指示」のどちらにするかを決める）。
// - 本文はログ・理由に入れない。

import { openBlob } from '@buddy/storage';
import type { DataKeyMaterial, MemoryBlobOutput } from '@buddy/storage';

export interface SealedTextOwner {
  readonly ownerTable: 'memories' | 'user_directives';
  readonly ownerId: string;
  readonly purpose: 'memory_text' | 'directive_text';
}

export function openSealedText(
  dataKey: DataKeyMaterial,
  blob: MemoryBlobOutput,
  owner: SealedTextOwner,
  maxCodePoints: number,
): string | null {
  const opened = openBlob(
    dataKey,
    {
      formatVersion: blob.format_version,
      keyId: blob.key_id,
      nonce: blob.nonce,
      ciphertext: blob.ciphertext,
      tag: blob.tag,
    },
    {
      ownerTable: owner.ownerTable,
      ownerId: owner.ownerId,
      ownerVersion: 0,
      purpose: owner.purpose,
    },
  );
  if (!opened.ok) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(opened.plaintext);
  } catch {
    return null;
  }
  const length = [...text].length;
  if (length === 0 || length > maxCodePoints) return null;
  return text;
}
