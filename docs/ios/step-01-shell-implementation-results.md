# iOSアプリ土台 — 通知権限・デバイストークン登録のみ

実施日: 2026-09-26(実装)。ビルド・テスト検証: 2026-09-26(ユーザーのMac上、Codex経由)。
ブランチ: `phase4/ios-shell-20260926`。基点: `main` `b39c6ea4c472e7a12cbb991781d7f9760c70c821`
(既存の phase1〜phase3 の各ブランチとは独立)。
対応指示: `apps/ios/CallNow` の新規作成、通知権限・デバイストークン登録の最小骨組みのみ
(キーワード管理・アラート一覧・本体UI・バックエンド変更は対象外)。

## 実装前調査(想像で仕様を作らない、の確認結果)

指示どおり、実装前に以下を実際に読んで契約を確認した。バックエンドのコード自体は変更していない。

- `apps/api/src/modules/device-push/device-push-registry.ts` / `device-push-routes.ts`
  — 登録は `POST /api/v1/teams/:teamId/push-devices`(OWNER)。body は
  `{ installationId: uuid, platform: "APNS", deviceToken }`。`deviceToken` は
  `/^(?:[0-9a-f]{2})+$/iu` かつ1024文字以内の16進文字列(固定長を仮定しない設計)。
  `installationId` は teamId/principalKind/principalId/platform と組み合わせて
  upsertされるため、端末ごとに同じUUIDを使い回す必要がある。
  **書き込み系(POST/PUT/DELETE)は `Origin` ヘッダーが `PUBLIC_ORIGIN` と完全一致しないと
  403 `ORIGIN_NOT_ALLOWED`。ネイティブの`URLSession`はブラウザと違い`Origin`を自動付与しない
  ため、クライアント側で明示的に付与する実装にした。**
- `apps/api/src/modules/auth/session-cookie.ts` / `auth-service.ts` / `auth-routes.ts`
  — セッションは httpOnly Cookie(`COOKIE_NAME`、既定 `callnow_session`)。
  `GET /api/v1/auth/me` がセッションの生死判定に使える。
- `apps/api/src/modules/auth/google-auth-routes.ts` と `primary-auth-routes.ts`
  — 両方存在するが `app.ts` の配線は `primaryAuthService` があれば
  `createPrimaryAuthRoutes` を優先し `createGoogleAuthRoutes` は使わない(`else if`)。
  実際に使われているのは統一エンドポイント `GET /api/v1/auth/:provider/start`
  (`provider` = `google` / `microsoft`)と `GET /api/v1/auth/{google,microsoft}/callback`。
- `apps/api/src/modules/teams/team-routes.ts`
  — `GET /api/v1/teams/current` でログイン中ユーザーの teamId が取得できる
  (push-devices登録に必要な `:teamId` の取得手段として既存エンドポイントで足りると確認)。
- 既存Webフロント(`js/`, `index.html`)は上記と同じCookieベースのセッションをそのまま使用。
- `apps/api/.env.example` — 開発既定値は API: `http://127.0.0.1:8080`、
  `PUBLIC_ORIGIN`: `http://127.0.0.1:5500`(APIとフロントでポートが異なる)。

この調査の結果、**バックエンドへの新規エンドポイント追加・仕様変更は不要**と判断し、
指示どおり実装を進めた(止めて報告すべき既存API変更は発見しなかった)。

## 設計判断: ログイン完了検知(唯一、既存の作りとの摩擦があった点)

OAuthコールバック(`primary-auth-routes.ts`)はWebブラウザ向けに
`https://<PUBLIC_ORIGIN>/?primaryAuth=success` へリダイレクトする作りで、iOS標準の
`ASWebAuthenticationSession` が要求するカスタムURLスキーム/ユニバーサルリンクの着地点がない。
バックエンド/Web側を変更せずに実現するため、次の方式にした。

1. `ASWebAuthenticationSession` を `prefersEphemeralWebBrowserSession = false` で開始し、
   コールバックで発行されるhttpOnly Cookieを共有Cookieストレージ(Safariと同じ扱い)に載せる。
