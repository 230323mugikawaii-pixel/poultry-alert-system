# Staging OAuth / iOS native PKCE — 2026-09-27

## 到達点

**staging APIへのnative PKCE実装反映とiOS接続設定は完了。実Google/Microsoftログインは未完了。**
両providerは現在 `NOT_CONFIGURED`。管理画面へのアクセスがこの作業セッションでは使えず、
専用クライアントの実登録値・所有権を確認できないため、本番/E2Eのclientを流用していない。
実ログイン成功やOAuthクライアント設定完了として扱わない。

- 専用ブランチ: `staging/oauth-native-20260927`
- staging基点: `6f3a59b355b83d6c0c7412478b60c0eb05f89cb1`
- 統合したPR #43: `fca2178ced2cc1de53b9fc893a22b615ff2e1b73`
- 配備したコード: `42bd9126ee9792b46afda1968d63a31ff4416f72`
- 本番/main/PR #43ブランチを直接更新しない。元のworktreeにある未コミット6ファイルも保持。
- 新しい専用worktreeで既存stagingと#43を統合。旧iOS shellとのadd/addは#43のnative実装を採用し、
  CI/envはAPNsとnative双方を保持。秘密鍵のignore規則を保持。

## APIとiOS設定

API / PUBLIC_ORIGIN / iOS Origin:
`https://call-now-staging-api-404996456750.asia-northeast1.run.app`

| 項目 | 設定・結果 |
| --- | --- |
| Googleへの登録callback | `https://call-now-staging-api-404996456750.asia-northeast1.run.app/api/v1/auth/google/callback` |
| Microsoftへの登録callback | `https://call-now-staging-api-404996456750.asia-northeast1.run.app/api/v1/auth/microsoft/callback` |
| Call Now → iOSの戻り先 | `com.callnow.poultryalert:/oauth/callback` |
| Call Now native client_id | `callnow-ios` |
| iOS Bundle ID / URL scheme | `com.callnow.poultryalert` |
| Xcode scheme / configuration | `CallNowStaging` / `Staging` |
| API native mode | stagingだけ `NATIVE_AUTH_MODE=enabled` |
| Google / Microsoft login provider | ともに `NOT_CONFIGURED`（未設定を偽装しない） |

外部providerには**Web applicationのHTTPS callback**を登録する。
iOSのcustom schemeはCall Now APIがPKCE付きの一時コードを渡す戻り先であり、
Google/Microsoftに登録するcallbackとは別。既存Web Cookieとの共有は仮定しない。
S256、state、ブラウザ紐付け、一回限りのcode交換後にアプリ用Call Nowセッションを取得する。
Google/MicrosoftトークンをiOSへ渡さない。セッションCookieはSecure/HttpOnly/Lax、
iOSはephemeralなメモリ内Cookie管理を使用する。

Debugは従来のlocalhost、Releaseは到達不能プレースホルダーのまま。
Stagingだけ上記HTTPS APIを選ぶ。旧 `com.callnow.app` callbackは拒否するテストを追加した。
元の作業ブランチのBundle ID変更は書き換えず、この統合ブランチ側で確定値を反映した。

## stagingへの反映

対象は新設済みの `call-now-staging-20260927` / `asia-northeast1` のみ。

- API revision: `call-now-staging-api-00004-74c`、Ready、traffic 100%。
- API image: `api:42bd912`
  - digest: `sha256:249ef96abf8a44473f1a01aca253f52e3b28740922067b2a0715e8e0de5eb1db`
- migration image: `migration:42bd912`
  - digest: `sha256:cc9f487314cac108154fbfb15adb92bed687539f2d1449a9efd2d78a07fec179`
- Registry prefix: `asia-northeast1-docker.pkg.dev/call-now-staging-20260927/call-now-staging`
- `call-now-staging-migrate-ghqdq`: 成功。既存29件に
  `20260927000100_native_login_grants`を追加し30件。stagingのみに適用。
- `call-now-staging-schema-check-bcncr`: status / diff ともにexit 0、pending 0、driftなし。
- 前後のusers / mail_authorizations / alerts / outbox / deliveriesは全て0のまま。
- dispatcher / push jobは更新・起動せず、実行履歴各0件。Gmail監視false、実Pushフラグoffを維持。

