# iOS client foundation / native PKCE handoff

実施日: 2026-09-27。レビュー用・本番利用未承認。
作業ブランチ: `phase4/ios-native-client-20260927`
base: PR06 / #37 / `phase3/device-push-registry-20260924`
（`1d8b72f9a562b04ef95cce3cfb2f54927d5011b0`）。

## 範囲・分類

- 承認済み: OWNERのGoogle/Microsoftログインのネイティブ引き渡し、新規バックエンドendpoint・加算migration。
- 通知メンバー: 既存ID/パスワード・専用Cookie/APIを使用。NotificationMember IDをUser IDとして扱わない。
- iOS: ログイン→履歴→端末通知設定→ログアウト。契約・課金・解約は遷移先だけ。
- 端末通知OFFはこのインストールのPR06登録解除だけ。Gmail監視、他端末、履歴APIへ影響しない。
- `PushDeviceRegistering` がPR06との薄い境界。再登録は既存POST upsert、
  解除はGETで最新tokenVersionを取得してDELETE。競合/失敗時はOFF完了と表示しない。
- PR06にiOSが無いため、mainで既に取り込まれたshellの元コミット
  `58bcf39bfec90c3f85f7ea5f98be48285955a9ae` を変更せずcherry-pick
  （このブランチでは `b0b7337`）してから拡張。main/#37自体は変更しない。

## 認証契約

1. iOSが暗号学的乱数のstate/verifierを生成し、S256 challengeのみstart URLへ渡す。
2. `GET /api/v1/auth/native/{google|microsoft}/start`:
   client_id=`callnow-ios`、redirect_uri=`com.callnow.app:/oauth/callback`、
   response_type=code、code_challenge_method=S256を固定検証。任意redirect・plainは不可。
3. サーバーは既存PrimaryAuthServiceの上流PKCE/nonceと別に、ネイティブgrantと
   HttpOnly/Laxブラウザ照合Cookieを作成（最大10分）。既存Web sessionを発行・失効しない。
4. Google/Microsoftの既存callbackでnative grantを照合し、一度だけidentityを解決。
   有効期限60秒の一回限りコードをアプリcallbackへ渡す。アプリstateも必須照合。
5. `POST /api/v1/auth/native/token`: code + verifier + 固定client/redirect/grant_typeを検証。
   DBの条件付きUPDATEで一回だけconsumeし、既存AuthServiceのアプリ用sessionを発行。
   応答は `{user}` とHttpOnly Set-Cookie。Google/Microsoft tokenやrefresh tokenは返さない。
   **OAuthのaccess/refresh token発行サーバーではなく、PKCEで保護したCall Now session交換**。
6. アプリは独立したephemeral URLSessionのCookie jarで既存APIへアクセス。
   ASWebAuthenticationSessionのCookie共有、auth/meポーリング、CookieのURLへの埋込みを廃止。

