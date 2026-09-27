# Staging基盤構築結果 — 2026-09-27

## 到達点と停止位置

承認された低負荷・オンデマンド構成で、既存Call Nowとは別のGoogle Cloudプロジェクトに
DB、API、migration job、dispatcher、配信workerを配置した。
**実APNs transportを含むイメージであり、Fakeを実配送として代用していない。**
ただしdispatcherと配信workerはOFF・実行0件。実Apple接続、実`.p8`使用、実Push、実メール送信は未実施。
実機でログイン・端末登録・Push受信できる完成状態とは区別する。

- 作業ブランチ: `staging/cloud-run-20260927`（専用worktree）
- 基点main: `376e9d94865bd84d9ed9c142e2c094dff0175363`（PR #37取り込み済み）
- 組み込んだPR #40: `b63ea514a066a7c2ecc4c6667cfa63624e1944b9`
- 配備した実装commit: `2e4a29207fdfebdec11a9962cbf2733a17385af0`
- #38/#39/#40のコードはこの検証ブランチにのみ統合。mainや既存PRブランチは変更しない。
- 既存iOS作業ツリーの変更6ファイルはそのまま保持。本番・通常・既存E2E DBは非変更。

## 接続先と実リソース

API base:
`https://call-now-staging-api-404996456750.asia-northeast1.run.app`

これはAPIのURLであり、Frontend画面のURLではない。

| 項目              | 実際の構成・結果                                                                  |
| ----------------- | --------------------------------------------------------------------------------- |
| 専用project       | `call-now-staging-20260927` / Call Now Staging / ACTIVE                           |
| リージョン        | `asia-northeast1`（東京）                                                         |
| API               | Cloud Run `call-now-staging-api`、1 vCPU / 512 MiB、min 0 / max 1、concurrency 20 |
| 配備revision      | `call-now-staging-api-00003-wc4`、traffic 100%、Ready                             |
| API公開           | 標準HTTPS URLから到達可能。アプリ認証・Origin検証を維持                           |
| SQL               | `call-now-staging-db`、PostgreSQL 17 / Enterprise / db-g1-small / single-zone     |
| 保存領域          | SSD 10 GiB、自動拡張上限20 GiB                                                    |
| 保護              | 日次backup・7世代、削除保護ON、ENCRYPTED_ONLY、authorized networksなし            |
| DB                | `callnow_staging`。既存DBのコピーではない、新規の空DB                             |
| DB権限            | migration / API runtime / workerのSQLロールと実行SAを分離                         |
| Secret Manager    | 新規staging専用DB接続情報・auth pepper。version 1を明示参照                       |
| KMS               | staging専用software鍵。APIは暗号化/復号、push workerは復号権限                    |
| Artifact Registry | `call-now-staging`、linux/amd64 API・migration image                              |
| 定期実行          | Schedulerなし。dispatcher/workerは検証時だけ起動するJob                           |
| Frontend/IAP      | 未配備。Pages再公開なし                                                           |

Cloud SQLはCloud Run組込connector経由。VPC connector / NAT / LBは作成していない。
service account秘密鍵ファイルは作成していない。
新規bootstrap管理jobは役割を終えたため削除し、管理DB secret versionは**破棄せず無効化**した。
管理jobへの一時的な追加secretアクセス権も除去した。既存リソース・既存データの削除はない。

## イメージとJob

Registry prefix:
`asia-northeast1-docker.pkg.dev/call-now-staging-20260927/call-now-staging`

- API / dispatcher / push: `api:2e4a292`
  - digest: `sha256:558746465aca5104e25c5f375c7ecbe51bdec060aa61d67dc0360a510b8282bb`
- migration: `migration:aaf7f9b`
  - digest: `sha256:6508435e88e7ffb84c002e2df7a668d6ed7accc3723864bfb78ddc3b37f90c8b`
  - この後の変更は起動補助・health aliasのみ。schema/migrationは同一。

| Job                             | 状態                                                                 |
| ------------------------------- | -------------------------------------------------------------------- |
| `call-now-staging-migrate`      | 実行 `call-now-staging-migrate-ttpc4` 成功。新staging DBだけに適用   |
| `call-now-staging-schema-check` | 実行 `call-now-staging-schema-check-rzv6j` 成功。statusとdriftを確認 |
| `call-now-staging-db-inspect`   | 実行 `call-now-staging-db-inspect-2sr5w` 成功。件数だけを出力        |
| `call-now-staging-dispatcher`   | Ready、実行履歴0件、`RELIABILITY_OUTBOX_DISPATCH_MODE=off`           |
| `call-now-staging-push`         | Ready、実行履歴0件、`MOBILE_PUSH_DELIVERY_MODE=off`                  |