以下のstaging専用Secret Manager **空コンテナ**を準備した（version各0、秘密値未投入）。
API実行SAだけに各secretのaccessor権限を付与した。実OAuth設定へはまだ参照していない。

- `call-now-staging-google-login-client-id`
- `call-now-staging-google-login-client-secret`
- `call-now-staging-microsoft-login-client-id`
- `call-now-staging-microsoft-login-client-secret`

Cloud Runの自動request logにcallback code/queryが残ることを避けるため、staging projectの
`_Default` sinkへ `staging-oauth-request-urls` 除外を追加した。対象はこのAPIのrequest logにある
`/api/v1/auth/(native/|google/|microsoft/)`だけ。他projectやアプリの安全な監査ログは変更しない。
アプリ側のURL/body/Cookie/Location等のredactionも維持する。

## 実測テスト

| 確認 | 結果 |
| --- | --- |
| XcodeGen / Staging build（署名なし） | PASS、Xcode 27.0 / iPhone 18 Pro / iOS 27.0 |
| Staging unit / UI tests | **34 PASS、失敗0、skip 0**（合成API、実provider未接続） |
| API native + staging + env + appの関連テスト | **49 PASS** |
| `pnpm verify` | PASS。API **396 PASS**、Frontend **128 PASS**、format/lint/typecheck/build成功 |
| Prisma validate / generate | PASS |
| 隔離PostgreSQL 17全統合 | **177 PASS**。内訳は下記 |
| 隔離DB migration / drift | 30件、pending 0、driftなし。native追加tableのup/down/up・既存不変PASS |
| Docker API / migration | linux/amd64 build / push成功、非root `node` |
| `git diff --check` | PASS |
| 公開API `GET /health`, `/ready` | HTTP 200 / `ok:true` |
| native / Web providers | HTTP 200、Google/MicrosoftともNOT_CONFIGURED |
| 未設定providerのnative start | Google/Microsoftとも503 `LOGIN_PROVIDER_NOT_CONFIGURED`、外部redirectなし |
| 合成の無効code交換 | 401 `NATIVE_GRANT_INVALID`、no-store、セッション発行なし |
| 不正Originからの交換 | 403 `ORIGIN_NOT_ALLOWED`、no-store、セッション発行なし |
| 実stagingへ向けたSimulator起動 | PASS。OWNERログイン画面、provider未設定でボタン無効を目視確認 |
| 実Google/Microsoft認証 → アプリ復帰 | **未実施**。専用client設定・本人同意待ち |
| GitHub CI | この報告作成時は未実施。push後の結果はPRで確認する |

公開Cloud Runのhealthは既存の非予約alias `/health` / `/ready` を使用。
`/healthz`の公開200は今回の合格根拠にしていない。

PostgreSQL内訳: baseline30 / ledger17 / outbox19 / dispatcher14 / jobs22 /
device16 / delivery19 / apns-worker21 / apns15 / native4 = **177**。
既存DBには接続せず、別名・tmpfsのPostgreSQL 17コンテナを作成して使用・終了した。
APNs関連はローカルHTTP/2モックだけで、Apple接続・実Pushなし。
verify内でskipされるPG177件は上記独立実行で検証済み。

**初回統合実行では既存outbox suiteが18 PASS / 1 FAILになった。**
当時の安全出力ラッパーは詳細を出さず、失敗したcase/根本原因を特定できていない。
期待値や実装を変えず単独再実行19/19、全suite再実行でも19/19となった。
再実行成功は記録するが、この初回失敗を修正済み・原因確定とはしない。

新しいstaging契約試験では、両providerのmock callback、Secure Cookie、S256、
one-time交換・再利用拒否・auth/meと、既存OAuth clientが生成するredirect URI / scopesを検証。
mockの成功はGoogle/Microsoft実環境の成功ではない。

## 主な変更ファイル

#43のnative backend/iOS一式を上記HEADから取り込み、それに次のstaging差分を追加した。

