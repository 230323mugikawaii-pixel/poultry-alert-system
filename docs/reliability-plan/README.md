# Call Now 必須信頼性コア — 段階実装の提案

## これは何か

既存の Node.js / TypeScript / PostgreSQL / Prisma を維持する実装計画と差分案。
基準: `b5e85a1697c38e1133c7792d744467e5f83f444d`（PR #33取り込み後のmain）。
リポジトリ、既存DB、OAuth設定、クラウド構成は変更していない。

**まず step-01 だけを実装する。later ディレクトリ全体を一度に適用しない。**

## 最初のPR

処理台帳を既存Gmail処理へ追加する。MailMessageLedger と MailEvaluation の2テーブルのみ。
既存経路が実際の通知を作る唯一の主体である。取得カーソルの意味・通知音・OAuthは変更しない。
本文取得前にIDと処理開始を耐久保存し、実際の判定結果または未判定を記録する。

既存Alertの一意制約は維持する。Alert保存後、台帳更新前に落ちても、同じIDの再試行で既存Alertへ
リンクする。最初のPRでは台帳とAlertの完全な一括トランザクション化はまだ実施しない。
それは次のPRで、既存repositoryのtransaction bodyを抽出して追加する。

## ファイル

- `step-01/additions.prisma`: 最初の2テーブル。既存modelへの逆参照追記が必要。
- `step-01/message-key.ts`: 重複排除キーの純粋関数。
- `step-01/legacy-wrapper.pseudocode.ts`: 既存処理への組込み位置とエラー処理の擬似コード。
- `existing-model-additions.md`: 既存モデルへの追記、OAuthロック列、移行条件。
- `later/additions.prisma`: 後続PRの具体的スキーマ。
- `later/constraints.sql`: 対応するPRに追加するCHECK制約・部分一意インデックス案。
- `later/job-claim.example.ts`: SKIP LOCKEDでの取得、期限切れジョブ回収、fencing例。
- `later/algorithms.md`: 同期、突き合わせ、Outbox、OAuth、合成監視等のアルゴリズム。
- `tests/acceptance.md`: 段階別の合格条件。
- `tests/message-key.test.mjs`: 外部接続不要の8テスト。
- `tests/local-test-results.txt`: この作業環境での純粋関数テスト結果。

## 検証範囲

message-key.tsの8テストだけは、Node.js v22.16.0で実行し、全件成功した。

```sh
node --experimental-strip-types --test tests/message-key.test.mjs
```

Prismaスキーマのユーザーリポジトリへの統合・validate・migration・実PostgreSQL競合テスト、
TypeScript統合ビルド、実Gmail/Graph/APNsの検証はこの提案では実施していない。
`.pseudocode.ts` と `job-claim.example.ts` は、そのままビルド対象に入れるファイルではない。
Prisma案は完全なschema.prismaの代替ではない。既存の生成先・設定を維持して統合する。

## 安全な実行順序

1. 新しいブランチを作る。feature flag初期値はoff。
2. ローカルE2EのDBではなく、使い捨ての専用PostgreSQLを準備する。
3. migrate dev --create-only相当の操作で追加migrationを生成する（既存repoのPrisma設定を確認）。
4. DROP/TRUNCATE/既存データ書換えを含まないかレビューする。
5. 専用DBにだけ既存migration全件＋新migrationを適用する。
6. repo既存の `pnpm db:validate`, `pnpm db:generate`, `pnpm db:check-drift`,
   `pnpm test:postgres`, `pnpm verify` を、接続先を確認して実行する。
7. テスト専用Teamでobserveを有効にし、実メール少数で台帳と旧Alertを照合する。
8. 結果を報告して停止する。main merge、クラウド契約、デプロイは別承認。

`migrate reset` / `db push` を既存DBに実行しない。既存DB名や接続URLに安全そうな名前があるだけで
専用DBと決めつけない。トークン、Cookie、本文、接続URLをテストログに出力しない。

## 意味の定義

- 台帳のMATCHED/NOT_MATCHED/EXCLUDEDは判定完了。UNDETERMINEDは未解決であり成功ではない。
- 外部プロバイダーに完全削除された本文は復元できない。本文を保存しない制約下で無条件のゼロ漏れを
  証明できるとはしない。可能なメールを再取得し、不明区間・判定不能を表示する。
- 任意の過去メールの自動再通知や、本文・添付の保存は追加しない。
- APNs実装は今回の5機能に含めず、送信境界とFakeTransportまで設計する。Outbox準備成功を
  iPhoneへの配信成功と表示しない。
- pause（利用者意思）と認証失効（障害）を分離する。認証失効ではMonitoringEpochを閉じない。
- UIの「正常監視中」は、直近の成功と未解決件数から導出する。DB接続成功だけで緑にしない。

## 参照した既存コード

- apps/api/prisma/schema.prisma
- apps/api/src/modules/alerts/prisma-alert-repository.ts
- apps/api/src/modules/alerts/alert-service.ts
- apps/api/src/db/transaction-retry.ts
- apps/api/src/modules/mail/gmail/gmail-monitoring-service.ts（既存共有内容）
- docs/gmail-push-monitoring.md（既存共有内容）
- package.json / apps/api/package.json

## 公式仕様確認先

- https://www.postgresql.org/docs/17/sql-select.html
- https://developers.google.com/workspace/gmail/api/guides/push
- https://developers.google.com/workspace/gmail/api/guides/sync
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list
- https://learn.microsoft.com/en-us/graph/delta-query-messages
- https://learn.microsoft.com/en-us/graph/outlook-immutable-id
- https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks
- https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events
- https://learn.microsoft.com/en-us/graph/change-notifications-overview
- https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
- https://learn.microsoft.com/en-us/graph/throttling
- https://developers.google.com/identity/protocols/oauth2
- https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CommunicatingwithAPNs.html
