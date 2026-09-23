# PR03b — Gmail耐久受付・ACK（入力側）

実施日: 2026-09-23。対象ブランチ: `phase1/reliability-ledger-20260922`。
実装前HEAD: `d7fad9f86acd020cba7b0a52ac48a758bff3eabf`（03a）。
以下は今回の実装を実行した結果であり、設計ZIPの試験結果の転用ではない。

## 変更と境界

- `GMAIL_PUSH_JOB_MODE=off|durable`、既定off。offでは旧「処理完了後204」を維持し、ジョブテーブルへアクセスしない。
- durableは既存Push監視有効＋`MAIL_LEDGER_MODE=legacy-outbox`を必須とし、設定不整合は起動拒否。
- 既存OIDC認証・JSON/envelope検証後、SERIALIZABLE TXで`ReliabilityJob`を耐久保存してから204。保存失敗は安全な固定エラーコードで503。Gmail APIは受付TX内・受付ハンドラ内では呼ばない。
- 冪等キーはSHA-256(JSON配列`["gmail-push-job-v1", configuredTopic, exactPubSubMessageId]`)。DB UNIQUE＋`INSERT ... ON CONFLICT DO NOTHING`。既存ジョブの状態、試行回数、対象、時刻は再送で初期化しない。同じキーでイベントfingerprintが違えば503。
- payloadはversion、historyId、イベントfingerprint、受付時点の既存connection/mailbox/Team IDだけ。メールアドレスは既存DBとの照合にのみ使用し、ジョブに保存しない。本文・添付・token・接続URLは保存/ログ出力しない。余分なJSONフィールドはアプリ検証とDB CHECKで拒否。
- 別CLI `pnpm mail:gmail:process-jobs`（`--once`対応）。暗黙の.env読み込みなし、明示runtime設定のみ。offならDB/provider構築前に終了。今回はdurable CLIを実接続設定で起動していない。
- SYNCジョブをSKIP LOCKED＋lease token/generationでclaim。READY/RUNNING/RETRY_WAIT/BLOCKED/DONEを使用。lease既定120秒、リトライ1秒から倍増・最大300秒、10試行で失敗したジョブはBLOCKEDとして保持。
- 外部I/OはDB再試行TXの外。現在のTeam・契約・接続・認証・紐付けを再検査し、既存`GmailMonitoringService.syncConnectionById`へ接続する。providerCursor進捗も確認し、既存サービスが再認証要求を記録してreturnしただけではDONEにしない。
- 03a Outbox dispatcher/transport、Gmail監視/判定/Alert生成の既存本体、Outbox固定payload CHECKは変更していない。

## 設計との差分・意図的な限定

1. 汎用ジョブ案のうち`SYNC`だけを採用。EVALUATE/RECONCILE/RENEW/監査/合成送信は未実装。受信イベントごと1ジョブで、メッセージごとの処理は既存LEGACY経路のまま。
2. 再送時に別の接続へ付け替えないため、最初の受付で対象ID集合を固定する（上限500、超過時503）。既知のPAUSED/REAUTH_REQUIREDも対象IDとして保存するが、処理は許可しない。未処理として保持する。他の処理可能なTeamは継続する。
3. 対応する接続が全くない通知は空の対象集合で保存され、外部呼び出しなしにDONE。後から新設された接続へ過去イベントを付け替えない。
4. ジョブ完了と複数メールの判定を同一TXにはしない。クラッシュ再実行は既存sync lease、PR01/02bのDB冪等性に依存する。ジョブ完了更新は失効lease/古いgenerationを拒否するが、実行中のGmail HTTPを取り消す保証・外部exactly-once保証はしない。
5. DONEは既存LEGACY同期のcursor進捗確認（または既に進捗済み／対象なし）。全メールの評価正常完了、UNDETERMINED解消、履歴完全網羅、配信・既読・実音成功を意味しない。cursor/評価frontier分離はPR05、監視epochはPR04のまま対象外。
6. SSE起床ヒントは引き続きコミット後。CLI内のヒントはAPIプロセスへ直接届かないので、既存SSEの5秒DB pollingで反映する。新しい通知送信/配送基盤は追加していない。
7. BLOCKEDは消去せず保全するが、運用再投入UI/自動再認証/ジョブ整理は今回追加しない。durable受付のみ有効化してworkerを起動しなければ処理は滞留する。今回は稼働環境のflagもworkerも変更していない。

## Migration

追加: `20260923000300_gmail_durable_jobs`（27番目）。テーブル1、enum2、index3、制約、識別子payload検証関数。既存migration不変。

