# 管理者向け監視アカウント初期設定

## 目的

初回利用者には独立したログイン画面を表示せず、Google または Microsoft のメール監視 OAuth を入口として、Call Now の本人識別と監視権限の取得を 1 回の操作で完了させます。

画面上は 1 回の操作ですが、サーバー内では次の責務を分離します。

- 本人識別: `ExternalIdentity` の `provider + providerSubject`
- ブラウザーのログイン状態: HttpOnly Cookie とハッシュ化済み `Session`
- メール監視権限: 暗号化した refresh token を持つ `MailAuthorization`
- 購入後の監視対象: Team 単位の `MailConnection`

メールアドレス一致だけで既存 User へ自動統合しません。`ExternalIdentity` にメール監視用 refresh token は保存しません。

## 状態遷移

1. 最初のメール監視 OAuth 成功時に User、ExternalIdentity、Session、User 単位の MailAuthorization、PENDING の OwnerOnboarding を作成します。
2. 2 つ目の Provider は、既存 Session で認証された同じ User へ追加します。
3. 購入前は Team、OWNER Membership、Subscription、MailConnection を作成しません。
4. 試作版の購入操作で Team、OWNER Membership、Subscription、Keyword、OwnerOnboarding の PURCHASED 化を 1 つの DB transaction で行います。
5. 購入後に利用者が「このアカウントを監視する」を選んだときだけ MailConnection を ACTIVE にします。「あとで変更」は DEFERRED として保持します。
6. すべての対象を ACTIVATED または DEFERRED にすると OwnerOnboarding は COMPLETED になります。

## 未完了設定の保持期限

購入前の PENDING オンボーディングは標準で 168 時間（7 日）保持します。`OWNER_ONBOARDING_TTL_HOURS` で変更できます。

期限切れは次のアクセス時と API プロセスの定期処理で検出し、OwnerOnboarding を EXPIRED、未使用の MailAuthorization を REVOKED に変更し、暗号化 refresh token を DB から削除します。Provider 側の失効は best-effort で行い、失敗してもローカル credential を再び有効にはしません。

## 既存機能との境界

- 既存の Google / Microsoft / Apple Primary Login と provider linking は、復旧・追加ログイン方法用として残します。初回セットアップからは呼びません。
- Apple はメール監視 Provider ではありません。
- Notification Member の Call Now ID / password ログインは変更しません。
- Alert、AlertRecipient、acknowledge、resolve、SSE の処理は変更しません。
- APNs、FCM、Web Push は未実装のため、バックグラウンド通知を保証する表示はしません。

## 公開前 TODO

- App Store 提出前に Apple App Review Guideline 4.8 の適用条件と Sign in with Apple の表示要否を、その時点の公式資料で再確認する。
- 試作版の購入 API を実決済 Webhook と冪等な購入確定処理へ置き換える。
- 未完了オンボーディングの定期 cleanup を単一 API プロセス内 timer から、運用基盤の定期 Job へ移す。
