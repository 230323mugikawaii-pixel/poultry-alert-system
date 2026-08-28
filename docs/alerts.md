# Alert・確認応答・アプリ内リアルタイム更新

## 検知イベントと冪等性

メール監視ジョブは、検知したメール本文や認証情報ではなく、Team、監視接続、Provider側の
イベントID、検知キーワード、検知時刻だけを `AlertService.ingest()` へ渡します。
`sourceMailConnectionId + sourceEventId` は一意で、同じProviderイベントを再処理してもAlertと
配信対象は増えません。HTTPの一般利用者向けAlert APIから、検知イベントの登録はできません。

## 配信対象

Alert作成と配信対象の作成は同一DBトランザクションです。対象は次のとおりです。

- ACTIVEなOWNER 1人
- 作成時点でACTIVEな通知メンバー

利用停止済みの通知メンバーは新規Alertの対象にしません。`AlertRecipient` は配信先の種類と
`IN_APP` channelを持ち、将来APNs、FCM、Web Pushを追加する際もAlert本体やメールProviderから
分離して拡張します。

## 確認と解決

OWNERと対象通知メンバーは自分のTeamに属するAlertだけを取得・確認できます。確認は
`status = ACTIVE` を条件としたDB更新で、同時操作でも最初の1人だけを確認者として記録します。
後続の操作は成功レスポンスと `alreadyAcknowledged: true` を返し、二重確認者にはしません。
画面には確認者の表示名と確認時刻を反映し、後続の利用者へ誰が対応中かを案内します。
OWNERだけが確認済みAlertを `RESOLVED` にできます。

通知メンバー向けレスポンスにはメール件名・本文・メールアドレス・ProviderイベントID・
OAuth token・Cookie・Session tokenを含めません。

## リアルタイム更新の範囲

OWNER画面と通知メンバー画面は、認証済みSSEを使って5秒間隔でDB状態の変更を受信します。
SSEは各pollでSessionを再確認するため、ログアウト、Session失効、通知メンバー利用停止後は
終了します。複数APIインスタンスでも共有メモリに依存しません。

この段階で保証するのはWebアプリを開いている間の更新と警報音だけです。アプリを閉じた状態、
OSによるタブ休止、端末の省電力状態では通知を保証しません。バックグラウンド配信は将来の
APNs、FCM、Web Push接続で実装します。
