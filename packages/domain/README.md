# @buddy/domain

承認・状態遷移・通知・忘却・予算などの規則と境界仕様を置きます。
storage / Core / Electron / OS 固有 API に依存しません。

B00 時点の内容（[ADR 0004](../../docs/adr/0004-intent-table-and-readiness.md)）:

- `home-network.ts`: 自宅判定（指紋の一致と Tailscale の直接経路の両方、報告の鮮度 6 分、中枢と同じマシンの免除）と IPv4 のサブネットの読み取り（[ADR 0022](../../docs/adr/0022-b03-home-network-check.md)）
- `listen-address.ts`: 中枢の HTTPS の待ち受けのアドレスの正規化（IPv4-mapped は IPv4 に直す）と、許可する範囲（ループバック・Tailscale）の判定（[ADR 0020](../../docs/adr/0020-b03-https-tls-and-route-checks.md)、B03-07）
- `api.ts`: 経路ごとの検査（認証・自宅判定・接続範囲・ロック・画面操作・音声所有権・版）、再送、イベントの反映、リース、停止の到達、ペアリング（[ADR 0009](../../docs/adr/0009-openapi-auth-events-and-reconnect.md)）
- `intents.ts`: 24 意図ごとの経路（Read / LocalCommand / RemoteMutation）・承認・方式 C の可否・必須と許可の引数
- `readiness.ts`: 変更を伴う意図の実行可否（blocked / needs_approval / auto_eligible）を決める純粋関数
- `notification.ts`: 通知の配信と一覧の分離（再取得・再接続・端末移動・ACK 喪失で鳴らし直さない）
- `operations.ts`: 操作の内部状態と許される遷移（設計 08 §3・§4）。内容版の更新（D1）と LocalCommand だけの approved → succeeded（D5）は ADR 0027
- `connectors.ts`: 操作の種類ごとの規則、connector の能力の型と検査、照合の結果の扱い、作成物の目印（ADR 0027）
- `operation-steps.ts`: 操作の工程（operation_steps）の進め方（D3、ADR 0027）
- `approval.ts`: 承認の受付（同じ内容版の承認は一つ・方針の版）と DB worker の命令の再検査（[ADR 0010](../../docs/adr/0010-domain-boundary-and-storage-draft.md)）
- `audio.ts`: 停止理由ごとの動作と再開条件、遅着した結果の受け入れ、出力先の決定（[ADR 0005](../../docs/adr/0005-conversation-and-voice-control.md)）
- `desktop.ts`: デスクトップの限定 IPC の受付（送信元・ロック・画面操作・停止の範囲・io_epoch）、状態欄の非表示、入出力・ロックの状態遷移（[ADR 0014](../../docs/adr/0014-b01-desktop-ipc-contract.md)）
- `conversation.ts`: 意図ごとの結果表示、会話の操作の照合
- `retention.ts`: 削除期限の計算（起点から一度だけ）
- `sync.ts`: 同期の走査の排他、公開前の compare-and-swap、時計の後退の保留（[ADR 0007](../../docs/adr/0007-sync-extraction-and-related-analysis.md)）
- `extraction.ts`: モデル出力の期限の変換、候補起点の自動実行の共通検査と操作ごとの検査
- `analysis.ts`: 関連集合の ready 判定、取消・完了の順序に依存しない解決、自動作成の一度だけの制限
- `budget.ts`: 予約 R・最大負担 M による受付、追加予約、一度だけの精算、usage 不明の保持、未送信の解放（[ADR 0006](../../docs/adr/0006-budget-reservation-and-liability.md)）
- `memory.ts`: 記憶の保存直前の検査（忘却した由来・派生・同じ内容の再取り込み・遅着）、見直しと削除の期限、時計の巻き戻り、復元の可否、抽出の時点（[ADR 0008](../../docs/adr/0008-memory-forgetting-and-model-evaluation.md)）
- `evaluation.ts`: 配備×用途の採否、配備の段階、成果物の照合、同じモデル ID のままの変化の検知、戻し先、影モードの停止と skip

contracts の生成型は import せず、意図名・引数名の一覧が schema と一致することを `scripts/domain.test.mjs`・`scripts/voice.test.mjs`・`scripts/budget.test.mjs`・`scripts/sync-analysis.test.mjs`・`scripts/memory-evaluation.test.mjs`・`scripts/api.test.mjs`・`scripts/boundary.test.mjs`・`scripts/desktop-ipc.test.mjs` で検査します。試験はビルド後の `dist` を対象にします。DB の transaction・最終検査・外部送出は未実装です。
