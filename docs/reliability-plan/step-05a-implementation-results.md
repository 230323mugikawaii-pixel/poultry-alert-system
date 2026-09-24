# PR05a — OAuthフェンシング基盤（独立・追加のみ・既定off）

実施日: 2026-09-24。基点: main `b39c6ea4c472e7a12cbb991781d7f9760c70c821`。
ブランチ: `phase2/oauth-refresh-fencing-20260924`。PR04 / #35には依存せず、その変更を取り込んでいない。
設計のalgorithms.md §6と今回の05a限定依頼を基準に実装・試験した。設計資料や以前のE2E結果の流用ではない。

## 変更と安全境界

- MailAuthorizationに指定の6列だけ追加: encryptedAccessToken / accessTokenExpiresAt / credentialVersion / refreshLeaseToken / refreshLeaseUntil / refreshLeaseGeneration。4列nullable、versionとgenerationはdefault 0。既存enum・PK・UNIQUEは不変。既存状態名はREAUTH_REQUIREDのまま。
- 新規 `oauth-fenced-refresh.ts` は、明示的に依存を渡すlazy factoryのみ。`OAUTH_FENCED_REFRESH_MODE=off|shadow`、既定off。offは依存factoryすら実行せず、新サービスを構築しない。
- **API、GmailJobWorker、watch更新CLI、Google/Microsoft adapter、OAuth/再認証/失効writerへ接続していない。shadowを設定しても既存経路はこのサービスを呼ばない。** 05aはFake Providerを用いた隔離DB上の基盤検証であり、実利用可という意味ではない。
- TX1はscope（authorization ID / user ID / provider）を一致確認しFOR UPDATE。有効なACTIVE資格情報だけを扱う。キャッシュTTLがDB時刻で厳密に5分超かつforceRefreshでなければ再利用。稼働leaseがあればDB時刻由来のretryAfterMs付きBUSY。空き/失効leaseならtokenを予約しgenerationを増加。
- 暗号化refresh tokenの復号、TokenProvider、戻り値の暗号化は**すべてTX/DB再試行の外**。既存TokenEncryptionProviderとLocal AES-GCMを再利用。今回KMSを含む外部サービスは呼ばない。
- TokenProviderに10秒deadlineとAbortSignalを渡し、実際のタイマーでも上限管理。abortは協力的取消であり、外部要求の取消保証とはしない。無視して遅れて返るPromiseにも保存処理を続行させない。
- TX2は捕捉credentialVersion / leaseToken / generation / DB時計によるlease期限に加えてscope・ACTIVE・未revokedを条件に更新。キャッシュ、必要ならrotated refresh tokenと暗号化情報、version+1、lease解放を1UPDATEで確定する。
- TX2が0行なら古いprovider結果を破棄。最新のDBキャッシュ/状態を読み直し、TOKEN / BUSY / STALE / UNAVAILABLEを返す。自動再refreshループは作らない。遅いキャッシュ復号中のversion変更も再確認してSTALEにする。
- timeout/暗号化/provider失敗は所有するversion/token/generationが一致するleaseだけ解放。credential・認証status・接続・監査は変更しない。解放時にDB障害があれば安全な固定エラーを返し、残ったleaseはDB期限後に回収できる。
- lease既定30秒。短い値は内部依存指定での期限切れ試験用。実稼働用のflag接続や設定画面は今回存在しない。
- 安全な固定例外コードのみ使用し、元のerror/cause/query/URL/provider本文は外へ返さない。アプリ内の戻り値には呼出元が使うアクセストークンを含むため、05bでも戻り値全体をログへ出してはならない。

## 設計との具体化・05bの必須前提

