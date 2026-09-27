# PR06 — authenticated device push registry only

実施日: 2026-09-24。基点: main `b39c6ea4c472e7a12cbb991781d7f9760c70c821`。
ブランチ: `phase3/device-push-registry-20260924`。PR04/#35、PR05a/#36には依存せず、mainから独立して実装した。

## 実装範囲と未実装境界

- 追加は `DevicePushRegistration` 1テーブル、専用enum3個、Team/User/NotificationMemberの逆参照。既存DeviceはUser専用のまま、既存NotificationTarget/NotificationTargetStatus、MailAuthorizationも変更しない。
- `MOBILE_PUSH_REGISTRY_MODE=off|shadow`、既定off。offではサービスfactoryを呼ばず、ルート未登録・新テーブル未使用。shadowは**登録を保存するだけ**で送信しない。
- OWNERは既存AuthServiceのsession cookie＋TeamServiceのOWNER認可、MEMBERは既存NotificationMemberServiceの別cookie・sessionを利用。MEMBER IDをUser IDとして扱わない。
- 本人識別はサーバーの認証結果だけから取得する。Team/principalKind/principalIdを各検索・更新で絞る。OWNER cookieとMEMBER cookieが共存してもroute別に選び、fallbackしない。
- DB書き込み前にTeam ACTIVE、本人ACTIVE/非削除、OWNER membershipまたはMEMBERのTeam対応を再確認し、FOR SHAREでロック。暗号化中の無効化も再確認する。
- 更新はREAD COMMITTED＋行ロック＋DB UNIQUE/UPSERT。登録はSELECT→INSERTではない。暗号化はTX外。今回Serializable retryや外部送信は不要。
- targetKeyはサーバー生成の不透明UUIDで、登録更新/解除/再登録によって変更しない。操作には認証が必須で、targetKeyだけではアクセスできない。
- 暗号化は既存TokenEncryptionProviderを再利用。Textには暗号化envelope（ciphertext/provider/keyVersion）をJSON保存。平文は保存せず、responseにも返さない。解除時はciphertext/hashをNULLにし、登録履歴とtargetKeyは維持する。
- 対照用hashは既存AUTH_TOKEN_PEPPERを使うドメイン分離HMAC-SHA256。hashもAPIに返さない。ACTIVE tokenの二重紐付けはDB UNIQUE(platform,tokenHash)で拒否する。他principalからの登録で既存の紐付けを移管・解除しない。
- 同一Team/principal/platform/installationIdの再登録でtokenVersion+1。更新と解除はtokenVersionを照合し、古い操作で新登録を変更させない。解除もversion+1、解除再試行は冪等。解除済みからの復帰は明示POSTのみ。
- 既存の同一Origin検証を維持し、変更系はPUBLIC_ORIGIN完全一致を要求。4KB上限、トークン入力長上限、既存API全体のrate limitを維持する。
- 公開DTOはmetadataだけを明示select。新APIの例外は固定の安全なコードへ変換し、parser/暗号化/DBの生errorをログ/レスポンスへ出さない。deviceTokenをログredactに追加。Cache-Control: no-store。
- **NotificationDelivery、APNsクライアント、送信、dispatcherとの接続、iOSアプリ、Critical/Time Sensitiveは未実装。ACTIVEは登録の有効状態であり、端末到達・実配信成功を表さない。**

## API契約・具体化した点

| principal | 基底path | 認証 |
|---|---|---|
| OWNER | `/api/v1/teams/:teamId/push-devices` | OWNER session、TeamのOWNER権限 |
| MEMBER | `/api/v1/notification-members/push-devices` | 通知メンバーsession、Teamはsessionから導出 |

- `POST <base>`: `{installationId, platform:"APNS", deviceToken}` → 201。installationIdはクライアントがインストールごとに生成・保持するUUID。同じ本人が再登録するときは同じUUIDを送る。
- `GET <base>/:targetKey`: metadataのみ取得 → 200。
- `PUT <base>/:targetKey`: `{tokenVersion, deviceToken}` → 200。ACTIVEのみ更新可能。
- `DELETE <base>/:targetKey`: `{tokenVersion}` → 200。論理解除。
- tokenVersion不一致は409、他principalのtargetは404。本人/Teamが無効なら403（既存session検証で先に401になる場合もある）。未認証401、Origin不一致403、入力不正400、内部障害503。トークン競合は情報を含まない409。
- deviceTokenのAPI表現は偶数桁のhex（最大1024文字）。大小文字は同じbyte列として扱い、固定64文字の仮定はしない。これは新registryの入力契約で、Appleによるトークン検証を行ったという意味ではない。
- principalKind＋principalIdのほか、User/NotificationMember別のnullable FKを持ち、CHECKで種別とIDの一致を保証する。既存モデルに複合UNIQUEを足さず、Team所属は認証と書き込みTXで検証する。
- 新FKはRESTRICT。既存親データの削除に連動して登録が消える設計にはしていない。将来の物理削除・データ消去設計では登録を含めて扱う必要がある（この作業では既存データの削除なし）。
- 1つのACTIVE tokenは1登録のみ。別principalや別installationIdへ同じtokenを自動移管しない。既存本人が先に解除してから登録する。AUTH_TOKEN_PEPPERの変更時はhashの移行方針が必要（今回は秘密設定変更なし）。
- iOSアプリがないためinstallationIdの永続保持、APNs environment/topic/アプリ真正性、実端末トークンの所有証明・実到達は未確認。実送信へ接続する前の後続PRで扱う。Cookie認証・Originチェックを弱めるnative向け例外は今回作らない。

