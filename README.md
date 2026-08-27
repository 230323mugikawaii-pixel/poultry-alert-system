# Call Now

GmailやMicrosoft 365へ届く大切なメールを、停止するまで繰り返し音で知らせるための試作Webアプリです。

## 現在の料金仕様

- 基本料金：年額6,000円
- キーワード：3個まで基本料金、4個目以降は1個につき年額100円
- 監視用メールアカウント：1利用者につき1件固定、追加料金なし

## ログインとメール監視

- Google本人確認はサーバー側OAuthで行い、ログイン状態はHttpOnly Cookieの
  Phase 1 Sessionだけを正とします。
- ログインでは `openid`、`email`、`profile` だけを要求します。
- GoogleのパスワードはCall Nowでは取得・保存しません。
- Gmail監視権限はログインとは別のOAuthで取得し、`gmail.readonly`だけを要求します。
- Microsoft 365 / Outlookは別のOAuthで delegated `Mail.Read`だけを要求します。
- 監視用refresh tokenはブラウザへ返さず、サーバー側で暗号化して保存します。
- 旧形式のlocalStorageメールアドレスは本人確認に使用しません。
