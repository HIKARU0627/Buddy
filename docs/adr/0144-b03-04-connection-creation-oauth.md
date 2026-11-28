# ADR 0144: 接続の作成・OAuth・トークン保存・取得範囲の作成（B03-04）

- 日付: 2026-11-23
- 状態: 本人が着手を承認済み（2026-11-23「すすめて」）。実装と試験（模擬）まで。実アカウントでの認可・実 API 検証は未実施（本人の手順として残件に書く）。
- 根拠: ADR 0009（外部サービスの認可。戻り先は /v1 の外、ループバック）・0010（OAuth トークンは OS の KeyStore、DB とバックアップに入れない）・0017（バックアップの鍵の KeyStore の形）・0022（自宅判定）・0086〜0089（取得範囲・接続の保存）・0136（Google の同期の実行部。U207 は (b)）・0137（スケジューラ）・0138（Graph の同期の実行部）、設計 04（対象サービスとの連携: OAuth の方式・初期スコープ・初期の取得期間）・06（接続の状態）・11 §1A（取得集合）。

## 棚卸し（既にあったもの／新規に作ったもの）

既にあったもの:

- 契約: `startOAuth`（POST /v1/connections/oauth/start。検査は device_token・home_network・command_scope・unlocked・screen_operation・hub_screen）と `disconnectConnection`（expected_revision を含む）は OpenAPI と JSON Schema に定義済みで、Core 側の処理が無いため 503 で閉じていた。`OAuthStartRequest`・`OAuthStart`・`ConnectionDisconnectRequest` も定義済み。契約の変更はしていない。
- 保存: `connections`・`sync_scopes` の表（0001）、封筒の用途 `connection_account`（sealed_blobs の CHECK に含む）、`connection-targets-store` の list/get/update_targets、スケジューラと実行器（対象とトークンの出所が渡されなければ走査しない形）。
- domain: `initialFetchScope`（初期の取得対象。受信トレイだけ、添付は PDF とテキスト、期間は設計の初期値）。

新規に作ったもの:

- platform: OAuth トークンの KeyStore（`oauth-token-store.ts`）。
- storage: 接続の作成・封筒の読み取り・切断・再認可・再認可待ちの記録の op（`connection-targets-store.ts` に追加。新規マイグレーションは無し）。
- Core: プロバイダの口（`oauth-provider.ts`）、OAuth サービス（`oauth.ts`）、ループバックの戻り先（`oauth-callback-server.ts`）、core.ts／cli.ts の製品配線。

## 決めたこと