2. `URLSession.shared`(同じCookieストレージを使う)経由で `GET /api/v1/auth/me` を
   1秒間隔・最大2分間ポーリングし、200が返ったらログイン完了とみなす
   (httpOnlyは`document.cookie`からのJS読み取りを防ぐだけで、ネイティブの
   `URLSession`がCookieを自動付与すること自体は妨げない)。
3. 完了を検知したら `webAuthSession.cancel()` を呼んで自前でセッションを閉じる
   (コールバックURLが一致することは想定していないため、閉じる契機がここしかない)。

バックエンドの挙動・レスポンス形式は一切変更していない。ネイティブアプリ向けの
コールバックスキームを追加する対応は今回のスコープ外と判断し、実施していない
(必要であれば別途相談)。

## 実装範囲

- `apps/ios/CallNow/project.yml` — [XcodeGen](https://github.com/yonaskolb/XcodeGen)の
  プロジェクト定義。`.xcodeproj`はコミットせず都度生成する運用(理由は下記「未実行・未検証」)。
  Team IDは未設定(Xcode側でユーザーが選択)。Debug/Releaseで`CALLNOW_API_BASE_URL`/
  `CALLNOW_PUBLIC_ORIGIN`をInfo.plistへ注入して切り替え、Release既定値は本番ドメイン未確定の
  ため意図的に到達不能なプレースホルダにしている(本番URLへ固定接続しない、の要件どおり)。
- ログイン(`Sources/Auth/AuthSession.swift`) — Google/Microsoftのどちらかを選ぶだけの最小UI
  (`Sources/Views/LoginView.swift`)。詳細は上記設計判断のとおり。
- 通知許可(`Sources/PushRegistration/PushRegistrationCenter.swift`) —
  `UNUserNotificationCenter.requestAuthorization`。拒否時は状態表示のみで再許可導線は作らず。
- デバイストークン登録 — `didRegisterForRemoteNotificationsWithDeviceToken`
  (`Sources/AppDelegate.swift`)からhex変換(`DeviceTokenFormatter`)し、
  `installationId`(`InstallationIdentifierStore`、初回生成しUserDefaultsへ永続化)とともに
  `POST /api/v1/teams/:teamId/push-devices`へ1回だけ送信。失敗時の自動リトライは未実装
  (指示どおり、エラー表示のみ)。
- 通知受信の最小表示(`Sources/Views/ReceivedAlertsPlaceholderView.swift`) —
  受信件数のカウンタ表示のみ。アラート内容の取得・表示ロジックは未実装。
- サーバー接続先の切替 — ビルド設定(project.yml → Info.plist)経由、既定は開発用。

## テストと実測

実装時点ではこちらの作業環境にXcode/Swiftツールチェーンがなく検証できなかったため、
ユーザーのMac上でHomebrew / XcodeGenをセットアップし、ユーザーが運用するローカルAI
コーディングエージェント(Codex)経由で以下を実行した。

| 対象 | 結果 |
|---|---|
| XcodeGen導入 | 2.46.0 インストール成功 |
| `xcodegen generate` | 成功 |
| `xcodebuild build`(シミュレータ、署名無効) | **BUILD SUCCEEDED** |
| `xcodebuild test`(同上) | **9件成功・0件失敗**(`DeviceTokenFormatterTests` 4件、`InstallationIdentifierStoreTests` 3件、`PushDeviceRegistrationRequestTests` 2件) |
| 検証シミュレータ | iPhone 18 Pro / iOS 27.0、`CODE_SIGNING_ALLOWED=NO` |
| 実機・実Push・実Apple接続 | 未実施(指示のスコープ外) |

AppIntents未使用によるメタデータ抽出スキップの警告が出たが、ビルド・テストの成否には
影響していない。ビルドログ・テストログの内容そのものはこちら(Claude)側では直接確認しておらず、
Codexからの報告を採用している。ソースの変更・commit・push・実APNs送信は本検証では
行っていない。

## 未実行・未検証(重要)

- 本レポートの実装時点ではこちらの作業環境にXcode/Swiftツールチェーンがなく、
  ソースコードはSwift/SwiftUI/AuthenticationServices/UserNotificationsの仕様に基づいて
  記述したのみでコンパイル未確認のまま提出した。その後、上記のとおりユーザーのMac上で
  実際に`xcodegen generate` → `xcodebuild build` → `xcodebuild test`を実行し、いずれも
  成功したことを確認した。この確認はユーザーのローカル環境(Codex)によるものであり、
  こちら側で直接ビルド・実行したものではない。
- 手書きの`.xcodeproj`(壊れやすい)ではなくXcodeGenの`project.yml`形式にした判断自体は
  上記ビルド成功により妥当だったことが確認できた。
- `ASWebAuthenticationSession`のCookie共有(非エフェメラルセッションと
  `URLSession.shared`が同じCookieストレージを使う前提)は既知の一般的な挙動として実装したが、
  **実機・シミュレータでの実際の動作確認(実際にログインが完了として検知されるか)はまだ
  行っていない**。今回のビルド・テストはコンパイル成功とネットワーク非依存の単体テストの
  成功を確認したのみで、この設計判断そのものの動作検証ではない。
- モックしたAPIレスポンスでの画面遷移確認は未実施。
- 実機での実Push確認、TestFlight配布、App Store Connectへの提出、証明書/
  プロビジョニングプロファイルの作成は未実施(指示のスコープ外)。

## 変更ファイル

新規21ファイル(Swift 16、project.yml 1、README 1、報告書 1、docs/ios/新規ディレクトリ)+
`.gitignore`更新(XcodeGen生成物を除外)。バックエンド(`apps/api`, `apps/migrations`)は
未変更。`apps/ios`はpnpm workspaceに`package.json`を置いていないため
`pnpm-workspace.yaml`の`apps/*`には実質含まれない。

```
apps/ios/CallNow/project.yml
apps/ios/CallNow/README.md
apps/ios/CallNow/Sources/CallNowApp.swift
apps/ios/CallNow/Sources/AppDelegate.swift
apps/ios/CallNow/Sources/Environment/AppEnvironment.swift
apps/ios/CallNow/Sources/Networking/APIClient.swift
apps/ios/CallNow/Sources/Networking/APIError.swift
apps/ios/CallNow/Sources/Models/CurrentUser.swift
apps/ios/CallNow/Sources/Models/TeamSummary.swift
apps/ios/CallNow/Sources/Models/PushDeviceRegistration.swift
apps/ios/CallNow/Sources/Auth/AuthSession.swift
apps/ios/CallNow/Sources/PushRegistration/DeviceTokenFormatter.swift
apps/ios/CallNow/Sources/PushRegistration/InstallationIdentifierStore.swift
apps/ios/CallNow/Sources/PushRegistration/PushRegistrationCenter.swift
apps/ios/CallNow/Sources/Views/RootView.swift
apps/ios/CallNow/Sources/Views/LoginView.swift
apps/ios/CallNow/Sources/Views/NotificationStatusView.swift
apps/ios/CallNow/Sources/Views/ReceivedAlertsPlaceholderView.swift
apps/ios/CallNow/Tests/CallNowTests/DeviceTokenFormatterTests.swift
apps/ios/CallNow/Tests/CallNowTests/InstallationIdentifierStoreTests.swift
apps/ios/CallNow/Tests/CallNowTests/PushDeviceRegistrationRequestTests.swift
docs/ios/step-01-shell-implementation-results.md
.gitignore
```

## 停止位置

XcodeGenでの`.xcodeproj`生成・ビルド確認・XCTest実行は、ユーザーのMac上でCodex経由で
実施し、いずれも成功(`BUILD SUCCEEDED`、テスト9件成功・0件失敗)を確認した。ここまでで
停止。commit/push、main統合、実機テスト(Cookie共有によるログイン完了検知の実動作確認・
実Push受信含む)、TestFlight配布、App Store Connectへの提出、バックエンドAPIの追加・変更
については、この報告のみで判断せず、引き続きユーザーの確認を待つ。
