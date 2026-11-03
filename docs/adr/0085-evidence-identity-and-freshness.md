# ADR 0085: 模擬証拠の同一性（G1〜G5）の分離と記録の現在性

- 日付: 2026-11-03
- 状態: 決定（本人の決定 2026-11-03）。実装は PR-2（検査の分離）、PR-3（PR の CI での生成）、PR-4（main の freshness）、PR-5（工程完了のゲート）で行う。この ADR は判断だけを記録し、実機・実 API・実請求の結果を意味しない。
- 根拠: [B04 の完了判定](../b04/README.md)、[B07 の完了判定](../b07/README.md)、[統合試験](../../tests/integration/README.md)、`scripts/test-map.test.mjs`、`scripts/b04-evidence-sources.mjs`、`scripts/b07-evidence-sources.mjs`、`.github/workflows/ci.yml`・`verify-os.yml`・`evidence-macos.yml`、[開発手順](../development.md)。
- 対象: 模擬証拠（`tests/integration/evidence-b04-simulated.json`・`evidence-b07-simulated.json`）の検査の置き場所と、`simulated` の意味。B04・B07 のケース・期待値・観測内容は変えない。契約（`packages/contracts`）も変えない。

## 背景

現在の `scripts/test-map.test.mjs` は、コミット済みの模擬証拠の `source_sha256` が検査時点の対象ファイル集合と完全一致することを、PR の CI（3 OS の shard 1）で必須にしている。対象は B04 で 196 ファイル、B07 で 115 ファイルあり、`packages/domain/src/index.ts`・`packages/contracts/schemas/buddy.schema.json`・`apps/core/src/core.ts` などの共有のホットファイルを含む。このため、main が進むたびに他の PR の証拠が古くなり、再生成・取り込み・main の取り込みを繰り返す待ちが起きる。PR #206 では作成からマージまで 39 時間 49 分かかり、直近 300 の非マージコミットの 14.7% が証拠だけの再生成だった。

最終的な木は、マージするまで確定しない。したがって「マージ後の木に対する記録」は、マージ後に作るか、マージを直列化するか、その時点では要求しないかのどれかになる。証拠の hash 一致は、実行器が期待値と一致すること（挙動）を追加していない。追加しているのは「記録が現在のソースに対応する」ことだけである。

## いま保証しているもの（G1〜G5）

| ID                       | 内容                                                                            | 現在の担保                                                     |
| ------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| G1（同一性）             | コミット済み証拠の `source_sha256` が、検査時点の対象ファイル集合と完全一致する | `scripts/test-map.test.mjs` → `scripts/*-evidence-sources.mjs` |
| G2（観測）               | 全ケース × seed が実行され、手書きの期待値に一致した                            | 実行器 + `scripts/test-map.test.mjs`                           |
| G3（耐久）               | 証拠が Git に残り、レビューでき、後から commit を辿れる                         | Git                                                            |
| G4（無言のドリフト防止） | 対象ソースが変わったまま、古い証拠を「現在の成功」として残せない                | G1 の CI 失敗                                                  |
| G5（挙動）               | B04・B07 の実行器が、PR の HEAD で期待値どおり通る                              | PR CI の shard 2/3（証拠の有無と独立）                         |

G5 は証拠の hash 検査とは独立に、すでに PR の CI で検査されている。実行器自身が期待値を assert している（B07 は `tests/integration/b07-cases.mjs`、B04 は `tests/integration/b04-support.mjs`）。したがって、hash 一致を PR の必須条件から外しても「その PR のソースでシミュレータが通る」ことは失われない。失われるのは記録の現在性（G1/G4）だけであり、それを工程の完了時と main の更新で担保する。

## 決めたこと