| 対象                         | 決定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| トークンの保存先             | OS の KeyStore に接続ごとの項目 `oauth-v1:<connection_id>` を作り、アクセストークン・更新トークン・失効時刻・取得スコープを JSON で置く（`@buddy/platform` の OAuthTokenStore。データ鍵・バックアップの鍵と同じサービス名 `dev.buddy.core` の別項目）。DB の `connections.credential_ref` には項目名だけを置く（ADR 0010）。バックアップの鍵と違いトークンは更新で値が変わるのが正常なので、書込みは上書きを許し、読み戻して確かめる。値は JSON・inspect・文字列化・ログ・例外・理由コードに出さない（OAuthTokens が伏せる）。削除は SecretSlot の任意の remove（キーチェーンの deletePassword）で行う                                            |
| 認可フロー                   | 認可コードフロー＋PKCE（S256）＋state（設計 04、ADR 0009）。`startOAuth` は認可 URL と失効時刻（10 分）だけを返し、state と code_verifier は Core のメモリにだけ置く（同じプロバイダの新しい開始は古い認可待ちを置き換える。state は 1 回だけ有効）。戻りは /v1 の外のループバック受付（既定 127.0.0.1:47445、`/oauth/callback`）が受け、交換・接続の作成までを Core が行う。応答の文面は固定で、アカウント識別・トークン・コードを出さない。待ち受けはループバック以外を拒否する                                                                                                                                                                 |
| プロバイダの口               | `oauth-provider.ts` の `OAuthProviderPort`（認可 URL の組み立て・コード交換・更新・失効）。実プロバイダ向けの実装は Google と Microsoft（テナント既定 common）で、輸送は node:https のフォーム送信（差し替え可能）。埋め込みのクライアントシークレットは使わない（公開クライアント、設計 04）。クライアント ID は呼び出し側の設定（CLI は環境変数 `BUDDY_GOOGLE_OAUTH_CLIENT_ID`・`BUDDY_MICROSOFT_OAUTH_CLIENT_ID`・`BUDDY_MICROSOFT_OAUTH_TENANT`）。設定の無いプロバイダの `startOAuth` は 503 で閉じる                                                                                                                                        |
| アカウント識別               | コード交換の応答の ID トークンのクレームから取る（Google は `sub`、Microsoft は `oid`＝Graph の readAccount の account_id と一致。Microsoft の個人／職場・学校は `tid` から判定し、個人テナントの ID は定数で持つ）。ID トークンはトークンエンドポイントから TLS で直接受け取ったものなので署名は検証せず、ペイロードだけを読む（第三者のトークンは扱わない）。識別（account_id・メール・表示名・テナント・種別）はデータ鍵で封をして sealed_blobs（用途 `connection_account`、所有者 connections・内容版 0）に置き、平文では保存しない                                                                                                           |
| 重複接続の扱い               | 認可の完了時に、同じプロバイダの切断済みでない接続の封筒を開けて account_id を照合する。一致すれば再認可として、トークンを置き換え、接続を active に戻し、許可版を 1 つ上げる（対象・取得集合・取得範囲の版は触らない）。一致しなければ新しい接続を作る。切断済みの接続に一致しても再認可では戻さず、新しい接続を作る（切断は本人の明示の操作なので、裏で復活させない）                                                                                                                                                                                                                                                                           |
| 接続の作成（保存）           | `connections.create` の 1 つの transaction で、封筒の行・接続の行（状態 active、許可版・取得範囲の版は 1）・取得集合の初期行を入れる。取得集合は資源種別ごとに 1 つ（mail・calendar、設計 11 §1A）で、ID は `scope:<connection_id>:<resource>` の規約（保存の表に資源種別の列は無いので、ID の規約と targetsFor の対応で結び付ける）。初期行は scope_revision 1・pending_full 1（最初の走査は全量。U207 の考え方と同じく、作った直後は全量照合が要る）                                                                                                                                                                                            |
| 初期の取得対象               | domain の `initialFetchScope` をそのまま使う。受信トレイ（Google はラベル `INBOX`、Microsoft はフォルダー `inbox`）だけが初期選択で、カレンダーは未選択（本人が接続画面で選ぶ。広げる既定値は作らない）。期間・添付の上限は設計の初期値                                                                                                                                                                                                                                                                                                                                                                                                           |
| 切断                         | `disconnectConnection` の処理を OAuth サービスが持ち、版の照合は既存の仕組み（CONNECTION_REVISION_CHECKED_ROUTES に経路を足し、api-connections の revisionMatches を共用）で行う。保存は `connections.disconnect`（許可版の CAS。状態を disconnected にし、credential_ref を NULL にし、有効な走査を abandoned にして保留フラグを消す。すでに切断済みで版が合えば冪等に成功）。後処理としてプロバイダ側の失効（Google のみエンドポイントがある。Microsoft は v2 に相当する口が無いのでローカルの削除が正本）と KeyStore の項目の削除をベストエフォートで行う（失敗しても切断は成立）                                                              |
| トークンの出所（実行器向け） | OAuth サービスが `tokenSourceFor`（Google）・`graphTokenSourceFor`（Microsoft）・`targetsFor` の既定を用意し、core.ts は sync 側の明示が無ければこれを使う（CLI は常に OAuth を渡すので、接続があればスケジューラは実スキャンまで行う）。失効まで 60 秒を切ったら更新トークンで取り直して KeyStore へ書き戻す（新しい更新トークンが返らなければ旧値を保つ）。プロバイダが拒否したら（invalid_grant 等の恒常的な失敗）接続を `needs_reauth` に落とす（`connections.mark_needs_reauth`。許可版は上げない）。一時的な失敗では状態を変えない。Microsoft は予定の読み取りが無いので、targetsFor はメールの対象だけを返す（取得集合の行自体は両方ある） |
| 保持期間の入口               | `oauth-provider.ts` の輸送は node:https で、保持期間の入口の一覧（retention-entries）の目印（fetch・@buddy/connectors・Provider の型）には当たらないため、表への追加はしていない。実質としても、トークンエンドポイントへ送るのは認可コード・更新トークンだけで、個人の内容（メール・予定の本文）の読み取り・送信はしない。更新はゲートを通した実行器の呼出しの中か、本人の画面操作（接続の作成）の流れでのみ起きる                                                                                                                                                                                                                                |