## Migrationと隔離

- 新規PostgreSQL17コンテナ `call-now-device-pr06-pg17-20260924`、loopbackポート25445、専用tmpfs。通常/E2E/PR04/PR05a/本番DBと別領域。既存コンテナは停止・変更しない。
- migration `20260924000300_device_push_registry`。このmain起点では先行27件＋本件＝**28件**。
- 先行27件適用済みの隔離DBからPrisma migrate diff --scriptでcreate-only相当生成し、新テーブルにだけCHECKを追加。既存migration/列/データ変更、DROP/TRUNCATEなし。
- 別の一意な使い捨てDBに既存migration＋合成User/Team/契約/Google接続/参加者/Alert/宛先/Outbox等を用意し、**up→down→up PASS**。全既存テーブルのデータ・列定義・制約・indexをハッシュ比較して不変。
- downは新table/enum3個だけ、CASCADEなし。round-trip DBはSQL適用でPrisma履歴を作らず、成功履歴を手書きしない。管理DBはPrisma migrate deployで正常な履歴を作成し、28/28・pending 0を確認。
- 試験後に削除したのはsuiteが新規作成した一意な `callnow_pr06_test_*` DBだけ。既存DB・volumeの削除やresetなし。

## 実測結果

| 実行 | 結果 |
|---|---|
| `pnpm test:postgres:device` | **16/16 PASS**、2ファイル、1.92秒 |
| `pnpm test:postgres` | **30/30 PASS** |
| `pnpm test:postgres:ledger` | **17/17 PASS** |
| `pnpm test:postgres:outbox` | **19/19 PASS** |
| `pnpm test:postgres:dispatcher` | **14/14 PASS** |
| `pnpm test:postgres:jobs` | **22/22 PASS** |
| `pnpm verify` | **PASS**：Frontend128、API285（新規unit5含む）、format/lint/typecheck/build |
| Prisma validate / generate / drift | **PASS / PASS / 差分なし** |
| migration | **28/28、pending 0、up/down/up PASS** |
| `git diff --check` | **PASS** |

verify内のPG専用118件skipは、上記16＋102件を隔離PostgreSQLで別実行済み。CIにもdevice suiteを追加し、最新commitのCI結果はPRへ記録する。

新規試験の内訳（設計資料からの流用ではなく今回実行）:

1. OWNER/MEMBERそれぞれ実DB session認証で登録→同token再登録→rotation→GET→解除→解除再試行→再登録。target不変・version単調・旧version拒否・暗号化復号一致・秘密なしDTO（2件）。
2. 他Team/他principal/OWNER⇔MEMBERのGET/PUT/DELETEを拒否、DB不変。
3. UserとNotificationMemberが同じUUIDでも混同しない。
4. **同時100登録: 登録1行、target1個、version1〜100（100個の一意version）**。
5. 同versionの更新/解除競合: 片方だけ成功、もう片方は409。
6. 同tokenを別本人・別installationへ二重登録不可、既存解除後のみ新登録可能。
7. OWNER/MEMBERで未認証・異種cookie・期限切れ・revoked session拒否（2件）。
8. disabled/deleted MEMBER、降格/removed OWNER、SUSPENDED Team拒否。
9. 暗号化待機中にMEMBER無効化→DB保存前の再認可で拒否。
10. Origin・追加principal入力・不正token・platform・壊れたJSON拒否、安全なレスポンス。
11. 暗号化例外の秘匿・部分保存なし、暗号化中に別sessionのFOR UPDATE NOWAIT成功（TX外）。
12. 新registry操作で全旧table/schema不変、DBの新tableにも平文なし。
13. DB CHECKによるprincipal不一致/version/token状態不正の拒否。
14. migration往復、テーブルがないoff状態で従来Gmail処理（Fake）→Alert1/Outbox2、旧include結果不変、全新route404、factory未構築。
15. unit5件: defaultoff、shadow依存不足fail-closed、DB生error秘匿、送信依存なし、parser/サービス失敗の実ログcaptureでtoken/cookie非露出。

初回試験でTypeBox UUID format未登録による400を検出し、既存routeと同じUUID patternへ修正。fixtureのREMOVEDに既存CHECKが要求するremovedAtを追加。途中追加したテストのformat違反も修正し、再実行して上記greenを確認した。

## 変更ファイル一覧

- `apps/api/prisma/schema.prisma`、`apps/api/prisma/migrations/20260924000300_device_push_registry/migration.sql`
- `apps/api/src/modules/device-push/device-push-registry.ts`、`device-push-routes.ts`
- `apps/api/src/app.ts`、`server.ts`、`config/env.ts`、`.env.example`
- `apps/api/tests/device-push.test.ts`、`device-push.postgres.integration.test.ts`、`device-push-migration.postgres.integration.test.ts`
- `apps/api/tests/fixtures/device-test-database.ts`、`device-push-harness.ts`、`device-push-down.sql`
- env fixtureのoff追加のみ: `alert-routes.test.ts`、`app.test.ts`、`auth-routes.test.ts`、`google-auth-routes.test.ts`、`mail-connection.test.ts`、`team-routes.test.ts`、`user-communication-routes.test.ts`
- ルート/API `package.json`、`.github/workflows/ci.yml`、本報告書。

## 停止位置

実Apple/APNs/Google/KMSへの接続、実トークン/実認証情報の利用、実通知、稼働DB適用、main merge、クラウド変更、デプロイ: **未実行**。
既存mail/Alert/dispatcher実装やFrontendは変更なし。PR06の登録レジストリだけで停止し、配信成功やモバイル対応完了とは判定しない。
