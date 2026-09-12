# Call Now

GmailやMicrosoft 365へ届く大切なメールを、停止するまで繰り返し音で知らせるための試作Webアプリです。

## 現在の料金仕様

- 基本料金：年額6,000円
- キーワード：3個まで基本料金、4個目以降は1個につき年額100円
- 監視用メールアカウント：GmailとMicrosoft 365を複数同時接続でき、接続ごとに再認証・解除可能

## ログインとメール監視

- Google、Microsoft、Appleの本人確認はサーバー側OAuthで行い、ログイン状態はHttpOnly Cookieの
  Phase 1 Sessionだけを正とします。
- GoogleとMicrosoftのログインでは `openid`、`email`、`profile` だけを要求します。
- ログインに使う各社のパスワードはCall Nowでは取得・保存しません。
- 1人の利用者へ複数のログイン方法を追加できます。本人性はメールアドレスではなく、各社のprovider subjectで確認します。
- AppleのCredentialが未設定の環境ではAppleログインを「準備中」と表示し、成功を模倣しません。
- 新規管理者の初回設定では、GoogleまたはMicrosoftの監視設定OAuthを入口にして、1回の操作で
  本人識別と監視権限を取得します。内部ではExternalIdentityとMailAuthorizationを分離し、
  メールアドレス一致だけでUserを統合しません。
- Gmail監視では `gmail.readonly`、Microsoft 365 / Outlookでは delegated `Mail.Read`だけを
  要求します。既存のPrimary Login基盤は復旧・追加ログイン方法向けに保持します。
- 監視用refresh tokenはブラウザへ返さず、サーバー側で暗号化して保存します。
- 旧形式のlocalStorageメールアドレスは本人確認に使用しません。

## Gmail常時監視

- Gmail / Google Workspaceの有効な契約では、Gmail `users.watch` と認証済みPub/Sub pushから
  History APIの差分を取得し、Provider別キーワードに一致した新着INBOXメールだけをREAL Alertへ渡します。
- 件名・本文は照合中だけ扱い、DB・監査ログ・アプリログへ保存しません。添付ファイルは検索しません。
- watchは期限前の定期更新が必要です。運用設定、Google Cloud側の最小権限、障害復旧、staging E2E手順は
  [docs/gmail-push-monitoring.md](docs/gmail-push-monitoring.md) を参照してください。

## 利用者向け通知とフィードバック

- Homeは監視アカウントを中心に表示し、運営・システム・フィードバック返信は右上のベルから
  確認します。未読件数と既読状態はUserごとにサーバーで管理します。
- フィードバックは本文だけを送信し、返信スレッドは作りません。将来運営が返信した場合は、
  対象Userだけの通知として届けるデータ経路を用意しています。
- 重要メールのAlert、AlertRecipient、SSE、確認・停止処理は利用者向け通知とは別のまま維持します。

## 通知メンバーとAlert

- 通知メンバーはOAuthを使わず、個別のCall Now IDと一度だけ表示されるパスワードでログインします。
- AlertはOWNERとACTIVEな通知メンバーへ同じトランザクションで割り当てます。
- 同時に確認しても最初の1人だけを確認者として記録します。
- アプリを開いている間はSSEで更新します。バックグラウンド通知は今後APNs、FCM、Web Pushで実装します。