## 試験

- platform: トークンの KeyStore（読み書き・回転の上書き・削除・形式不正・伏せ字）8 件。
- storage: 作成（封筒・取得集合の初期行まで 1 回で入ること）・重複の拒否・切断（CAS・冪等・保留フラグの消去）・再認可・再認可待ち、計 5 件を追加（既存 10 件と合わせて 15 件）。
- Core: プロバイダの口（スコープ表・認可 URL・クレームの写し方・失敗の写し方）6 件、戻り先の受付 2 件、サービス（作成の一連・再認可・切断・更新と再認可待ち）6 件。すべて模擬・偽物で、実アカウント・実 API は使っていない。
- 全体の検証（静的検査と CI 方式 4 シャード逐次）は PR の報告に付ける。

## 残件（本人の手順を含む）

- 実アカウントの接続: (1) Google Cloud で OAuth クライアント（デスクトップアプリ）を作り、クライアント ID を得る。(2) Microsoft は Azure のアプリ登録（個人・職場の両方を対象、リダイレクト URI は `http://127.0.0.1:47445/oauth/callback` のループバック）を行う。(3) ハブ（Mac mini）の起動環境に `BUDDY_GOOGLE_OAUTH_CLIENT_ID`・`BUDDY_MICROSOFT_OAUTH_CLIENT_ID` を設定して Core を起動する。(4) デスクトップの接続画面（B09-05）から接続を開始し、システムブラウザーで認可する。以上の外部設定と実認可は本タスクの範囲外（モック範囲）とした。
- 接続画面（B09-05、ADR 0142）との統合: 本 ADR は現行 main を正として実装した。B09-05 側の契約・api-connections の変更と重なる場合は、統合時に契約を正として突き合わせること。特に ConnectionSummary の `graph_account` は B09-05 側の表示用で、本 ADR の作成経路は値を入れていない（封筒には account_kind を保存してあるので、必要になれば読み取り時に付ける）。
- 試運転インスタンス（Muse の VM、Buddy-run）への適用: main の取り込み後に Core を再起動し、ブリッジを再ペアリングする（模擬の鍵保護では再起動で証明書が変わるため）。VM には OS のキーチェーンが無いので、トークンの KeyStore は模擬（メモリ上）になり、再起動で接続のトークンは消える（接続の行は残り、トークンの出所が needs_reauth に落とす）。試運転の範囲では実アカウントを接続しない。
- Microsoft の失効はプロバイダ側の口が無いため、切断はローカルの削除まで（プロバイダ側のセッションは残る）。Google の revoke が失敗した場合も同様にローカルの削除が正本。

## 追補（2026-11-23 の実 API 検証で判明: Google のクライアントシークレット）