1. `encryptedAccessToken`には既存EncryptedTokenの `{ciphertext, provider, keyVersion}` をJSON化して保存する（plaintextなし）。アクセス用の追加メタデータ列は作らない。refresh tokenが回転しなかった場合、既存refreshの暗号鍵情報をアクセス用の新しい鍵情報で上書きしないため。異なる暗号鍵versionでのキャッシュ復号も試験済み。
2. `clock_timestamp()`は行ロック取得後に読む。TTL/lease/確定時刻はアプリ時計に依存しない。追加カラムの管理で旧updatedAtを更新せず、rotationがない場合の既存列不変も比較した。
3. 05aは失敗のREAUTH_REQUIRED化を実装しない。遅延invalid_grantによるstatus変更、全writerのversion整合、関連MailConnection/cursor/監査更新の抑止、401一度だけreplay、403分類は**05b未実装**。
4. 既存`include: { mailAuthorization: true }`は未変更。migration後には追加nullable列はnull、version/generationは0で既存の処理結果を保つ。ただし新列が物理的にSELECTされないことを保証するPRではない。**05bの明示selectハードニングとwriter保護が完了するまで実トークン経路へ接続禁止。**
5. 旧schemaで行うPR01/02b/03b migration試験だけ、テスト専用Prisma omit clientを使用する。新生成Clientのcreateが新しいdefault列を明示INSERTするため、共有合成seedの認証行INSERTは旧列のみのSQLへ変更。既存production Client/Repositoryの挙動は変更していない。
6. OAuth providerとDBは原子的にcommitできない。provider側でrotation成功後にプロセス/DB障害が起きた場合の自動復旧保証はしない。今回も実HTTP・実再認証を実行していない。

## Migration / 隔離

- 新設コンテナ: `call-now-oauth-pr05a-pg17-20260924`、PostgreSQL17、loopbackポート25444、独立tmpfs。既存通常/E2E/PR04/本番DB・既存volumeは使用/変更していない。
- migration: `20260924000200_oauth_refresh_fencing`。この独立ブランチでは28番目（先行27件＋本件）。#35のmigrationは含まない。
- create-only相当として、先行27件適用済みの隔離DBと変更schemaからPrisma migrate diff --scriptを生成。upは6つのADD COLUMNのみ。旧列変更、DROP/TRUNCATE、旧データUPDATEなし。
- 隔離管理DBへのPrisma migrate deploy: **28/28、pending 0**。validate / generate / drift確認: **成功・差分なし**。
- 一意な使い捨てDBへ先行27件＋合成既存データを用意し、**up→down→up成功**。全既存テーブルの旧列データ・列定義・制約・indexをハッシュ比較して不変。新列はnullable/defaultの指定どおり。
- down: `tests/fixtures/oauth-fencing-down.sql`、追加6列だけDROP COLUMN、CASCADEなし。使い捨て試験以外には実行していない。
- round-trip DBはSQL直接適用し `_prisma_migrations` を作成/偽造しない。管理DBの履歴はPrismaが正常適用して書いたものを読取確認のみ。既存migration編集、履歴の手書き変更、稼働DB reset/dropなし。
- 試験終了時に削除するのはsuiteが新規作成した一意DBだけ。

## 実測試験

| 実行 | 結果 |
|---|---|
| `pnpm test:postgres:oauth` | **25/25 PASS**、2ファイル、12.36秒 |
| `pnpm test:postgres` | **30/30 PASS** |
| `pnpm test:postgres:ledger` | **17/17 PASS** |
| `pnpm test:postgres:outbox` | **19/19 PASS** |
| `pnpm test:postgres:dispatcher` | **14/14 PASS** |
| `pnpm test:postgres:jobs` | **22/22 PASS** |
| `pnpm verify` | **PASS**。Frontend128件、API283件（新規unit3件含む）、format/lint/typecheck/build。PG専用127件のskipは上記で全件別実行 |
| Prisma validate / generate / db:check-drift | **PASS / PASS / driftなし** |
| dependency audit（production依存） | **既知の脆弱性0件** |
| `git diff --check` | **PASS** |
| 変更コードの限定secretパターン検査 | **検出0件**。秘密鍵/主要token形式の検査であり網羅的監査ではない |

