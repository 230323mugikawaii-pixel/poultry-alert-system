# PR07a — Outboxからモバイル配信インテント生成（送信なし）

実施日: 2026-09-24。ブランチ: `phase3/notification-delivery-20260924`。
main `b39c6ea4c472e7a12cbb991781d7f9760c70c821` から作成後、依存PR06/#37の
`1d8b72f9a562b04ef95cce3cfb2f54927d5011b0` までfast-forwardした。
レビューbaseは `phase3/device-push-registry-20260924`。main/#37自体は変更しない。

## 実装と境界

- `NotificationDelivery` と `NotificationDeliveryState` を追加。
  `@@unique([outboxId,targetKey,targetVersion])` とDBの `INSERT ... ON CONFLICT DO NOTHING` で冪等化。
  `targetVersion` はロック中のACTIVE登録の `tokenVersion`。
- `MOBILE_PUSH_DELIVERY_MODE=off|shadow`、既定off。
  offのCLIはplannerを構築せず、03aのprepare→FakeTransport→finishをそのまま使用する。
  既存の `RELIABILITY_OUTBOX_DISPATCH_MODE=off` ならDBクライアントも構築しない。
- shadowは既存claim（SKIP LOCKED）を使い、1つのSERIALIZABLE TXで
  lease/token/generation/payload、Team/契約/宛先/本人の現在の適格性、端末の有効性を再確認する。
  OWNERのUserとMEMBERのNotificationMemberを別種別で絞り、Teamも照合する。
- そのTX内でdelivery INSERTと親outboxの最終状態更新を行う。
  端末行をFOR SHAREして、rotation/revocationとの競合中に古いversionを無検証で確定させない。
  最後にもDB時計でleaseを検証し、期限切れなら例外で全INSERTをrollbackする。
- 外部I/O、暗号化/復号、FakeTransport/PushTransport呼出しはshadow TXにもTX外にもない。
  plannerは端末のtargetKey/versionだけを取得し、暗号文・hash・トークン・本文を取得しない。
- 再処理では既存deliveryのstate/attemptCountを初期化しない。read/停止/削除状態やAlert履歴は変更しない。
  `PROVIDER_ACCEPTED`、`acceptedAt`、`apnsRequestId` は一切書き込まない。

## 設計の具体化・差分

1. 設計の仮targetKeyはVarChar(191)だったが、完成済みPR06の公開IDはUUID。
   実レジストリに合わせUUID＋実FK（RESTRICT）とした。既存targetKeyは変更しない。
2. 現repoに有効なAPNs設定検証はまだない。plannerの設定入力は
   秘密を含まない同期snapshot `missing|validated` のみとし、**実CLIは常にmissing**。
   validatedは今回の合成テストでのみ注入する。APNs設定項目・秘密情報・有効化フラグの追加はしない。

| 状態 | delivery | 親outbox |
|---|---|---|
| mobile off | 作成なし | 従来Fake経路と同一 |
| shadow、適格recipient、ACTIVE端末あり、validated snapshot | 端末ごとPENDING | 同じTXでDISPATCHED |
| shadow、設定なし、ACTIVE端末あり（現在のCLI） | 端末ごとWAITING_CONFIGURATION | 同じTXでBLOCKED / MOBILE_CONFIGURATION_MISSING |
| shadow、ACTIVE端末なし | 0件（架空targetを作らない） | BLOCKED / MOBILE_NO_ACTIVE_TARGET |
| recipient/Team/契約/本人が不適格 | 0件 | BLOCKED / RECIPIENT_INELIGIBLE |

DISPATCHEDは配信インテント展開完了であり、実配信・APNs受付成功ではない。
設定不足や端末なしからの解除・再計画、送信worker、targetVersion再検証送信は後続PRの範囲。
本PRではBLOCKEDを自動解除しない。テストの再queue/rotationは合成DBだけの障害・冪等試験。

3. PR06のmigration往復fixtureは「registry migration以外全部」から「registryより前だけ」へ変更。
   後続FKを持つ本migrationをregistry作成前に適用してしまわないためのテスト専用修正。
   03aの隔離DB用TRUNCATEにも新FKの子tableを明示追加。実装03a queue/transportは変更なし。
4. 既存親のFKや一意制約、既存migrationは変更しない。新tableだけに非負counter/version CHECKを追加。

## 隔離・migration

- 新規PostgreSQL17コンテナ `call-now-delivery-pr07a-pg17-20260924`、loopback 25446、専用tmpfs。
  通常/E2E/既存PR用コンテナ・ボリュームとは別。接続文字列・秘密値は報告しない。
- `20260924000400_notification_delivery_intents` は先行28件の隔離schemaから
  Prisma migrate diff --scriptでcreate-only相当生成。新table/enum/index/FK/CHECKのみ。
  旧列変更・旧データ更新・DROP/TRUNCATEなし。
- 専用使い捨てDBに先行全28件＋合成User/Team/契約/Google接続/参加者/Alert/宛先/Outbox/端末登録を作成。
  **up→down→up PASS**。全既存tableのデータ・列・制約・indexをハッシュ比較し不変。
