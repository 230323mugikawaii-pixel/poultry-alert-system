# PR03a — Outboxディスパッチャ（FakeTransportのみ）

検証日: 2026-09-23。基点: `e47986c5ab2dc256669c04e9bdf891df1d3fd3e9`（02b）。
ブランチ: `phase1/reliability-ledger-20260922`。以下は今回の実装で実行した結果。

## 実装と境界

- 02bの`reliability_outbox`のみ使用。新規テーブル・列・migrationなし。
- 独立CLI `pnpm outbox:dispatch`。API起動に組み込まず、既存SSE・Gmail処理を変更しない。
- `RELIABILITY_OUTBOX_DISPATCH_MODE=off`が既定。OFF時はDBクライアントすら作らず終了。
  `fake`だけ明示的に指定可能。CLIは.envを暗黙に読まず、接続先はプロセス環境で明示する。
  `APP_ENV=production`でのFake起動は拒否。既存環境のフラグ・起動設定は変更していない。
- `--once`は1回だけ実行。通常は1秒間隔で1件ずつ処理。SIGINT/SIGTERMで新規取得を止め、
  実行中transportにAbortSignalを伝える。未完了leaseは期限切れ回収可能な状態で保持。
- `FOR UPDATE SKIP LOCKED`で取得し、DB時計でdue/expiryを判定。
  取得ごとにattemptsとleaseGenerationを1増加、新しいleaseTokenを発行。lease既定45秒。
- 完了更新は短いDB-only TXで**先に行ロックを取得し、別SQLで期限を再確認**。
  status=RUNNING、token、generation、有効期限がすべて一致する場合だけ更新。
- FakeTransport呼び出しは取得・eligibility確認の後、DB TX／DB再試行の外で1回。
  Team、契約、OWNER membership/User、ACTIVEかつ未削除参加者を再確認。
  Alert本文やOAuth情報を取得せず、transportに渡すのは識別子だけ。
- 成功は`DISPATCHED`＋dispatchedAt。一時失敗は`RETRY_WAIT`、永久失敗は`BLOCKED`。
  再試行は1s/2s/4s…最大300sのDB時計ベース。10回の試行上限後はRETRY_EXHAUSTEDで保持。
  attemptsは**取得時にのみ**加算し、失敗確定と再取得で二重加算しない。
- transport timeout既定10秒（leaseより短い）。タイムアウト・停止後の遅延結果は更新しない。
  未知の例外本文は保存せず、固定の安全なreason codeへ変換。
- payloadは02bの固定`{schemaVersion:1}`とDB CHECKのまま。既読・停止・削除・監査を更新しない。

**DISPATCHEDはFakeTransportのシミュレーション完了であり、実配信・APNs受付ではない。**
実APNsクライアント、認証済み端末レジストリ、NotificationDelivery、実通知、ACKは未実装。
将来のAPNsには設計どおり別の耐久delivery行・endpoint versionの境界が必要。
FakeのDISPATCHEDを将来のPROVIDER_ACCEPTEDへ読み替えてはならない。

lease fencingはDB更新を防ぐもので、外部送信の取消・exactly-onceを保証しない。
送信直後のクラッシュでは再呼び出しがあり得るため、安定したeventKeyで受信側が冪等化する。
FakeTransport自体は実I/Oを行わない。クラッシュ試験では、別プロセス間の冪等性を実証するため
**テストDB内だけ**に作ったFake受信台帳のUNIQUE/ON CONFLICTを使う。
本体DBへの配送テーブル追加ではない。AbortSignalも協調取消であり、外部取消保証ではない。

## migration・隔離

PR03a migration追加なし。専用PostgreSQL 17コンテナを新規作成し、全26 migrationを正規deploy。
適用26、pending 0、Prisma schema driftなし、validate/generate成功。
既存PR01/02bのmigration up/down/up試験も専用DBで再実行して成功。
Prisma migration履歴の手書き変更はしていない。

今回の親テストDBはloopbackポート25441、tmpfs、既存volume共有なし。
PR03a試験はさらに一意な`callnow_pr03a_test_<uuid>`を作成し、26 migrationを適用して実行。
試験終了時に削除するのは、この試験が作成した合成データ専用DBのみ（使い捨て）。
旧PR01/02bコンテナ、稼働E2E、通常、本番DBへの適用・reset・データ削除はなし。

## テストと実測結果

実PostgreSQL PR03a: **14/14成功、8.91秒**。個別時間はverbose実行時の測定値。