合格条件に対応する実測:

- **100 concurrent acquisitions**: Fake refresh呼出1回、1件TOKEN、99件BUSY。lease generation1、確定後credentialVersion1、lease解放。provider実行中に別DB sessionで同じ行のFOR UPDATE NOWAITが成功し、TX外実行を確認。
- **TX2 version mismatch**: 合成した新資格情報version7を保存後、古い結果が返ってもDB行不変。最新保存tokenを返す。最新cacheがない場合はSTALEで終わり、再refreshしない。
- **expired lease**: DBで自然経過を待ち、別サービスinstanceがgeneration2で回収。古いinstanceは更新・新lease解放ともできず、現instanceだけ確定。回収者がいなくても期限切れ結果は確定できない。
- **cache TTL / forceRefresh**: >5分はFake呼出0、forceRefreshは1。5分ちょうど/299秒/期限切れは再利用しない。アプリ時計を2099年へずらしてもDB時刻基準は変わらない。
- **10s timeout**: 実時間（テスト時計ではない）でtimeout、AbortSignal確認、部分credential書込0、lease解放、次の取得が成功。元Promiseの遅延成功後もDB行不変。
- **rotation/encryption**: refresh/accessの暗号化保存、回転なしなら旧refresh/鍵情報保持。access側別鍵versionでも再取得可能。2個目の暗号化だけ失敗しても部分書込なし。暗号化/復号中にも別sessionの行lockが取得できる。
- **unavailable/scope/errors**: REAUTH_REQUIRED/REVOKED/ERROR、別user/provider/IDはprovider呼出0。途中revocationを古い成功で復活させない。provider/crypto/DBの生エラーは出さない。キャッシュ復号中の世代交代はSTALE。
- **off regression**: lazy依存未構築。従来workerでDONE、Alert1/Outbox2、既存include結果の新cache/lease列null、version/generation0。既存認証・監視・冪等・SIGKILL試験も上の既存suiteで実行。
- **migration**: 旧schema fixtureでの初回失敗を確認し、テスト専用client/seedを修正後、up/down/upと既存全suiteを再実行して成功。最初のlintのテスト型警告も修正済み。

## 変更ファイル

- 実装: `apps/api/src/modules/mail/reliability/oauth-fenced-refresh.ts`。
- 設定: `apps/api/src/config/env.ts`、`.env.example`。
- DB: `apps/api/prisma/schema.prisma`、上記新規migration、`apps/api/tests/fixtures/oauth-fencing-down.sql`。
- 新規試験: `apps/api/tests/oauth-fenced-refresh.test.ts`、`oauth-fenced-refresh.postgres.integration.test.ts`、`oauth-fencing-migration.postgres.integration.test.ts`。
- 試験fixture: `fixtures/oauth-test-database.ts`、`fixtures/legacy-schema-client.ts`、`fixtures/mail-ledger-harness.ts`。
- 既存migration試験のfixture接続変更のみ: `mail-ledger-migration.postgres.integration.test.ts`、`mail-outbox-migration.postgres.integration.test.ts`、`gmail-jobs-migration.postgres.integration.test.ts`。
- env型fixtureのoff追加のみ: `alert-routes.test.ts`、`app.test.ts`、`auth-routes.test.ts`、`google-auth-routes.test.ts`、`mail-connection.test.ts`、`team-routes.test.ts`、`user-communication-routes.test.ts`。
- 実行/記録: ルートとAPIの`package.json`、`.github/workflows/ci.yml`、本書。CIにPG17のOAuth専用試験とphase2ブランチの検証を追加。

## 未実行・停止位置

実Google/Microsoft/KMS、実HTTP token refresh、実メール/通知、稼働DB適用、クラウド変更、main merge、デプロイ、05b: **未実行**。
このPRだけで全writerの保護完成や実利用可と判定しない。最新commit ID・CI結果はPR報告へ記録し、05aの結果報告で停止する。
