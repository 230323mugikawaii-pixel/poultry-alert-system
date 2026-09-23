# PR02b — LEGACY判定・Alert・受信者別Outboxの原子化

検証日: 2026-09-23。基点はPR02a `f1491fb1b1edf0fad8c6c9fbf5afecb35fe2750e`。
ブランチ: `phase1/reliability-ledger-20260922`。既存Draft PRに独立コミットで積む。
以下は今回の実装に対する実測であり、設計資料の過去結果の流用ではない。

## 実装契約

- `MAIL_LEDGER_MODE=off`（既定）: 従来経路。台帳・Outboxアクセスなし。
- `legacy`: PR01観測経路のまま。Outboxアクセスなし。
- `legacy-outbox`: LEGACY評価のMATCHED確定、台帳↔Alertリンク、Alert・宛先・監査、
  受信者ごとのOutboxを1つのSERIALIZABLEトランザクションで保存。
- 新経路は02aの `ingestWithinTransaction` と、今回抽出した
  `finishWithinTransaction` を使用する。既存ガード、raw Gmail ID、Alertの一意制約は維持。
- AlertServiceの入力検証とコミット後SSEは共通。追加した内部persist callbackは
  外側のコミット完了後にのみresolveする。既存経路は従来のrepositoryを使用する。
- メール取得・OAuth・キーワード照合はTX外。再試行対象はDB処理だけ。
- Outboxは書くだけ。送信・ディスパッチャ・APNs・ACK・復旧ワーカーなし。

Outboxの冪等キー:

```text
SHA256(UTF-8 JSON.stringify([
  "alert-available-v1", messageKey, recipientId.toLowerCase()
]))
```

64桁小文字hexを `eventKey UNIQUE` に保存。INSERT ON CONFLICT DO NOTHINGの後、
Team・Alert・recipient・kindの衝突ガードを行う。重複時はstatus、attempts、時刻を変更しない。
OWNER＋ACTIVE参加者1人なら、台帳1・評価1・Alert1・宛先2・Outbox2・作成監査1。
これはユーザーが訂正・確定した**受信者ごと1件**の条件に従う。

既存Alertが見つかった再実行では、既存宛先を再作成せず、その同じrecipientへ予約する。
既読・確認・削除・解決状態や監査を初期化せず、`created:false` ではSSEを再起床しない。
migration自体は過去Alertの一括予約・再通知を行わない。

## migration・隔離

追加migration: `20260923000200_reliability_outbox`（26番目）。

- 新規Outboxテーブル・enum・索引・FK・CHECKのみ。
- Alert `[id, teamId]`、AlertRecipient `[id, alertId]` の参照用UNIQUEを追加。
  既存の主キーや冪等UNIQUEは変更・削除していない。
- 設計の `alert_outbox_has_recipient` と複合FKで、他Team／他Alertのrecipientを拒否。
- payloadは固定 `{schemaVersion:1}` のみ。DB CHECKでも他のpayloadを拒否する。
- 本文・添付・OAuthトークン・接続URLをOutboxへ保存しない。

今回専用のPostgreSQL 17.11コンテナを使用。loopbackポート25440、データ領域tmpfs、
既存volume非共有。以前のPR01用コンテナ、ローカルE2E、通常、本番DBには適用していない。

結果: 正規のPrisma migrate deployで**26/26適用、pending 0、driftなし**。
新規の合成データDBでup/down/upを実行し、既存データ・列・制約を保持、
down後は追加索引も消えて元のスキーマと一致。upだけで過去Outboxを生成しないことも確認。
PR01のup/down/upも独立して再実行して成功。

down SQLは `tests/fixtures/reliability-outbox-down.sql`。テストが新規作成したDBだけで実行。
Outbox・今回追加した参照索引・enumだけを戻し、CASCADEを使用しない。
テスト終了時に削除するのは、そのテスト自身が作成した一意な合成データDBのみ。

round-trip DBには意図的にPrisma履歴を作らずSQL可逆性を検証する。
通常deploy先の `_prisma_migrations` は編集しない。これはPrismaの自動downではない。
稼働環境のrollbackは別レビューが必要で、適用済み履歴の手書き変更は行わない。

## テストと実測

実PostgreSQL PR02b: **19/19成功、4.27秒**。
個別時間はverboseでの追加実行値（マシン負荷に依存）。

| テスト | 結果 |
|---|---|
| 同一メール100回逐次 | 1,266ms。台帳1・評価1・Alert1・宛先2・Outbox2・監査1、SSE1 |
| 同一メール100回並行 | 1,146ms。同じ件数、各recipientに1予約 |
| commit直前SIGKILL | 約604ms。子のTX内ではMATCHED1/Alert1/宛先2/Outbox2/監査1を確認。親からは全て0。kill後も0、新OSプロセスの再実行で一度だけ確定 |
| commit直後SIGKILL | 約554ms。親から確定済み各行を確認してkill。再実行後もOutbox2、再fetch0、追加SSE0 |
| TX／SSE境界・保存後失敗 | provider fetch時に開いたTXが0、commit前SSE0、commit後SSE1。保存後失敗は全結果rollback |
| SERIALIZABLE再試行 | P2034注入でDB処理2回、本文取得1回、SSE1回、各レコード重複なし |
| 既存Alertの補完 | 既読・削除・RESOLVED・既存宛先・監査が完全一致、再取得なし |
| off / legacy | 従来のAlertとSSE、Outbox0。Outboxテーブル作成前でも両モード正常 |
| 受信者選別 | OWNER＋ACTIVE参加者のみ。DISABLED/deleted参加者には宛先も予約も作成しない |
| Outbox再取得 | 合成したRETRY_WAIT/attempts/availableAtを再実行で巻き戻さない（送信処理は未実装） |
| メッセージ404 | UNDETERMINED/MESSAGE_GET_404、再取得なし、Outbox0 |
| 非一致・停止期間の履歴回復 | NOT_MATCHED/EXCLUDED、Alert0、Outbox0。History回復の境界仕様は未変更 |
| DB制約 | missing recipient、他Team、他Alert recipient、任意payload、重複eventKeyを拒否 |
| スコープ・衝突 | 不正Team/connection対応、別recipientが占有するeventKeyを拒否、余分な保存なし |
| PAUSED接続 | 既存02aのACTIVEガードで拒否、Alert/Outbox0 |
| migration up/down/up | 上述の既存合成データ・スキーマ保持を確認 |

