# PR07b — Fake PushTransport / fenced delivery worker

実施日: 2026-09-25。ブランチ: `phase3/apns-worker-20260925`。
基点: Draft #38 / `phase3/notification-delivery-20260924` /
`ab3c00c45335154851b132c51dac2c4357426d63`。#37→#38に積む独立PR。
main `b39c6ea4c472e7a12cbb991781d7f9760c70c821`、#37/#38は変更しない。

## 実装範囲

- `PushTransport` は設計の ACCEPTED / RETRY / PERMANENT 契約＋AbortSignal。
  実装は `FakePushTransport` のみ、runtimeで `mode !== fake` を拒否する。
  入力は公開IDと版・attemptIdだけ。暗号文/平文トークン、本文、URL、Apple資格情報を取得・渡さない。
- `deliveryId` と安定した `idempotencyKey` を設計I/Fへ追記。
  キーは SHA-256(JSON(["push-v1", outboxId小文字, targetKey小文字, targetVersion]))。
  attemptIdはleaseごとに変わり、冪等キーは再試行しても変わらない。
- Fakeはこのキーに対応する決定的な合成UUIDをproviderRequestIdとして返す。
  **PROVIDER_ACCEPTED / apnsRequestId / acceptedAtはFakeの模擬受理記録であり、Apple受付・端末到達ではない。**
  CLIにも毎回Fakeと明記し、APP_ENV=productionでは起動拒否する。
- 配信workerは別CLI `pnpm push:deliveries`。API/serverや既存Gmail経路の起動処理には組み込まない。
  `MOBILE_PUSH_DELIVERY_MODE=off` が既定。offはfactory未呼出し、worker/DB/transport未構築。
- shadowでは、親outbox DISPATCHEDかつ期日到来PENDING/RETRY_WAIT、または期限切れIN_FLIGHTを
  FOR UPDATE SKIP LOCKEDでclaim。leaseToken新規、generation+1、attemptCount+1。
  **attemptCountはclaimごとに1増加**（クラッシュ試行を含む）。RETRY確定時に重ねて増やさない。
- send直前にDBでtarget ACTIVE / 同じtokenVersion、Team/契約/本人/recipientの現在の適格性を再確認。
  OWNERとMEMBER、Teamの照合を維持。不適格・陳腐化はCANCELLED、sendなし。
- sendはTX外。結果だけを別TXでdeliveryのleaseToken/generation/期限によりフェンス確定する。
  DB retry closureには送信を含めない。遅延結果・古いgeneration・期限切れは更新0件。
- ACCEPTED → PROVIDER_ACCEPTED、模擬requestId＋DB時刻保存。
  RETRY → RETRY_WAIT、nextAttemptAtはDB時刻＋max(指数backoff, provider retryAfterMs)。
  PERMANENT → PERMANENT_FAILURE。成功/失敗ともlease解除。
- 410ではdeliveryをロック、targetをロック、**ロック待機後のDB時計で再フェンス**。
  delivery確定と同じTX内で、targetKey＋送信時versionが今もACTIVEの場合だけREVOKEDにし、
  ciphertext/hashをNULL、tokenVersion+1（PR06の解除と同じ方式）。新しいversionには一切書かない。
- transport timeout、abort、late resolutionを区別。停止時はleaseを残して回収可能にし、虚偽の受理を保存しない。
  timeoutは安全なコードで再試行。生のDB/providerエラー・cause・パラメータを外へ出さない。

## 設計の具体化 / 制限

1. **既存schema/全migrationは変更なし**。07aの列だけを使用した。
2. 03aと同じ既定: lease45秒、send timeout10秒、最大10試行。
   指数backoffは1秒から最大5分。providerの長い待機を短縮しない。
   retryAfterMsは0〜7日以内の安全な整数だけ許可（それ以外はTRANSPORT_RESULT_INVALIDとして永久失敗）。
   上限到達はRETRY_EXHAUSTED。自動カウンターリセットなし。
3. HTTPは実行しない。Fake注入テストのコード `HTTP_429` / `HTTP_5XX` / `HTTP_410` を正規化済み分類として扱う。
   `FAKE_TRANSIENT` / `FAKE_PERMANENT` も許可。任意のprovider文字列はDBへ保存しない。
   実HTTP/APNs reasonの変換・資格情報検証は07cで行う。
4. 07a dispatcher CLIのshadowは、組込みFakeの設定を `validated` として注入できるよう変更。
   **新規インテント**はPENDING＋親DISPATCHEDとなる。offの03a経路は変更なし。
   plannerの既定missing経路も残し、既存WAITING_CONFIGURATION/BLOCKEDを勝手に解除・再送しない。
   過去の待機行の安全な再計画/復帰は別途必要で、このPRでは未実装。
5. send前のversion照合の**後**でrotation/revocationが起きる場合、TX外の外部副作用を取り消す保証はない。
   結果保存と410による無効化をフェンスし、新しい登録を守る。send中ずっとDBロックする設計にはしない。
6. **fencing / unique制約だけで外部exactly-onceを保証しない。**
   送信後クラッシュでは再送され得る。今回のFake受信側は安定キーをPKに耐久重複排除する合成試験。
   実APNs側の再送・OS表示重複は07c/iOS以降の検証であり、成功扱いにしない。
7. 07bのFake受理データは隔離テスト専用。後日の実APNs検証データとして流用しない。
   端末情報の復号、.p8、Key/Team/Bundle ID、HTTP/2、実Push、iOS、Critical/Time Sensitiveは未実装。