- 新設の隔離PG17コンテナ `call-now-jobs-pr03b-pg17-20260923` のみ使用。loopback専用ポート25442、独立tmpfs領域、合成データ。既存の通常/E2E/本番DB未使用。
- 専用管理DBにPrisma migrate deploy: **27/27、pending 0**。
- 別の一意な使い捨てDBで、先行26件＋合成既存データ→up→down→up: **成功**。
- downは`tests/fixtures/reliability-jobs-down.sql`。新設table/function/enumだけを削除し、CASCADEなし。既存の全テーブルのデータ、列、制約、indexを前後比較して不変。
- round-trip用DBはSQLを直接適用し、Prisma履歴を捏造しない。管理DBの`_prisma_migrations`はPrismaが記録したものを読み取り確認のみ。
- Prisma validate / generate / migration diff: **成功、driftなし**。CHECK/functionはPrisma diffのみでなく実PG round-trip/不正payload拒否でも検証。
- suite終了時に削除するのは、そのsuiteが新規作成した一意DBだけ。既存DB・既存volumeのreset/dropなし。

## 今回の実測テスト

| 実行 | 結果 |
|---|---|
| `pnpm verify`（Frontend、format、lint、typecheck、API、build） | PASS。API 280 passed、PG専用102 skippedは下記で別実行 |
| `pnpm test:postgres` | 30/30 PASS |
| `pnpm test:postgres:ledger` | 17/17 PASS |
| `pnpm test:postgres:outbox`（02a/02b） | 19/19 PASS |
| `pnpm test:postgres:dispatcher`（03a） | 14/14 PASS |
| `pnpm test:postgres:jobs`（03b） | 22/22 PASS（6.84秒、migration試験を含む） |
| `gmail-jobs.test.ts`＋既存`gmail-pubsub.test.ts` | 29/29 PASS |
| 新CLIの既定off起動 | DB/providerアクセスなしで終了 |
| production dependency audit | 既知の脆弱性0件 |

主要なPR03b実測:

- 逐次100回＋並行100回、認証付きroute受付すべて204、ジョブ1件、ACK時点のGmail取得0・台帳/Alert/Outbox0。
- worker実行後、台帳1・評価1・Alert1・宛先2・ALERT_CREATED監査1・Outbox2。DONE後再送で保存済み行不変。
- 実PostgreSQLのread-only transactionによるINSERT失敗→503、ジョブ0、Gmail取得0。
- OIDC無し/不正audience/別service account/未検証email/期限切れ→401、ジョブ0。署名検証器だけテスト代替、既存authenticator/routeを使用。
- 不正envelope→400。DBが余分なpayloadフィールドを拒否。イベント衝突ガードも既存行を変更しない。
- **実SIGKILL**: commit後ACK前、親が別DB接続で保存済みREADYを確認して子を終了。再送あり/なし両方で新プロセスworkerがDONEまで復元、論理件数は上記のまま。
- **実SIGKILL**: 既存Gmail処理コミット後・job finish前に終了。自然lease失効を待ち別プロセスで回収、二重Alert/Outboxなし。
- 同時claim20件中1workerだけ取得。自然lease失効後の回収でgeneration増加、旧workerの完了更新拒否。
- PAUSED/REAUTH_REQUIRED、紐付け不一致、cursor未進捗はDONEにせず保留。複数Teamのうち処理可能な対象は進める。retry上限後はBLOCKED保持。
- off/既にabortしたworkerは未処理行を変更しない。jobテーブルの存在しない旧schemaでもflag off routeは旧Gmail処理後204。

## 変更ファイル

- 実装: `apps/api/src/modules/mail/reliability/{prisma-gmail-job-queue,gmail-job-worker}.ts`, `apps/api/src/cli/gmail-process-jobs.ts`。
- 組込み: `apps/api/src/{app,server}.ts`, `src/config/env.ts`, `src/modules/mail/gmail/gmail-pubsub-routes.ts`。
- DB: `apps/api/prisma/schema.prisma`, 上記新規migration、`apps/api/tests/fixtures/reliability-jobs-down.sql`。
- 新規試験: `apps/api/tests/gmail-jobs{,.postgres.integration,-migration.postgres.integration}.test.ts`, `fixtures/gmail-job-{harness,crash-child}.ts`。
- 既存fixture調整: `fixtures/mail-ledger-harness.ts`（実repo差し込みと隔離DB名）、環境object7試験（off初期値追加）、02b/03aのmigration件数固定前提を追加migration対応。
- 設定/記録: `.env.example`, 両`package.json`, `.github/workflows/ci.yml`, 本書。
- `later/`設計資料は参照のみ、未変更。

## 未実行・停止位置

- 実Google署名鍵/Cloud Pub/Sub/Gmail実メール/実ブラウザ/実通知配送のE2E: **未実行**。DBは実PostgreSQL、Google HTTPと署名検証器は試験代替。
- 稼働DB適用、クラウド設定変更、main merge、デプロイ、PR04以降: **未実行**。
- 最新コミットのCI結果とcommit IDはPR報告に記録する。PR03bの結果を報告して停止する。
