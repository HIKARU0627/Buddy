# 初回の実行・保存境界

状態: 境界仕様。コード・SQL マイグレーション・統合試験は未実装。

## 入力から結果まで

1. Core が入力の由来・範囲・最新版を確認し InputSnapshot を固定する。端末や LLM が付けた sealed を信用しない。
2. LabelMailWireResponse は提案。candidate ID の存在・権限、ラベルの存在・可逆性、引用・入力版、relation と対象 workflow を検査する。不足は聞き返し、失敗・timeout・拒否を unclear に混ぜない。
3. Interpretation の作成と ActionReadiness の計算は別。方式 C の暫定入力では許可済みの自動操作だけを候補にできる。その他条件で画面承認が必要なら全文確定／再入力へ戻す。記憶保存へ流用しない。
4. 確定 intent を JCS 化して hash を計算し、画面の preview に結び付ける。ラベル変更でも根拠不足なら保留。認可なしで画面承認待ちへ進めて解決したことにしない。
5. 承認は operation_id / content_version / content_hash と scope / preview / 表示権等を照合して記録する。内容版と状態版を区別する。同じ内容への重複承認で実行系列を増やさない。
6. 外部送出直前に、現在の入力版・根拠・許可版・方針版・停止・取消・予算・対象版を再検査し、送出意図の durable commit を確認して一度だけ送る。
7. 結果不明は unknown_held とし自動再送しない。receipt の accepted / durable を操作成功表示にしない。

候補起点のラベル変更には F05 の関連解析完了も必要です。今回の schema だけではその検査がないため、候補起点の実行を有効化できません。入力起点でも Core の上記ガード実装が必要です。

## 保存の必須制約

| 対象                       | 後続のマイグレーションで固定すること                                               |
| -------------------------- | ---------------------------------------------------------------------------------- |
| operation_versions         | operation_id + content_version の一意性と intent / hash の不変性                   |
| approvals                  | 内容版ごとの有効承認1件。本人承認と方針による自動承認を区別                        |
| operation_attempts / steps | 操作ごとの active 試行1件、送出意図、外部ID、結果と照合根拠                        |
| command_receipts           | scope + request_id の一意性。異なる要求内容の再利用拒否。本文を複製しない          |
| event_outbox               | 状態変更と同じ transaction。本文なし。DB世代・連番・操作版を保持                   |
| budget_reservations        | R / M と元の予算月・scope。精算キーで一度だけ更新。usage不明を月替わりで解放しない |
| async_context_guards       | 入力版・取得世代・許可・忘却・期限・出力先。最終境界で再検査                       |

SQL は後続の全契約との整合後に作成します。接続の WAL / FULL と対象 OS の同期要件、単一 writer、commit 成否不明時の停止を保ちます。機密本文は既定の暗号化・期限・忘却を通し、平文 fallback を作りません。

## 検証の区別

Schema、H01、局所的な意味不変条件は開発ツールで検査します。DB の競合、同時予算受付、電源断、provider の一回送出、QA41〜QA45 は別の統合・実機試験です。`fixtures/workflow-label.json` の期待結果は未実行の仕様で、実績欄ではありません。