- down SQLは今回のtableとenumだけを削除、CASCADEなし。実運用のrollback手順ではない。
  PR06を戻す際はこの従属migrationを先に戻す必要がある。
- 往復試験DBはSQL適用のみでPrisma履歴を捏造しない。
  別の隔離管理DBでは正規のmigrate deployで**29/29、pending/失敗0、driftなし**。
  db push/migrate resetは使用しない。
- 自動削除したのは今回suiteが生成した一意な使い捨てDBのみ。既存DB/履歴/ボリュームは削除しない。

## 実測テスト（設計資料の結果の流用なし）

| コマンド | 結果 |
|---|---|
| `pnpm test:postgres:delivery` | **19/19 PASS**（18動作＋1往復）、9.39秒 |
| `pnpm test:postgres` | **30/30 PASS** |
| `pnpm test:postgres:ledger` | **17/17 PASS** |
| `pnpm test:postgres:outbox` | **19/19 PASS** |
| `pnpm test:postgres:dispatcher` | **14/14 PASS** |
| `pnpm test:postgres:jobs` | **22/22 PASS** |
| `pnpm test:postgres:device` | **16/16 PASS** |
| `pnpm verify` | **PASS**、Frontend128、API290（新規unit5含む）、format/lint/typecheck/build |
| `pnpm db:validate` / `db:generate` | **PASS / PASS** |
| `pnpm db:check-drift` | **差分なし** |
| migration deploy | **29/29、pending 0** |
| `git diff --check` | **PASS** |

PG合計**137件PASS**。verifyでPG137件skipは上記実PostgreSQLの別実行で検証済み。
CIにdelivery suiteを追加。検証commitと最新CI結果はPR本文へ記録する。

新規PG試験:

1. OWNER2端末＋MEMBER1端末→delivery3、outbox2 DISPATCHED。最新tokenVersion、送信0、acceptedAtなし。
2. 再処理で重複なし、既存CANCELLED/attemptCount保持。rotation後は別versionの1行。
3. 設定なし→WAITING_CONFIGURATION＋BLOCKEDが原子的に残る。
4. 端末0・REVOKEDのみ→delivery0、BLOCKED（2ケース）。
5. Team停止、契約終了、OWNER削除、MEMBER無効→不適格分なし、既存recipient不変（4ケース）。
6. 別Teamの端末は混入しない。
7. **100 worker同時: 1 DISPATCHED / 99 IDLE / delivery2 / Fake send0**。
8. **同じclaimへ100同時処理: 1 DISPATCHED / 99 LEASE_LOST / delivery2**。
9. 自然lease失効→再取得generation前進、古いclaimのINSERT/完了拒否。
10. targetロック待機中にlease失効→delivery0、親未完了。
11. 両書き込み後のTX例外→両方rollback、安全な固定errorのみ。
12. **実子プロセスSIGKILL**: commit前は外部からdelivery0/親RUNNINGを確認、終了後lease回収でdelivery2/親DISPATCHED。
13. **実子プロセスSIGKILL**: commit後はdelivery2/親DISPATCHEDを確認、再実行IDLEで重複なし。
14. mobile off: Fake send2/outbox2 DISPATCHED/delivery0。
15. migration往復・旧データ/schema不変・新tableなしでoffのFake処理が完了。

新規unit5件: mode既定off/不正値拒否、global off DB未使用、shadow Fake未呼出し、
planner不足/abort時claimなし、mobile off planner未呼出し。

初回試験でテストfixtureのregistry引数/versionとtargetKey列名の誤り、型/lintを検出して修正。
合格結果は修正後の再実行。動作上の既知失敗は残っていない。

## 変更ファイル一覧（#37以降）

- `apps/api/prisma/schema.prisma`、新migration SQL
- `apps/api/src/modules/device-push/mobile-delivery-planner.ts`
- `apps/api/src/modules/mail/reliability/outbox-dispatcher.ts`
- `apps/api/src/cli/outbox-dispatch.ts`、`config/env.ts`、`.env.example`
- `apps/api/tests/notification-delivery.test.ts`、`notification-delivery.postgres.integration.test.ts`、`notification-delivery-migration.postgres.integration.test.ts`
- `apps/api/tests/fixtures/delivery-test-database.ts`、`delivery-crash-child.ts`、`notification-delivery-down.sql`
- 既存試験互換: `fixtures/device-test-database.ts`、`outbox-dispatcher.postgres.integration.test.ts`
- env fixtureにoffだけ追加: alert-routes/app/auth-routes/google-auth-routes/mail-connection/team-routes/user-communication-routes の各test
- ルート/APIの `package.json`、`.github/workflows/ci.yml`、本報告書

## 未確認・停止位置

- 実APNs設定・受付・送信・端末到達・iOS・実PushTransportは**未実装/未検証（07b以降）**。
- shadowの設定充足経路は合成snapshotでのみ確認。現在CLIはfail-closedで待機記録のみ。
- 稼働DBへの適用、main merge、クラウド変更、デプロイ、実メール/実通知は**未実行**。
- Draft #37未マージに依存するstacked PRとして停止。通常API、Frontend、Gmail監視、既存検証プロセスは変更/再起動しない。
