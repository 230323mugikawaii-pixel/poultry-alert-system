# PR04 — desired/observed と監視区間（追加のみ・既定 off）

実施日: 2026-09-24。基準 main: `b39c6ea4c472e7a12cbb991781d7f9760c70c821`。
作業ブランチ: `phase2/monitoring-state-20260924`。
以下は今回のコードを実行した結果であり、設計資料や以前の実機結果の流用ではない。

## 実装・安全境界

- `MonitoringState` / `MonitoringEpoch` の2テーブルと enum を追加。既存の列・データ・migration・一意制約は変更しない。
- `MONITORING_STATE_MODE=off|shadow`、既定 **off**。off では新テーブルを一切参照しない。新テーブル未作成の旧 schema でも、既存ジョブ処理が従来どおり完了することを実PGで確認。
- DBのみの `MonitoringStateService`。利用者意思の `setDesired` とシステム観測の `observe` を分離。外部I/O・既存 status/cursor の更新・認証情報の更新はない。呼出しスコープは connection / Team / MailAuthorization ID の一致を検査。
- 利用者による明示的な開始・再開だけが revision+1 の新 epoch を開く。重複した開始は no-op。停止・接続解除は開いている区間を閉じる。キーワードと既存 cursor は開始時点の snapshot として新テーブルにのみ記録する。
- invalid_grant / HTTP 401 は observed=AUTH_REQUIRED のみ。desired・epoch は変更しない。OAuth復旧は observed=UNKNOWN（認証復旧だけで HEALTHY と断定しない）。認証失効中の区間も保持する。
- `recoveryFrom` は未解消の最古時点を維持。`coverageKnownFrom` は証明なしに設定しない。実際の History recovery は追加していない。
- `[startedAt, endedAt)` の受信時刻判定を提供。停止中の受信区間は再開後も対象外。最初の epoch より前／履歴不明は UNKNOWN。ここでの IN_EPOCH は**時刻上の所属**だけで、現在の配信許可ではない。既存 Gmail の通知判定へはまだ接続しない。
- SERIALIZABLE、既存接続行→状態行のロック順序、expectedGeneration による CAS、DB の connection/revision UNIQUE・開いた epoch 最大1件・非負区間/世代 CHECK を使用。古い世代の成功/失敗観測を拒否する。通常時刻はロック取得後のDB時計。`at` は内部の試験用時計指定で、HTTP受付口はない。
- GmailJobWorker の shadow は読み取り専用の参考情報。desired/observed によるルーティング変更なし、欠落・参照失敗でも LEGACY 処理を妨げない。ログは状態 enum・generation・安全な結果種別のみ。既存 PAUSED / REAUTH_REQUIRED の保留処理は変更しない。
- GmailMonitoringService、Alert生成、Outbox dispatcher、通知、OAuth本体、Frontendは未変更。

## 設計との相違・今回入れないもの

1. 設計案の `MonitoringEpoch.evaluations` / `MailEvaluation.monitoringEpochId` は今回は追加しない。利用者指定の「2テーブルだけ」「既存テーブル追加列なし」「downは新table/enumだけ」を優先し、判定経路との接続PRへ延期。MailConnectionへの逆リレーションだけ追加し、既存DB列は増やさない。
2. `MonitoringState.ingestionOwner` の型として、設計にある `IngestionOwner` enum も追加（計3 enum）。LEGACY既定のまま。LIVE切替、DB列 `shadowEnabled` の有効化、所有権移譲は未実装。
3. UI開始/停止・OAuthエラーへの書込フックは今回は接続しない。既存状態を推測して移行せず、新テーブルの初期行数は0。shadow参照だけでは初期化せず MISSING。状態変更は新しいDBサービスのテスト呼出しで検証する。
4. OAuth credential version fencing、reconciliation、合成監視、health、MailSyncStream、ProviderRegistration 等は未実装。今回の generation は新しい監視状態の競合排除であり、それらの実装を意味しない。
5. 区間の重複防止は SERIALIZABLE の専用writer・明示的な重複検査・開区間のDB UNIQUEによる。任意のDB直書きを許可する汎用区間管理APIではない。

## Migration と隔離

新規: `20260924000100_monitoring_state_epochs`（28番目）。先行27件は不変。

- 新設PG17コンテナ `call-now-monitoring-pr04-pg17-20260924` のみ使用。loopback専用ポート25443、独立tmpfs、合成データ。通常/E2E/本番DB・既存volume未使用。
- 先行27 migration適用済みの隔離DBと schema の Prisma migrate diff --script から create-only相当で生成して確認後、追加オブジェクトだけのCHECK/partial UNIQUEを追記。
- upはCREATEと**新テーブルに対する**制約追加のみ。既存テーブルのALTER、データ書換え、DROP/TRUNCATEなし。
- 隔離管理DBの Prisma migrate deploy: **28/28、pending 0**。Prisma validate / generate / db:check-drift: **PASS、差分なし**。
- 一意な使い捨てDBで「先行27件＋合成既存データ → up → 新モデル状態遷移 → down → up」を実行: **PASS**。既存全テーブルのデータ・列・制約・indexをハッシュ比較して不変。
- downは `apps/api/tests/fixtures/monitoring-state-down.sql`。新規2table・3enumだけ削除、CASCADEなし。最終up後の新テーブルは0件。
- round-trip DBはSQL直接適用のためPrisma履歴テーブルを作らず、履歴の手書き修正もしない。管理DBのPrisma履歴はPrismaによる正常適用を読取確認するだけ。通常のPrisma deployには自動down機能を追加しない。
- 試験終了時に削除するのはその試験が新規作成した一意DBだけ。稼働DB reset/dropなし。