| 対象                    | 決定                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 記録の現在性の目標      | **常に main と一致（A＋更新）** を目標にする。移行は **工程の完了時だけ一致（C）** から始める。                                                                                        |
| main の一時的な古さ     | main の記録が一時的に古い状態を許す。freshness は専用のシグナル（`evidence-freshness.yml`）にし、`ci.yml` の必須チェック（`Verify (<os>)`・`Public content / secrets`）とは分ける。    |
| 記録の更新              | 生成物を artifact に残し、**ワーカーが取り込む PR（または定期の作業）** から始める。bot PR・`contents: write` は今回は作らない。書き込み権限を持つ job をコード実行の job に置かない。 |
| 生成する OS と job      | 生成は **macOS のまま**、既存の shard 2（B07）・shard 3（B04）を使う。**追加の macOS job は 0**。strict な照合は必須チェックと分けた別の job または workflow で行う。                  |
| `simulated` の意味      | **記録した commit での観測** に変える。現在のソースや main で再現したこと、実機・実 API・実請求の合格を意味しない。`tests/test-map.json` と README の読み方をこれに合わせる。          |
| PR の CI が検査するもの | 実行器の期待値との一致（G2/G5）、`tests/test-map.json` の構造・参照・期待値の整合。コミット済み証拠の hash 一致（G1/G4）は必須にしない。                                               |
| 工程の完了時            | その工程の担当が **完了 PR の head で証拠を再生成し、`pnpm run evidence:check` が通ることを確認**してから README に記録する。ここが G1/G4 の最終的な担保になる。                       |
| B（範囲を狭める）       | やらない。ホットファイルが残るため単独では解決せず、外したファイルの監査が G1 を静かに弱める。事故的な広さを削る補助としてだけ将来検討する。                                           |
| D（merge queue）        | やらない。queue の合成 head は main＋他の queued PR で最終木を確定せず、full matrix の再実行で macOS の使用量が増える。                                                                |
| E（期限つきの直列化）   | 廃止する。B05 の証拠が加わると 3 本の証拠が同時に無効化され、現在の運用では回らない。                                                                                                  |
| B05（#190）の順序       | 仕組み（PR-2・PR-3）を先に main へ入れ、その後に #190 を入れる。#190 の証拠は新しいルール（PR の CI で生成、完了時に strict）で作り直す。                                              |

## 保証すること・しないこと（誤解防止）

- 保証する: PR の head で全ケースが実行され、手書きの期待値に一致する（G2/G5）。記録は「その commit で観測した」事実を Git に残す（G3）。工程の完了時と main の更新が完了した時点で、記録はその木に一致する（G1/G4）。
- 保証しない: マージ直後から記録の更新までの間、main の記録は直前の木のものである（窓）。通常の PR の CI は、コミット済み証拠が現在のソースに対応することを保証しない。PR ごとの生成物は artifact であり、Git の履歴には残らない（保存期間に依存する）。
- 変わらない: 実機・実 API・実請求・本物の OS 確認ダイアログは未実施のまま。`AGENTS.md` の「模擬と実機・実 API・実請求を分ける」を維持する。B04・B07 のケース・期待値・観測内容は変えない。

## 情報管理

workflow の権限は `contents: read` のままにする。公開リポジトリなので、書き込みのトークンをコード実行の job に置かない。artifact は JSON だが、試験コードが任意の文字列を書き得るため、人が差分を確認し、取り込み PR で `pnpm run security:staged` を通す。`pull_request_target` は使わず、ruleset の bypass も使わない。`docs/public-release.md` の「Private 前提」の記述と実際の公開状態のずれは、この ADR では直さず、別の確認事項として残す。

## 未決事項（contract-map）

- U201: main の記録が古い窓をどれだけ許すか（freshness の期限・通知・issue 化の運用）。
- U202: B05（#190）の証拠を新しいルールで作り直す時期と担当。
- U203: 自動更新（bot PR、GitHub App / fine-grained PAT、`contents: write`）を将来導入するか。導入する場合も生成 job（read-only）と書込み job（コード実行なし）を分ける。
