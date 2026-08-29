# 利用者向け通知・フィードバック

## 境界

`UserNotification` はCall Now運営、システム、フィードバック返信を利用者へ届けるための
Provider非依存データです。重要メール検知の `Alert` / `AlertRecipient` とは別物であり、
Alertのfan-out、acknowledge、resolve、SSE、警報音は変更しません。

通知は必ず `userId` で分離します。APIはHttpOnly SessionからUserを特定し、別Userの通知を
一覧取得・既読化できません。通知一覧は `Cache-Control: no-store` で返します。

## フィードバック

利用者は最大2,000文字の本文を送信できます。送信はSame-Origin、HttpOnly Session、共有DB
スロットルを必須とします。フィードバック本文は `FeedbackSubmission.message` に保存し、
AuditEventには本文を残しません。

現時点で運営管理画面および公開された返信APIはありません。将来の認証済み運営ツールは
`UserCommunicationService.recordOperatorReply` を呼びます。この処理は同一トランザクションで
フィードバックを `REPLIED` にし、対象Userの `FEEDBACK_REPLY` 通知を1件だけ作成します。
同じフィードバックへの再試行は既存通知を返すため、返信通知を重複作成しません。

## プライバシー

- 通知とフィードバックをlocalStorageへ保存しない
- OAuth code、state、Cookie、Session token、メール監視credentialを本文へ付与しない
- ブラウザへ運営用返信権限を公開しない
- 通知メッセージはDOMの `textContent` で描画する