| テスト | 実測結果 |
|---|---|
| 100 worker / 100 job | 処理88ms（fixture含む試験1110ms）。DISPATCHED100・eventKey100・attempts各1 |
| 100 worker / 1 job | 44ms。Fake呼出1、DISPATCHED1、IDLE99 |
| 行ロック中のSKIP LOCKED | 34ms。別行を取得し、ロック解除後に残りも取得 |
| 期限切れ回収・旧token/generation拒否 | 193ms。自然経過で回収、成功/失敗すべての旧更新を拒否 |
| 完了更新の行ロック待機中に期限切れ | 296ms。ロック解除後も更新拒否 |
| RETRY_WAIT→再試行→BLOCKED | 3104ms。DB時刻の1s/2s待機、attempts1/2/3。時刻・カウンターを改変せず検証 |
| Fake処理中SIGKILL | 1746ms。親がコミット済みRUNNINGを確認してkill、新OSプロセスで期限切れ回収 |
| Fake処理後・完了記録前SIGKILL | 1784ms。Fake受信記録1を確認してkill、再呼出でも論理受信記録1、Outbox完了1 |
| DB完了処理のP2034再試行 | 54ms。transportは1回。別接続からNOWAITロック可能＝send中に行ロックなし |
| 参加者/OWNER/Team/契約の無効化 | 4件成功。対象へtransportを呼ばず、既存recipient履歴保持 |
| flag OFF・payload制約 | 成功。Outbox不変、任意payload拒否 |

SIGKILLは例外throwによる代用ではない。親が別DB接続で保存済み状態を読み、子プロセスを
実際にSIGKILLし、別のOSプロセスを起動して再取得・完了を確認した。
leaseの期限切れは自然経過で確認し、成功させるためのlease時刻書換えはしていない。
P2034の例外注入は別のDB再試行テストであり、SIGKILL試験とは区別している。

その他:

- 単体12件追加: OFF、Fake完了、backoff、返却値allowlist、例外の安全化、timeout/遅延resolve、
  shutdown、retry上限、lease喪失、設定不正。
- `pnpm verify`: Frontend等128件、API単体272件、format/lint/typecheck/build成功。
- `pnpm test:postgres`: 30/30、`test:postgres:ledger`: 17/17、`test:postgres:outbox`: 19/19。
- PostgreSQL合計80件は通常verifyではskip。専用コマンドで80件を別途実行して成功。
- CLIのOFFを不正なダミーDB設定で実行し、DBアクセスなしで正常終了することを確認。
- `git diff --check`成功。CIに`test:postgres:dispatcher`を追加。
- 最新コミットCIのURLと結果はPRコメントへ記録する。

## 設計との差分・修正した問題・未確認

1. 汎用ReliabilityJobの例を既存Outbox列へ適用。Webhook受付/ACK、SYNCジョブは03bへ分離。
2. 実送信/PROVIDER_ACCEPTEDは未実装。Fake専用戻り値`FAKE_COMPLETED`と識別子だけの
   transportインターフェースを採用。APNsのendpoint registryを推測して追加していない。
3. 初期実装の単一CTEでは、WHERE期限判定が行ロック待ちより先に評価されるケースを実DBで再現。
   設計のlock-then-finishに合わせ、ロック取得後の別SQLで時計を再評価するよう修正。回帰成功。
   SKIP LOCKEDの用途・制約は[PostgreSQL 17公式仕様](https://www.postgresql.org/docs/17/sql-select.html#SQL-FOR-UPDATE-SHARE)も照合。
4. 初期テストの型/lintと、合成membershipのLEFT時刻fixture不備を修正後、全件再実行。
5. 10回上限・最大5分backoff・10秒timeout・45秒leaseを具体値として採用。
   上限到達行は削除せずBLOCKED。解除/再実行UIや自動オペレーター機能は追加していない。

未実行/対象外: 実APNs・実配送・実Gmail/実ブラウザE2E、Webhook受付ACK、PR04以降、
稼働環境での長時間運転・本番性能評価。予約保存やFake成功を配信成功として報告しない。
main merge、デプロイ、クラウド変更、稼働DB適用、実メール/実通知送信は未実施。

## 変更ファイル一覧

- `apps/api/src/modules/mail/reliability/prisma-outbox-queue.ts`
- `apps/api/src/modules/mail/reliability/outbox-dispatcher.ts`
- `apps/api/src/modules/mail/reliability/outbox-transport.ts`
- `apps/api/src/cli/outbox-dispatch.ts`
- `apps/api/tests/outbox-dispatcher.test.ts`
- `apps/api/tests/outbox-dispatcher.postgres.integration.test.ts`
- `apps/api/tests/fixtures/outbox-dispatcher-crash-child.ts`
- `apps/api/tests/fixtures/mail-ledger-harness.ts`（一意なPR03aテストDB名の許可のみ）
- `apps/api/package.json`
- `package.json`
- `.github/workflows/ci.yml`
- `.env.example`（説明・既定OFFのみ）
- `docs/reliability-plan/step-03a-implementation-results.md`