## 隔離とmigration

- 新規PostgreSQL17コンテナ `call-now-push-pr07b-pg17-20260925`、loopback25447、専用tmpfs。
  既存の通常/E2E/他PR/本番DB、既存ボリューム・プロセスは変更/停止しない。
- 専用管理DBへ既存29件を正規migrate deploy。**29/29、pending/失敗0、driftなし**。
- 新migrationなしのため**07b固有up/down/upは対象外**。
  回帰では既存PR01/02b/03b/06/07aのup/down系試験を新隔離環境で再実行して成功。
  db push / migrate reset / migration履歴の手書き改変はなし。
- 新規suiteは毎回一意の `callnow_pr07b_test_*` DBを作成し、全既存migration＋合成データのみを使用。
  Fake受信記録tableもfixture内だけ。製品schema/migrationには追加しない。
- 試験後に削除したのはsuite自身が作った使い捨てDBのみ。既存DBやユーザーデータの削除はなし。

## 実測テスト

| コマンド | 実測結果 |
|---|---|
| `pnpm test:postgres:apns-worker` | **21/21 PASS**、9.55秒 |
| `pnpm test:postgres` | **30/30 PASS** |
| `pnpm test:postgres:ledger` | **17/17 PASS** |
| `pnpm test:postgres:outbox` | **19/19 PASS** |
| `pnpm test:postgres:dispatcher` | **14/14 PASS** |
| `pnpm test:postgres:jobs` | **22/22 PASS** |
| `pnpm test:postgres:device` | **16/16 PASS** |
| `pnpm test:postgres:delivery` | **19/19 PASS** |
| `pnpm verify` | **PASS**: Frontend128、API302（新規unit12含む）、format/lint/typecheck/build |
| `pnpm db:validate` / `db:generate` | **PASS / PASS** |
| `pnpm db:check-drift` | **差分なし** |
| `git diff --check` | **PASS** |

PG合計**158件PASS**（新規21＋既存137）。verify内のPG158件skipは上記で別途実行済み。
CIに新suiteを追加。最新commit IDとCI結果はPR本文へ記録する。

新規実PostgreSQL試験:

1. OWNER2端末＋MEMBER1端末→模擬受理3件、requestId/time保存、旧tableのdata/schema不変。
2. 100 worker同時: **send1 / PROVIDER_ACCEPTED1 / IDLE99**、取りこぼし・二重受理なし。
3. 同じTeam内でも他principalのtargetはCANCELLED、sendなし。
4. HTTP_429 / HTTP_5XX / FAKE_TRANSIENT→provider待機と指数増加、期日前claimなし、再試行後成功（3件）。
5. 永久失敗は再claimなし、最大試行回数で終了。
6. 410→該当versionだけ解除、delivery確定と同時commit。
7. send中rotation→遅延410は新ACTIVE versionを変更しない。
8. send前rotation/revoke/member無効/Team無効→送信せずCANCELLED（4件）。
9. lease自然失効→generation前進、古い受理/410/同一claimの二度目finishは拒否。
10. 410のtargetロック待機中にlease失効→target/deliveryとも書き込まない。
11. 410のTX確定失敗→delivery＋target解除の両方rollback。
12. send中に独立接続のFOR UPDATE NOWAIT成功（TX外の証拠）。finishの40001 retryでもsend1回。
13. timeout後のlate ACCEPTEDで受理状態へ戻らない。
14. Fake send直後abort→IN_FLIGHTの回収可能lease、acceptedAtなし。
15. **実子プロセスSIGKILL**: Fake受信記録commit直後・delivery finish前に親がDBを確認して終了。
    lease回収後 **sendCalls2 / Fake受信記録1 / PROVIDER_ACCEPTED行1 / generation2**。
16. off factory未呼出し、PENDING等不変、03a Fake send2/Outbox2の状態不変、WAITING_CONFIGURATION非claim。

新規unit12件: off未構築、CLI off/production guard、Fakeの再起動冪等、実transport拒否、
429/5xx/transientのbackoff、異常結果の秘匿、provider例外/上限、timeout遅延結果、abort/options、DB例外cause非露出。

初回に合成Fake受信table名が旧snapshot helperの識別子allowlistに合わないことを検出し、
新fixtureだけの名前を修正。追加テスト編集後のformat違反も整形し再実行。上記は修正後の実測結果。

## 変更ファイル

- `apps/api/src/modules/device-push/push-transport.ts`
- `apps/api/src/modules/device-push/prisma-push-delivery-queue.ts`
- `apps/api/src/modules/device-push/push-delivery-worker.ts`
- `apps/api/src/cli/push-deliveries.ts`
- `apps/api/src/cli/outbox-dispatch.ts`（shadowのFake設定注入のみ）
- `apps/api/src/modules/device-push/mobile-delivery-planner.ts`（境界コメントのみ）
- `apps/api/tests/push-delivery-worker.test.ts`
- `apps/api/tests/push-delivery-worker.postgres.integration.test.ts`
- `apps/api/tests/fixtures/push-worker-harness.ts` / `push-worker-crash-child.ts`
- ルート/API `package.json`、`.github/workflows/ci.yml`、本報告書

## 停止位置

07b Fakeワーカーのみ。実Apple/Google/Microsoft/APNsへの接続、実通知・実メール、
既存DBへの適用、main merge、本番/クラウド変更、デプロイ、07c/PR08は**未実行**。
実APNs受付・端末到達・資格情報・iOS重複表示は**未確認/対象外**として残す。
