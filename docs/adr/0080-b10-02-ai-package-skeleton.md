# ADR 0080: B10-02 P1 `packages/ai` の骨格とアダプターの境界

- 日付: 2026-11-03
- 状態: B10-02 P1 の判断。`packages/ai` の追加、アダプターの型、注入した HTTP、偽の実装、依存方向だけ。振り分け・profile の検査は P2、出力の検証・失敗の区別・usage の計上は P3。実 API・API キー・実請求・実機は未実施（B15 と本人の承認まで扱わない）。
- 根拠: 設計 05「モデルの振り分け」・「費用の計算」・「予約と最大負担の区別」、設計 10 §5（判定モデルの選定・LLM の同時実行）、設計 11 §8・§9、設計 09 QA02・QA13・QA20・QA37・QA40、ADR 0006・0034・0042・0070。原本は権限のある接続で読み取りだけを行い、全文は写していない。
- 対象: `pnpm-workspace.yaml`、`packages/ai/package.json`、`packages/ai/tsconfig*.json`、`packages/ai/src/{types,http,provider,adapter,testing,index}.ts`、`packages/ai/src/adapter.test.ts`、`eslint.config.mjs` の依存方向。契約（`packages/contracts`）は変えていない。

## 決めたこと

| 対象                 | 決定                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| パッケージの位置づけ | `@buddy/ai` は LLM・ローカルのモデルへつなぐ**アダプターの層**。Core から使う（B10-03 以降）。`packages/contracts` の `ModelProfile`・`ModelUsage`・`WireResponse`・`ModelOutcome` を正本にし、同じ型を複製しない   |
| 依存方向             | `@buddy/contracts` と（P3 で）`@buddy/domain` の公開出口だけ。Electron・デスクトップ・Core・保存へ依存しない。製品のコードは `node:*` を読まない。HTTP は注入した `HttpTransport` だけに依存する                    |
| 差の吸収             | クラウドとローカルの差は `ProviderCodec`（wire 形式・usage・終了理由）と `ModelProfile`（endpoint・思考・出力上限・timeout・同時数・能力）の内側に閉じる。呼び出し側は `ModelCommand` と `AdapterResult` だけを扱う |
| 1 回の送信           | `complete()` は 1 回だけ `transport.send()` を呼ぶ。timeout・unavailable・不正な応答の後に**自動で送り直さない**（ADR 0070、設計修正案 v1.2 P01・P02）。再試行を決めるのは利用者または上位の経路                    |
| timeout              | `profile.timeout_ms` を `HttpRequest.timeout_ms` に渡す。期限を守るのは transport の責任で、超えたら `timeout` を返す。アダプターは timer を持たない                                                                |
| 中断                 | DOM の `AbortSignal` を持ち込まず、`{ readonly aborted: boolean }` を注入する。送信の前後で確かめる。応答が届いた後に中断された場合も、観測した usage は捨てずに `cancelled` と一緒に返す                           |
| provider の失敗      | 封筒が読めない・HTTP が成立しない場合は `unavailable`、期限切れは `timeout`、送信前後の中断は `cancelled`。usage は観測できなければ `null` にし、推測で埋めない                                                     |
| refused・truncated   | provider の拒否と出力上限での打ち切りは、本文が空でも成功にしない。`AdapterResponse.refused`・`truncated` として持ち、P3 で `ModelOutcome` の `refused`・`truncated` にする                                         |
| 秘密                 | API キー・認証ヘッダーはリポジトリ・profile・codec に置かない。transport の外（Core の実行時の設定）で足す。profile の endpoint は実行時の設定で、試験は合成の `.invalid` ドメインだけを使う                        |
| 偽の実装             | `@buddy/ai/testing`（`createFakeAdapter`・`createFakeTransport`）を別の出口にし、製品のコードから読めないよう ESLint で拒否する。試験の期待値は試験側に手で書き、偽の実装から生成しない                             |
| 出力の検証           | P1 では行わない。`AdapterResult` は生の本文・usage・refused・truncated だけを運び、schema・上限・空・途中の JSON の区別は P3 の検証層が行う                                                                         |

## 試験（模擬だけ）

- `packages/ai/src/adapter.test.ts`: 偽のアダプターの順序と記録、HTTP アダプターが endpoint・timeout・body を渡すこと、timeout/unavailable で送信が 1 回だけであること、送信前の中断で送らないこと、応答後の中断で usage を保つこと、壊れた封筒が `unavailable` になること。
- `pnpm --filter @buddy/ai run typecheck`、`pnpm --filter @buddy/ai run build`、`node --test packages/ai/dist/*.test.js`、`pnpm exec eslint packages/ai`。
- **模擬のみ**。実 API・API キー・実請求・実機は未実施で、合格扱いにしない。

## 残ること

- 振り分け表（役割・ジョブ→profile）、profile の検査、同時数・timeout・影モードの受付は P2。
- 出力の検証（schema・上限・空・途中の JSON・拒否）と `ModelOutcome`、usage から予約・精算へ渡す部分は P3。
- Gemini などの実際の provider の codec と、Core の予算の門への接続は B10-03 以降。実 API は B15 と本人の承認まで行わない。
