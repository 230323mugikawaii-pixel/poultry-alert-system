# PR02a — Alert ingestトランザクション本体の抽出

検証日: 2026-09-23。step-01の `caea1915cf70d40ba819335892994bffd7e5a3e4`
を基点に、指定ブランチ `phase1/reliability-ledger-20260922` へ積む差分。
設計資料に記載された過去のテスト結果ではなく、以下は今回実行した結果。

## 変更ファイル

- `apps/api/src/modules/alerts/prisma-alert-repository.ts`
  - `ingestWithinTransaction(transaction: Prisma.TransactionClient, input)` を公開メソッドとして抽出。
  - 従来の `ingest` はSERIALIZABLEトランザクションと既存リトライを持つラッパーとして維持。
  - 入力型は既存 `AlertRepository.ingest` から導出し、契約の二重定義を避ける。
- `apps/api/tests/alert-ingest-transaction.test.ts`: 単体テスト6件。
- `apps/api/tests/postgres-concurrency.integration.test.ts`: 実PostgreSQLテスト4件追加。
- `docs/reliability-plan/step-02a-implementation-results.md`: 本記録。

## 挙動不変の根拠

抽出した本体は元コミットと空白を除いて文字列一致。接続・認証・Team・契約の
ACTIVE確認と接続ロック、複合キーによる既存Alert確認、OWNER/参加者の取得、
Alertとネストした宛先作成、AuditEvent作成、返却値の順序・内容を変更していない。
既存Alertでは `created: false` を返し、宛先・監査を再作成しない。

`AlertService`、一意制約、スキーマ、Gmail/台帳コード、フラグ、SSE経路は未変更。
抽出本体の副作用は渡されたtransactionへのDB操作のみ。外部API・通知送信なし。
既存Serviceは従来どおり、リポジトリのコミット成功後、新規作成時だけSSEを起床する。

抽出メソッド自身はtransaction開始・commit・retry・SSEを行わない。
外部から使う場合のSERIALIZABLE指定、トランザクション全体の再試行、コミット後通知は
外側の呼出元の責務。今回、その新しい本番呼出経路は追加していない。

## 今回の実測結果

| 確認 | 結果 |
|---|---|
| `pnpm verify` | 成功。Frontend等128件、API単体256件、format/lint/typecheck/build成功 |
| `pnpm test:postgres` | 30/30成功（既存26＋PR02a追加4）、2.91秒 |
| `pnpm test:postgres:ledger` | 17/17成功、2.92秒。逐次/並行100件、実子プロセスSIGKILL、404、flag off等を再実行 |
| `pnpm db:validate` / `pnpm db:generate` | 成功 |
| migration / drift | 25/25、未完了0、schema driftなし。新規migration不要・追加なし |
| step-01 migration up/down/up | 隔離DBで再実行成功、合成した既存データ・制約を保持 |
| `git diff --check` | 成功 |
| 差分ファイルの秘密情報パターン検査 | 検出0。限定的なパターン検査であり、網羅的監査ではない |

`pnpm verify`では実PostgreSQLテスト47件は意図的にskipされる。
上記の独立した2コマンドで全47件を実行しているため、skipを成功件数には含めていない。
初回の追加テストにあったモック記録の誤りとlint指摘はテスト側で修正し、再実行で成功。

追加したテスト:

- 単体: REAL/TESTそれぞれの保存payloadと、ロック→冪等確認→宛先取得→Alert/宛先→監査→commit→SSEの順序。
- 単体: 既存Alertの返却、追加書き込み・ネストしたtransactionなし。
- 単体: ACTIVE接続とOWNER数の既存ガード。
- 単体: SERIALIZABLE競合の再試行、上限時の既存409エラー、失敗時SSEなし。
- PostgreSQL: REAL/TESTそれぞれで外側のtransactionをrollbackするとAlert・宛先・監査すべて0件。
  commit前の別接続からも0件。通常ラッパーで保存した全業務フィールドと同じ結果。
  自動生成ID・作成更新時刻は別transaction間の比較対象外。
- PostgreSQL: 既存ACKNOWLEDGED Alert、既読・削除済みrecipient、監査行が再実行前後で完全一致。
- PostgreSQL: 本体処理完了時にはSSE 0回、実commit後には1回。その時点で別接続から
  Alert 1・recipient 2・audit 1を取得可能。重複や監査保存後rollbackでは追加起床なし。

使用先は前回作成した専用のPostgreSQL 17.11コンテナ（tmpfs、既存volume非共有）の
合成データDBのみ。稼働中ローカルE2E・通常・本番DBには接続・適用していない。
migration round-tripはテスト自身が新規作成した一時DBに限定。
既存のPrisma migration履歴は編集していない。

既存CIの `pnpm test:postgres` が追加4件を含むファイルを実行するため、
CI定義の変更は不要。最新コミットのCI実行結果はPRのコメントで別途記録する。

## 設計との差分・未確認

設計のPR02aと一致。自由関数ではなく既存Prismaリポジトリの公開メソッドとして抽出した。
Prisma固有のtransaction型は汎用の `AlertRepository` interfaceには追加していない。

実Gmail・実ブラウザでの新規E2Eは未実行。外部送信なしでDB境界と既存回帰を検証した。
Outbox、新フラグ、台帳との同一TX化、PR02b以降、main merge、デプロイ、クラウド変更は未実施。
`later/` の設計ファイルも変更していない。このチェックポイントで停止する。
