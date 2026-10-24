// 派生物の系譜（設計 03 忘却と再取り込み・08 §6、ADR 0040・0044・0048、マイグレーション 0010）。
//
// 要約・気づき・抽出結果などの派生物を、その由来（発言・元情報・記憶・ほかの派生物）に結ぶ。派生物を作る
// transaction の中で書き、忘却の閉包・期限・復元の忘却の適用は、由来から辺をたどって行う（使うのは B06-06c 以降）。
// 正本は DB の UNIQUE（同じ組を二度書かない）と CHECK（種類を限る）。ここは型と、書き込み・読み出しの薄い関数だけ。

import type { ForgetArtifactKind } from '@buddy/domain';
import type { SqliteDatabase } from './connection.js';

// 派生物になれる種類。domain の forget-plan.ts の ForgetNodeKind のうち、session（由来を引けない派生物が属する
// 範囲だけを表す）を除いたもの。source_kind は根の由来（turn・source_item・memory）も取れる。
export type DerivationArtifactKind = 'turn' | 'memory' | ForgetArtifactKind;
export type DerivationSourceKind =
  'turn' | 'source_item' | 'memory' | ForgetArtifactKind;

export interface DerivationInput {
  readonly artifact_kind: DerivationArtifactKind;
  readonly artifact_id: string;
  readonly source_kind: DerivationSourceKind;
  readonly source_id: string;
  readonly created_at: number;
}

export type DerivationRecord = DerivationInput;

interface DerivationRow {
  artifact_kind: DerivationArtifactKind;
  artifact_id: string;
  source_kind: DerivationSourceKind;
  source_id: string;
  created_at: number;
}

const COLUMNS =
  'artifact_kind, artifact_id, source_kind, source_id, created_at';

// 系譜の辺を 1 つ書く。同じ組（派生物・由来）が既にあれば UNIQUE 制約で失敗する（黙って置き換えない）。
export function writeDerivation(
  db: SqliteDatabase,
  input: DerivationInput,
): void {
  db.prepare(`INSERT INTO derivations (${COLUMNS}) VALUES (?, ?, ?, ?, ?)`).run(
    input.artifact_kind,
    input.artifact_id,
    input.source_kind,
    input.source_id,
    input.created_at,
  );
}

// 由来から、そこから作った派生物の辺を読む（忘却の閉包・復元の忘却の適用）。
export function readDerivationsBySource(
  db: SqliteDatabase,
  source: {
    readonly source_kind: DerivationSourceKind;
    readonly source_id: string;
  },
): DerivationRecord[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM derivations WHERE source_kind = ? AND source_id = ? ORDER BY artifact_kind, artifact_id, created_at`,
    )
    .all(source.source_kind, source.source_id) as DerivationRow[];
}