## 今回の実測結果

| 実行 | 結果 |
|---|---|
| `pnpm test:postgres:monitoring` | **19/19 PASS**、2ファイル、2.26秒 |
| `pnpm test:postgres` | **30/30 PASS** |
| `pnpm test:postgres:ledger` | **17/17 PASS** |
| `pnpm test:postgres:outbox` | **19/19 PASS** |
| `pnpm test:postgres:dispatcher` | **14/14 PASS** |
| `pnpm test:postgres:jobs` | **22/22 PASS** |
| `pnpm verify` | **PASS**: Frontend 128件、API 284件、format/lint/typecheck/build。PG専用121件のskipは上の専用コマンドで全件別実行 |
| `pnpm db:validate` / `db:generate` / `db:check-drift` | **PASS / PASS / driftなし** |
| `git diff --check` | **PASS** |
| production dependency audit | **既知の脆弱性0件** |
| 変更25ファイルの限定secretパターン検査 | **検出0件**。秘密鍵・主要token形式を対象とし、網羅的secret監査ではない |

`verify`初回は新規テスト1ファイルの整形違反で停止。整形のみ修正して、上表の全体再実行に成功。

主要な新規試験名・証拠:

- `INVALID_GRANT / HTTP_401 preserves desired and open epoch`: 認証失効→復旧でも同じepoch、desired不変、認証失効中の受信時刻も区間内。
- `pause gap remains excluded after resume`: 開始・停止・再開それぞれの前後1msと境界そのものを検証。停止gapは再開後も OUTSIDE_EPOCH。
- `only explicit user intent creates epochs`: 開始の重複でrevision/snapshotは変わらず、次の明示再開のみ新revision。
- PAUSED/DISCONNECTEDの認証失効・復旧、RECOVERINGの最古点保持、HEALTHY/DEGRADED/UNKNOWN、未知履歴・不正時刻も確認。
- `concurrent 100 starts and 100 resumes`: 各100並行で APPLIED 1 / STALE 99。最終epoch2件（revision1/2）、開いたepoch1件、generation3。
- `competing user pause and auth failure`: 同世代競合で片方のみ成功、復旧後の古い認証失敗を拒否。明示的な再読込後の再試行は正常適用。
- `rejects backdated transitions...`: 時刻逆行、負の区間、revision重複、2つ目の開区間、負generationを拒否。
- `[t,t)` と同一ms再開: tは閉じた空区間に属さず、新区間だけに属する。
- Team/mailboxの不一致は参照/更新不可。既存テーブルの内容は状態遷移後も不変。
- worker off/shadow比較: 新モデルがDISCONNECTEDでも旧ACTIVEを変えず、どちらも台帳1・評価1・Alert1・宛先2・監査1・Outbox2。参照の例外でも旧結果不変。
- migration試験: 新テーブルの存在しない旧schemaでも全offメソッドはDBアクセスなし、旧workerが完了。up/down/up・旧schema/データ不変。

## 変更ファイル一覧

- DB: `apps/api/prisma/schema.prisma`、上記新規migration、`apps/api/tests/fixtures/monitoring-state-down.sql`。
- 実装: `apps/api/src/modules/mail/reliability/monitoring-state-service.ts`、`monitoring-state-reference.ts`、`gmail-job-worker.ts`。
- 設定/接続点: `apps/api/src/config/env.ts`、`apps/api/src/cli/gmail-process-jobs.ts`、`.env.example`。
- 新規試験: `apps/api/tests/monitoring-state.test.ts`、`monitoring-state.postgres.integration.test.ts`、`monitoring-state-migration.postgres.integration.test.ts`、`fixtures/monitoring-test-database.ts`。
- 既存試験の型/隔離名対応のみ: `fixtures/mail-ledger-harness.ts`、`alert-routes.test.ts`、`app.test.ts`、`auth-routes.test.ts`、`google-auth-routes.test.ts`、`mail-connection.test.ts`、`team-routes.test.ts`、`user-communication-routes.test.ts`。
- 実行/記録: ルートとAPIの`package.json`、`.github/workflows/ci.yml`、本書。CIにはPG17での新規試験とphase2ブランチの検証を追加。デプロイworkflowは変更せず、手動起動もしない。

## 未実行・停止位置

- 新モデルによる実際のGmail判定経路切替、利用者UI/OAuthフックとの接続、実Google/Graph/APNs/PubSub、実メール、実機E2E: **未実行・今回対象外**。
- 新モデルで停止中受信を除外する試験はDB状態モデルの結果であり、新しい本番通知経路の成功証拠ではない。
- 稼働環境のflag変更、稼働DB適用、main merge、デプロイ、クラウド変更: **未実行**。
- 最新commit ID、PR、CI結果はPR報告へ記録し、PR04の結果報告で停止する。
