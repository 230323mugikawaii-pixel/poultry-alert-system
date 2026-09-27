# CallNow iOS client foundation

OWNERのネイティブPKCEログイン、通知メンバーのID/パスワードログイン、
メモリ内の通知履歴、この端末の通知ON/OFF、PR06端末登録の土台です。
課金・解約はプレースホルダーのみ。
現在の契約と制約は `docs/ios/step-02-native-client-implementation-results.md` を参照してください。

## プロジェクトを開く

このディレクトリに `.xcodeproj` はコミットしていません(手書きのpbxprojは壊れ
やすいため、[XcodeGen](https://github.com/yonaskolb/XcodeGen) の `project.yml`
から都度生成する運用にしています)。

```
brew install xcodegen   # 未インストールの場合のみ
cd apps/ios/CallNow
xcodegen generate
open CallNow.xcodeproj
```

Xcodeの Signing & Capabilities で自分のTeamを選択してからビルドしてください
(Team IDはproject.ymlにハードコードしていません)。

## 開発用サーバー接続先

Debug構成の既定値:

- API: `http://127.0.0.1:8080`
- Origin(`/push-devices`などの書き込み系エンドポイントに必須): `http://127.0.0.1:5500`
  (リポジトリ直下 `.env.example` の `PUBLIC_ORIGIN` と同じ)

シミュレータのローカル確認用です。レビュー後、隔離した検証用APIへ接続する際は
`CALLNOW_API_BASE_URL` / `CALLNOW_PUBLIC_ORIGIN` を明示してください。
HTTPはDEBUGのloopbackだけ許可し、他はHTTPS必須です。
Release既定値は到達不能なプレースホルダーです。本番接続先・鍵は同梱しません。

## Staging専用構成

`CallNowStaging` scheme / `Staging` configurationを選択します。
APIとOriginはともに `https://call-now-staging-api-404996456750.asia-northeast1.run.app`。
Debugは従来のloopback、Releaseは未接続のままです。
Bundle IDとcustom schemeは `com.callnow.poultryalert`、アプリ戻り先は
`com.callnow.poultryalert:/oauth/callback`。API側の許可値も一致させています。

```sh
xcodegen generate
xcodebuild test -scheme CallNowStaging -configuration Staging -destination 'platform=iOS Simulator,name=iPhone 18 Pro' CODE_SIGNING_ALLOWED=NO
```

Google/Microsoftの登録先は上記custom schemeではなく、staging APIのWeb callbackです。
新規のstaging専用Web clientを使用し、既存本番/E2E clientを書き換えません。
秘密値はアプリ・リポジトリへ入れず、staging Secret ManagerからAPIだけへ渡します。
OAuth providerが未設定ならログイン不可であり、テスト用の認証迂回は提供しません。
現在の設定・確認状況は `docs/staging/2026-09-27-oauth-native-results.md` を参照してください。

新規migration適用と `NATIVE_AUTH_MODE=enabled` がOWNERログインの前提です。
端末登録はPR06の `MOBILE_PUSH_REGISTRY_MODE=shadow` が必要です。
いずれもサーバー既定値off。staging限定の適用状況は上記staging報告書に記録します。
既存のGoogle/Microsoft向けWeb callback URIは変わりません。
WebブラウザのCookie共有を仮定せず、コード交換でアプリ独立のメモリ内セッションを取得します。
終了後のログイン状態永続化・アカウント全体通知設定は実装していません。

## ネットワークを使わないテスト

```sh
xcodegen generate
xcodebuild test -scheme CallNow -destination 'platform=iOS Simulator,name=iPhone 18 Pro' CODE_SIGNING_ALLOWED=NO
```

実際に存在するシミュレータ名に置き換えてください。テストホストは合成API・通知コントローラを使用し、
実Google/Microsoft/Appleへ接続しません。`--ui-test-fixture` はDEBUGビルド限定です。
UIテストの許可ボタン操作もApple登録へは進みません。

## 動作確認状況

XcodeGen / Simulator build・unit/UI testを実施。実機OAuth・実APNs送信・TestFlightは未実施。
件数・CI・制約はstep-02報告書とstaging報告書に記録します。mainへのmergeや本番デプロイは行いません。