既存のWeb OAuth・Gmail監視OAuth・登録済みprovider callback URI・本番認証設定は変更しない。
PKCE参考: [RFC7636](https://www.rfc-editor.org/rfc/rfc7636)、
[ASWebAuthenticationSession](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession)。

### Fail-closed / 安全性

- flag `NATIVE_AUTH_MODE=off|enabled`、初期off。offでは新サービス未構築・新テーブル非使用・新endpointなし。
- private verifier/stateはアプリメモリ内のみ。DBにはcode/state/bindingのHMAC、
  challenge、短期grantメタデータを保持。上流OAuth tokenを追加保存しない。
- code consumeと既存session生成は別TX。後段DB障害ではコード消費済みでログインやり直し。
  再送で第二sessionを作らず、安全側に失敗する（可用性上の制約）。
- 失効・不正provider/binding・code再利用・不正Origin・期限切れを拒否。rate limitあり。
- native endpointはno-store/no-referrer。例外詳細/入力値を返さず、
  loggerはURL/Cookie/Set-Cookie/body/verifier/redirectをredact。
- iOSはraw error bodyを表示しない。GETもdisk cacheなし、他originへのredirectは拒否。
- iOS保存はinstallation UUIDと端末登録の不透明handle/versionのみ。
  password、device token、session Cookie、メール本文/件名/履歴をdisk永続化・ログ出力しない。
- 履歴表示は既存APIが返すキーワード・検知日時・状態・providerの範囲。
  既存APIはメール件名/本文を返さないため、それらを新たに取得しない。添付は扱わない。
- 履歴取得中のlogout/別アカウント変更で遅延応答が戻っても旧履歴を復元しない。

## 変更ファイル（実装単位）

- Backend: `native-auth-service.ts`, `native-auth-routes.ts`, `prisma-native-grant-repository.ts`。
- 接続点: `primary-auth-service.ts`（identity解決を既存Web経路と共用）、
  `primary-auth-routes.ts`, `app.ts`, `server.ts`, `config/env.ts`, `.env.example`。
- DB: `schema.prisma`, `20260927000100_native_login_grants/migration.sql`。
- テスト: `native-auth.test.ts`, `native-auth.postgres.integration.test.ts`,
  `helpers/native-auth-fixture.ts`, `fixtures/native-auth-down.sql`。
  既存7 fixtureのenv literalへoff追加（既存期待値は不変）。
- CI/scripts: root/API package.json、CI PostgreSQL jobへnative suite追加。
- iOS: AuthSession/NativePKCE、APIClient、Principal/AlertHistory、
  PushDeviceRegistry/PushRegistrationCenter、Login/Root/設定View、App/AppDelegate、
  DEBUG専用UITestAPI/UITestNotificationDevice、project.yml。
- iOS tests: NativeClientTests、APIClientPrivacyTests、ClientFlowTests。
- docs: 本書、iOS README、旧shell報告への訂正注記。

## Migrationと検証

- 新規 `native_login_grants` テーブル+indexのみ。既存table/enum/constraint/データ変更なし。
- down SQLは新tableだけを削除し、専用の使い捨てDBでのみ使用。
- ローカルPrisma validate/generateはdotenvを読まない一時configで実施し、DB非接続。
- Docker daemon停止中。既存コンテナ/DBは起動・変更せず、実PostgreSQL17テストはGitHub CIの
  専用service/ランダム名子DBで実行する。
- CI管理DBは通常のPrisma deploy/drift。round-trip子DBはSQL適用→down→up、
  既存全tableの行・列・制約・index hash不変比較。migration履歴を手書きで偽装しない。
- native PG suite: up/down/up+off、100並列callback/交換の各1勝、
  fake Google/Microsoftの永続identity/session、期限切れ/不在user拒否。

### 実測

- Simulator: Xcode27.0 / XcodeGen2.46.0、iPhone18 Pro / iOS27.0、署名なしbuild PASS。
- 最終unit/UI run: **31 PASS / 0 FAIL**（unit30・UI1、実行時間55.4秒）。
  PKCE/RFC vector、state/redirect拒否、OWNER交換、member login/logout、
  1操作1POST、通知OFF履歴、stale response拒否、端末ON/OFF失敗・重複callback、
  Origin/cache/Cookie分離、メンバー画面遷移を確認。
  プライバシーテストでURLRequest単位のcachePolicy指定漏れを検出し、
  reloadIgnoringLocalCacheDataを明示して再実行PASS。
- native API unit: 20 PASS / 0 FAIL。
- Prisma validate/generate: PASS、DB非接続。
- `pnpm verify`: **PASS**。Frontend128件、API305件成功、API PostgreSQL122件は
  ローカル未実行としてskip。format/lint/typecheck/build成功。
- `git diff --check`: PASS。
- 実PostgreSQL・drift / GitHub CI: PR作成後に実行・追記。

## 未確認・制約

- 実Google/Microsoftログイン、ASWebAuthenticationSession→実callback→実API sessionの
  iPhone実機E2Eは未実施。今回はadapter fake/DB/Simulatorによる契約検証。
- 実APNs登録/送信/受信、署名、Apple Team、Key、TestFlight/App Storeは未実施。
  端末登録は配信成功ではない。受信時の高度な動作・Alert操作・background同期は未実装。
- アプリ終了後のsession永続化なし（再ログインが必要）。token rotationの自動background同期は対象外。
  明示ON操作が登録入口。logoutは登録解除成功後だけ実行する。
- 初回OWNERセットアップは既存Webで完了する必要がある。アカウント全体の通知設定は将来対応。
- grantの期限は検証時に拒否する。期限切れ行の定期削除ジョブはこのPRで追加していない。
- custom URL schemeは暫定Bundle IDと一致。実機検証・将来のUniversal Link/配布構成は別レビュー。
- PR06未merge。PR06契約変更時はadapter・契約テストを再確認し、stackを更新する。

## 停止位置

レビュー用PRまで。main merge・本番/クラウド/Google設定変更・既存DB適用・実メール・
実APNs/実Push送信・課金/解約処理は行わない。既存runtime flagは変更しない。