- `apps/ios/CallNow/project.yml`: Staging構成・scheme・Bundle ID・custom scheme。
- `apps/ios/CallNow/Sources/Auth/{NativePKCE,AuthSession}.swift`: 確定callback schemeの共有。
- `apps/ios/CallNow/Sources/PushRegistration/InstallationIdentifierStore.swift`: 確定Bundle名前空間。
- `apps/ios/CallNow/Tests/CallNowTests/{NativeClientTests,StagingConfigurationTests}.swift`: callback/staging契約。
- `apps/ios/CallNow/README.md`: 起動と設定手順。
- `apps/api/src/modules/auth/native-auth-service.ts`: 確定callbackの厳密allowlist。
- `apps/api/tests/{native-auth,native-auth-staging}.test.ts`, `helpers/native-auth-fixture.ts`: 回帰・staging合成試験。
- `.env.example`, `.github/workflows/ci.yml`: native設定/統合テストを既存APNs構成と両立。
- `infra/cloudrun/staging/api.env.yaml`: staging native有効化、Microsoft LOGIN用設定枠。
- 本報告書。

## 必要なユーザー操作と再開順

1. **専用clientの有無を確認**。未作成ならstaging専用を作成する。
   - Google: `call-now-staging-20260927` projectのOAuth Web application。
     ログイン用scopeはopenid/email/profile。上記Google HTTPS callbackだけを登録。
     同意画面・テストユーザー・本人ログイン等の操作はユーザーが行う。
   - Microsoft: staging専用Entra app、Web platform、上記Microsoft HTTPS callback。
     scopeはopenid/profile/email。アカウント種類とtenantを確認して選択する。
     現在の候補はcommonだが、既存本番appのtenant/権限を勝手に流用しない。
   - どちらもGmail/Graphメール監視用clientではなくOWNERログイン用。
     JS origin追加はこのserver-side経路には不要。既存本番/E2E URIを変更しない。
2. client IDとclient secretを対応する**staging Secret Manager**へ安全に投入する。
   秘密値をチャット、git、コマンドライン引数へ貼らない。Microsoftはsecret IDではなくValue。
3. APIへsecret versionを固定して参照させ、callback URIとtenantを同時設定する。
   - Google: `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI`
   - Microsoft: `MICROSOFT_LOGIN_OAUTH_CLIENT_ID` / `MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET` /
     `MICROSOFT_LOGIN_OAUTH_REDIRECT_URI` / `MICROSOFT_LOGIN_OAUTH_TENANT`
   - メール監視用 `MICROSOFT_OAUTH_*` は使用・変更しない。
   - 現在のenv YAMLは未設定値。資格情報設定後に全量で再適用すると消えるので、
     次回配備時はversion参照を含む確定構成を記録してから適用する。
4. providers=AVAILABLEを確認し、ユーザーがSimulatorでGoogle/Microsoft認証・同意する。
   callback → iOS復帰 → PKCE交換 → auth/me → 履歴の認証付き取得を確認する。
   実機の確認・実Pushは別項目とし、今回は送信しない。

公式の登録仕様:
[Google server-side OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)、
[Microsoft app registration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)、
[Microsoft redirect URI](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)。

## 未確認・戻し方・安全境界

- 実providerの登録値、アカウント種類、テストユーザー、client所有権は未確認。
- 実OAuth callback/ASWebAuthenticationSessionのCookie挙動はmock試験とは別に本人操作後確認する。
- iPhone実機での認証・通知許可・端末登録・APNs送信は未実施。
- API問題時はstagingの旧revision `call-now-staging-api-00003-wc4` へtrafficを戻す。
  追加tableは残してよく、稼働DBのdown/resetやnative grant削除は自動で行わない。
- local通常/E2E・本番DB・本番OAuth・Google Cloud既存project・Pages・mainは非変更。
- 実メール、監視開始、実Google/Graph API、実Apple、実Push、main mergeは未実施。
- staging既存の月額45〜55 USD目安の構成を維持。追加は空secret・image・検証jobの範囲。
  新しい常駐server/SQL/有料契約は作成しない。通常の保存・実行従量料金は発生し得る。

**停止位置: stagingコードと安全な自動試験まで。専用OAuth client確認・秘密値投入・本人認証待ち。**