**クラッシュ境界の意味:** 本文取得前の耐久台帳・未確定評価は、先にコミットされたPR01の
証拠として残す。直前killではその1行ずつはEVALUATING/decisionAt=nullのまま残り、
今回のTXに属するMATCHED確定・リンク・Alert・宛先・監査・Outboxが0になる。
耐久アンカーまで削除して「全rollback」とは扱わない。再実行はテストで明示的に行い、
自動復旧ワーカーがあるとは主張しない。

クラッシュ試験はtest-only DB proxyで外側のTX完了位置を観測し、子から実DB件数の
チェックポイントを受け取る。親が別DB接続で可視性を確認して本当にSIGKILLする。
再実行も別OSプロセス。例外throwでクラッシュ試験を代用していない。
SERIALIZABLE再試行・rollback失敗注入の例外テストは、このSIGKILL試験とは別項目。

その他:

- `pnpm verify`: Frontend等128件、API単体260件、format/lint/typecheck/build成功。
- `pnpm test:postgres`: 30/30（02a追加4件を含む）成功。
- `pnpm test:postgres:ledger`: 17/17（PR01逐次/並行100、SIGKILL、404、flag off等）成功。
- PostgreSQL計66件は通常verifyではskip。上記とoutbox専用コマンドで別途すべて実行。
- Prisma validate/generate、git diff --check成功。
- 差分の限定的秘密情報パターン検査: 新規検出0。既存例示設定のパターンは値を出力せず区別。
- 追加テストの初期fixture/比較/型・lint不備を修正後、全件再実行。
- 最新コミットCIの実行URLと結果はPRコメントへ記録する。CIにoutbox PostgreSQL試験を追加。

## 設計からの限定変更・未確認

1. ユーザー確定どおり、設計擬似コードのAlert ID由来キーを **messageKey＋recipientId由来**にした。
2. 今回はALERT_AVAILABLEのみ。USER_MONITOR_STATUS、OPERATOR_INCIDENT、incidentId/FK、
   ReliabilityIncident等は対象外として未追加。Outboxのlease/status欄は設計どおりの予約欄で、
   今回のwriterはPENDINGを作るだけ。
3. payload固定値CHECKを追加し、記録だけの段階で本文や秘密情報を入れられないようにした。
   別payload種別の導入時は別migration・レビューが必要。
4. PR01 migration試験は「最後のmigrationがPR01」という仮定だけを除去。
   PR01自身のup/down検証は元と同じ24件を前提に実行し、正規deploy先では全26件を照合する。

原子性の保証対象は `legacy-outbox` を通る書き込み。
off/legacyの旧AlertはOutboxなしでも従来どおり存在でき、全過去行を一括更新しない。
既存Alertが明示的な再実行で処理された場合だけ、同じ宛先への予約を冪等に補完する。
異なるモードの旧writerを混在させた全経路の原子化や、通知のexactly-once到達は主張しない。

実Gmail・実ブラウザ・APNs・配送E2Eは未実行／対象外。予約保存を「通知送信成功」とは扱わない。
ディスパッチャ、ACK、ジョブ、main merge、デプロイ、稼働DB適用、実メール送信、クラウド変更は未実施。
既存runtimeの.envは変更せず、新フラグも有効化していない。PR02bの報告で停止する。

## 変更ファイル一覧（02aからの差分）

Schema/migration:

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260923000200_reliability_outbox/migration.sql`

Runtime:

- `apps/api/src/modules/mail/reliability/prisma-atomic-mail-ingestion.ts`
- `apps/api/src/modules/mail/reliability/mail-reliability-options.ts`
- `apps/api/src/modules/mail/reliability/prisma-mail-ledger.ts`
- `apps/api/src/modules/mail/gmail/gmail-monitoring-service.ts`
- `apps/api/src/modules/alerts/alert-service.ts`
- `apps/api/src/config/env.ts`
- `apps/api/src/server.ts`
- `apps/api/src/cli/gmail-renew-watches.ts`
- `.env.example`（既定offの説明のみ）

Tests / CI / documentation:

- `apps/api/tests/mail-outbox.test.ts`
- `apps/api/tests/mail-outbox.postgres.integration.test.ts`
- `apps/api/tests/mail-outbox-migration.postgres.integration.test.ts`
- `apps/api/tests/fixtures/atomic-mail-test-database.ts`
- `apps/api/tests/fixtures/mail-outbox-crash-child.ts`
- `apps/api/tests/fixtures/reliability-outbox-down.sql`
- `apps/api/tests/fixtures/mail-ledger-harness.ts`
- `apps/api/tests/mail-ledger-migration.postgres.integration.test.ts`
- `apps/api/tests/mail-message-key.test.ts`
- `apps/api/package.json`
- `package.json`
- `.github/workflows/ci.yml`
- `docs/reliability-plan/step-02b-implementation-results.md`