- 判明したこと: 2026-11-23 の実接続で、Google のトークンエンドポイントがコード交換を拒否した。合成のダミーコードで直接確かめると `invalid_request`（client_secret is missing）が返る。Google の OAuth クライアント（デスクトップアプリ型）は、PKCE を使ってもトークン交換と更新で `client_secret` を要求する。
- 改める点: 「プロバイダの口」の「埋め込みのクライアントシークレットは使わない」を、Google についてだけ改める。Google の口（`createGoogleOAuthPort`）は任意の `clientSecret` を受け取り、設定されている場合だけコード交換（`grant_type=authorization_code`）と更新（`grant_type=refresh_token`）のフォームに `client_secret` を載せる。未設定なら従来どおり載せない。失効（revoke）には載せない。Microsoft は公開クライアント（シークレット無し）が正なので変えない。それ以外の決定（PKCE・state・ループバック・トークンの保存先）は変えない。
- 供給と露出: シークレットの供給はハブの起動環境の環境変数 `BUDDY_GOOGLE_OAUTH_CLIENT_SECRET` だけとする（CLI がクライアント ID の隣で読み、core.ts の Google の設定 `clientSecret` を経て口へ渡す）。DB・KeyStore・ファイルには保存しない。口の中ではプライベートフィールドにだけ置き、ログ・例外・理由コード・JSON・inspect に出さない。Google はデスクトップ型のシークレットを機密として扱わない（配布物に含まれる前提）としているが、Buddy は値を最小限の経路（環境変数 → 口 → トークンエンドポイントへの TLS 送信）にだけ通す。
- 試験: `oauth-provider.test.ts` に 4 件追加（Google: 設定時に交換・更新のフォームへ載り失効には載らないこと、未設定・空文字では載らないこと、口の JSON・inspect・文字列化に値が出ないこと。Microsoft: 交換・更新のフォームが従来の全項目どおりでシークレットを含まないこと）。期待値は手書きで、シークレットは合成値。実 API への接続試験は本追補の範囲外（実接続での再確認は本人の手順）。
- 本人の手順の更新: 「残件」の (1) で Google Cloud のデスクトップアプリ型クライアントから、クライアント ID に加えてクライアントシークレットも得る。(3) でハブの起動環境に `BUDDY_GOOGLE_OAUTH_CLIENT_SECRET` も設定する。

## 追補（子プロセスの環境から消すこと）

- 判明したこと: `createNodeCommandRunner`（`packages/platform`）は `execFile` に環境を渡さないため、子プロセス（tailscale、macOS の security・launchctl など）は親の環境を受け継ぐ。CLI が起動の環境変数から読んだシークレットを `process.env` に残すと、子プロセスから見える。
- 改める点: CLI は `BUDDY_GOOGLE_OAUTH_CLIENT_SECRET`（と ADR 0178 の `BUDDY_GEMINI_API_KEY`）を `start` の最初に読み、直後に `process.env` から消す（`apps/core/src/cli-secrets.ts` の `takeStartupSecrets`）。読んだ値は Google の設定にだけ渡す。
- 限界: Linux の `/proc/<pid>/environ` は起動時の環境を見せ続ける。同じ利用者の別のプロセスからは読めるので、環境変数で受け取る方式では防げない（防ぐなら KeyStore に置く方式で、U373 で本人が決める）。
- 試験: `cli-secrets.test.ts` で、消す前の子プロセスには名前が見え、消した後は実機用 runner の子プロセス（`node -e`）の環境に名前も値も出ないことを確かめた。模擬の試験だけで、実機の tailscale・security・launchctl では未実施。

## 追記（2026-11-28、[ADR 0202](0202-windows-core-key-protection-dpapi.md)）

- 本人の決定（2026-11-28）で Windows の中枢を使えるようにした。Windows の OAuth のトークン（`oauth-v1:<connection_id>`）は DPAPI（CurrentUser）で保護し、`%LOCALAPPDATA%\Buddy\key-store` の下に接続ごとに 1 ファイルで置く（`createWindowsDpapiOAuthTokenStore`）。上書き・読み戻し・削除（無ければ成功）の性質は変わらない。DB・バックアップにトークンを入れない（ADR 0010）ことも変わらない。
- 資格情報マネージャーは 1 項目の上限（2560 バイト）が小さく、Microsoft のアクセストークンが収まらないおそれがあるため使わない。
- PowerShell の子プロセスも親の環境を受け継ぐ。上の追補のとおり CLI は起動のシークレットを `process.env` から消してから鍵を扱うので、子プロセスには渡らない。