両workerはtasks 1 / parallelism 1 / max retries 0 / timeout 300秒、CLIは`--once`。
一回の起動は一処理単位であり、継続配送や常時稼働を保証する構成ではない。
dispatcherのmobile plannerは`apns`設定（資格情報なしではmissing）、主フラグOFFで処理されない。
pushはOFFなのでDB/transportの構築前に終了する。
将来の送信承認時には`shadow`（Fake）ではなく`apns`を明示して使用する。
`APNS_ENVIRONMENT=sandbox`、Bundle IDは`com.callnow.poultryalert`。Apple秘密鍵・Key ID・Team IDは未設定。
JobのReadyは設定受理であり、実送信やCloud上のworker処理成功の証拠ではない。

## 実測確認

| 確認                                          | 結果                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /health`                                 | HTTP 200 / `ok:true`                                                        |
| `GET /ready`、`GET /readyz`                   | HTTP 200 / `ok:true`（DB接続含む）                                          |
| `GET /healthz`                                | Google側の404。下記参照                                                     |
| auth / onboarding providers                   | HTTP 200。Google/Microsoft/AppleはNOT_CONFIGURED                            |
| OWNER / MEMBER me（Cookieなし）               | 各HTTP 401 / UNAUTHENTICATED                                                |
| push-devices登録（正しいOrigin、sessionなし） | HTTP 401。実端末トークンなし、登録なし                                      |
| push-devices登録（別Origin）                  | HTTP 403 / ORIGIN_NOT_ALLOWED                                               |
| CORS                                          | 許可Originは上記API baseのみ、credentials=true、wildcardなし                |
| 別Originのpreflight                           | 204でもallow-originは許可済みURLのまま。別Originに一致せずブラウザは拒否    |
| staging migration                             | 29/29、pending 0、失敗0                                                     |
| staging drift                                 | なし（diff exit 0）                                                         |
| stagingデータ件数                             | users / mail_authorizations / alerts / outbox / deliveries 全て0            |
| runtime / migration image                     | build成功、amd64、非root `node` / UID 1000                                  |
| OFF CLI（ローカルimage、network none）        | DB/transportを作らず終了                                                    |
| `pnpm db:validate` / `db:generate`            | PASS                                                                        |
| `pnpm verify`                                 | PASS。API unit 371 PASS。Frontend / format / lint / typecheck / buildもPASS |
| 隔離PostgreSQL 17統合                         | 173 PASS（内訳は下記）                                                      |
| staging接続先guard test                       | 2 PASS。既存project、別DB、別role、productionを拒否                         |
| `git diff --check`                            | PASS                                                                        |
| GitHub CI                                     | この新stagingブランチでは未実行。ローカルverifyと区別                       |

Cloud Runには一部の`z`終端パスが予約される制限があるため、既存`/healthz`・`/readyz`は残して
同じhandlerの`/health`・`/ready`を追加した。公開監視には後者を使用する。
[Google Cloud公式: Reserved URL paths](https://docs.cloud.google.com/run/docs/known-issues#reserved-url-paths)

PostgreSQL内訳: baseline 30 / ledger 17 / outbox 19 / dispatcher 14 / jobs 22 /
device 16 / delivery 19 / apns-worker 21 / apns mock 15 = **173 PASS**。
今回新規のtmpfs PostgreSQL 17コンテナを使用し、既存DBは使っていない。
初回専用suiteはDB名/隔離ACKの安全ガードで拒否されたため、既存の承認済みテスト命名規則とACKで
使い捨てDBを用意して全suiteを再実行した。ガード・期待値の緩和なし。
この173件は`27b81bf`時点、以後のhealth alias変更はDB/workerに影響せず、
最終`2e4a292`で関連route testとverify全体を再実行した。
APNs試験はローカルHTTP/2モックのみ。実Appleへの接続をしていない。
verify内でskipされるPG173件は別途上記で実行済み。使い捨てコンテナだけを終了・削除した。

## 追加変更

- `.dockerignore`: `.p8`等の秘密鍵・署名資材をimage contextから除外。
- `apps/api/Dockerfile`: staging限定のguard / migration / bootstrap補助を収録。
- `apps/api/src/config/env.ts`, `server.ts`: stagingに限り全3設定が明示空のOAuth providerを無効化。
  部分設定は拒否、本番の必須検証とKMS必須は維持。ダミー資格情報やdevelopment設定で回避しない。
- `apps/api/src/routes/system.ts`, `tests/app.test.ts`: 非予約health aliasesと回帰試験。
- `apps/api/tests/env.test.ts`: staging無効化、部分設定、production等の回帰試験。
- `infra/cloudrun/staging/{guard.mjs,guard.test.mjs,bootstrap.mjs,prisma-runner.mjs,api.env.yaml}`:
  project/DB/roleを固定した安全ガード、新規DB専用初期化、安全なPrisma結果出力、秘密値なしruntime設定。
- `.gitignore`: mainと#40の統合時に双方の除外規則を保持。
- 本報告書。

schema・migration・APNs送信実装・既存Gmail処理・iOSソースは今回変更していない。
本ブランチへのpushは自動デプロイを起動しない。CIはmain/phase1/phase3のpushとPRが対象、
Deploy APIはworkflow_dispatchのみ。今回GitHub deploy workflowは実行していない。

## 未完了・次の承認ポイント

1. **staging専用OAuth・ログイン導線**: 既存本番/E2E OAuthは流用・変更していない。
   Googleログイン、Gmail連携はNOT_CONFIGURED。必要な専用client/callback設定と本人同意が必要。
2. **iPhoneネイティブ認証の契約整合**: #43のnative PKCE backendはこのimageに未統合。
   現在のiOSアプリからのログイン・Cookie/Origin・端末登録E2Eは未確認。レビュー済み組合せを選ぶ必要がある。
3. **実APNs資格情報と実機**: `.p8`をチャットやgitへ入れずstaging Secret Managerへ安全に投入し、
   Key ID / Team ID / Bundle ID / sandbox署名・端末トークンの一致を確認する。別承認まで実施しない。
4. **実Push**: テストprincipal・端末・通知予約を準備してから、承認済みの1件だけをオンデマンドで検証。
   受理と端末表示/実音は別判定。既存WAITING_CONFIGURATION行を自動成功扱いにしない。
5. **画面・Gmail全経路**: Frontend/IAP、専用Gmail/PubSub、監視更新Job/Scheduler、SMTPは未構築/未設定。
   今回のiPhone向けAPI/DB/worker基盤とは別の残作業。Gmail監視はfalse、台帳/ジョブ受付もoff。
6. **リモートレビュー/CI**: 新stagingブランチのPR・GitHub CIは未実行。main統合は別承認。
7. **実端末からの到達**: 外部HTTPSクライアントでは確認済み。ユーザーのiPhoneでの到達・UI操作は未確認。

## 費用・運用・戻し方

- 承認済み見積: 低負荷・東京で月 **45〜55 USD**。これは2026-09-22の見積前提であり請求上限ではない。
  Cloud SQLが常時課金の中心。現在のAPIはmin 0、workerは手動一回実行、Frontend等は未配備。
- 今回、新projectだけを対象に**月8,800円**の予算通知を設定（50/80/100%）。
  円額は以前の説明用換算による通知予算であり、最新為替や強制停止を意味しない。
- クレジットや共有無料枠がなくても費用は発生する。SSEの長時間接続・アクセス増・image/backup増で上振れする。
  API max 1はインスタンス上限であって金額上限ではない。Apple利用料・将来追加infraの費用は含めない。
- 自動デプロイ・worker定期起動・本番反映は設定しない。検証を停止してもSQL/保存領域の費用は残る。
- API不調時は新staging内で旧revision `call-now-staging-api-00002-ghj` にtrafficを戻せる。
  ただし旧revisionでは公開`/health` aliasがない。DB reset/downは実施しない。
- dispatcher/pushは引き続きOFFで維持。DBやsecretの削除による費用停止は別承認。
- 本番API、本番DB、本番OAuth、既存ローカルE2E、Pages、mainには変更していない。

**停止位置: staging基盤と外部APIの確認まで完了。実機ログイン・実APNs送信の準備/実行前。**
