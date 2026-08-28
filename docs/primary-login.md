# Primary login design

Call Nowのログイン本人確認とメール監視OAuthは別の機能として扱う。

## Identity rules

- ログイン本人性の正は `ExternalIdentity.provider + providerSubject` とする。
- メールアドレスが一致するだけではUserを自動統合しない。
- 認証済みUserだけが別Providerを明示的に追加できる。
- provider subjectが別Userへ接続済みの場合は追加を拒否する。
- 1人のUserはGoogle、Microsoft、Appleを各1件まで追加できる。
- 最後に残ったログイン方法は解除できない。
- Appleの非公開メールアドレスを通常のメールアドレスと同様に扱い、relay addressを理由に拒否しない。
- Appleから氏名が届くのは通常初回認可時だけなので、届いた場合だけ保存し、後続ログインで空値に上書きしない。

## Provider scopes

- Google login: `openid email profile`
- Microsoft login: `openid email profile`
- Apple login: `name email`
- Gmail monitoring: `gmail.readonly`（別OAuth Client）
- Microsoft mail monitoring: delegated `Mail.Read`（別OAuth registration）

ログインOAuthへGmailまたはMicrosoft Graphのメール権限を追加しない。

## Apple configuration

Apple Credentialが揃っていない環境では `/api/v1/auth/providers` が `APPLE: NOT_CONFIGURED` を返す。フロントはボタンを無効化し、成功を模倣しない。

本番公開前にApple Developer側でServices ID、Sign in with Apple capability、Web return URL、メールリレードメイン、秘密鍵を設定し、秘密鍵はSecret Managerへ保存する。Appleの `form_post` callbackにはHTTPSと `SameSite=None; Secure` のstate Cookieが必要である。

AppleのWeb認証仕様にはPKCEの `code_challenge` / `code_verifier` が定義されていないため、Appleだけは未対応パラメータを送らない。Apple LoginはHTTPS、HttpOnly state Cookie、nonce、5分間・1回限りのauthorization code、署名付きclient secret、ID tokenの署名・issuer・audience・期限検証で保護する。GoogleとMicrosoft LoginはPKCE S256も併用する。

## Release blockers

- App内からアカウント削除を開始・完了できるAPIと画面
- Apple Credentialを設定したstaging環境での実OAuth E2E
- Microsoft login専用App registrationを設定したstaging環境での実OAuth E2E
- Provider追加・解除とApple非公開メールを含むSafari実機回帰確認

アカウント削除ではUser、Session、ExternalIdentity、Team所有権、契約、監視credential、監査保持要件を整理し、単純な行削除でデータ整合性を壊さないこと。
