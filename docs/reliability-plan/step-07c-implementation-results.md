# PR07c — APNs HTTP/2 transport（ローカルモック検証まで）

実施日: 2026-09-25。ブランチ: `phase3/apns-http2-transport-20260925`。
基点: Draft #39 / `phase3/apns-worker-20260925` /
`3a408429a9458d7559774c83ca4eba7fbf4587ab`。#39の上に積むDraft PR。
main `b39c6ea4c472e7a12cbb991781d7f9760c70c821` と #35〜#39のブランチは変更しない。
実装commit・最新CIのURL/結果は、この報告書を含むPR本文に記録する。

## 実装範囲

- `MOBILE_PUSH_DELIVERY_MODE=off|shadow|apns`。既定off、offはfactory/DB/transport未構築。
  shadowはFakeのみ、apnsはAPNs transportのみ。組合せ不一致はclaim前に拒否。
  独立CLIだけがtransportを構築し、`APP_ENV=production`は拒否。API/Gmailの起動経路へ接続しない。
- APNs設定はapns時のみ検証。sandbox/productionの接続先はコード内固定、任意URL指定なし。
  Team/Key ID、逆DNS topic、PKCS#8 P-256、鍵ファイル/inlineの排他、expirationを検証する。
  エラーは安全なコードだけ、raw例外/cause/鍵/トークンを出さない。`.p8`をgitignoreへ追加。
- 既存joseでES256署名。署名64byte、kid/iss/iatを検証。JWTをプロセス内でキャッシュし、
  通常50分で更新。20分未満の再生成を避け、60分を超えたJWTを送らない。
  20分以上のExpiredProviderTokenは更新後RETRY。古いJWTへの遅延応答/同時更新もフェンスする。
- HTTP/2セッションを再利用。GOAWAY/error/close/reset時は破棄して再接続。
  AbortSignal/10秒timeoutでstreamをcancel。Node既定TLS検証を変更しない。
- 決定的なapns-id（idempotencyKey由来UUID）とcollapse-id（alertId由来64byte以内）を使用。
  200の応答IDが欠落/不正/不一致なら送信したUUIDを使う。
- payloadは固定文言とalertIdのみ。メール本文・件名・差出人・アドレス・登録キーワードを含めず4096byte未満。
  `sound=callnow-alarm.caf` / `interruption-level=time-sensitive`は将来のiOS側の契約。
  **音源・iOS側機能や実端末のフォールバック挙動は未実装・未検証**。
- `prepare()`の同じ適格性SELECTで当該tokenVersionの暗号文を取得。復号はAPNs transport内部だけ。
  async復号/JWT署名の後・HTTP直前に再照合し、その間のrotationはCANCELLED、送信0。
  shadow/Fakeには暗号文も渡さない。claim/lease/finish/410解除のSQLと既存期待値は変更なし。
- dispatcherはapnsの設定検証OKならvalidated、欠落/不正ならmissingの既存WAITING_CONFIGURATION経路。
  既存WAITING_CONFIGURATION/BLOCKEDは自動解除しない。dispatcher自身は送信しない。
- 全体設定エラーではRETRY_WAITを保存し、以降のclaimを停止してCLIを非0終了。
  finishがDB障害でも停止ラッチを保持し、lease回収を待つ。生のprovider reasonはDBに保存しない。
- 既存依存だけを使用。schema、既存migration、lockfile、API本体、Gmail監視、Web通知音は変更なし。

## 応答分類

| 応答 | 正規化結果 / DB状態 | worker停止 / 登録解除 |
|---|---|---|
| 200 | ACCEPTED → PROVIDER_ACCEPTED | なし |
| 410 Unregistered / ExpiredToken | HTTP_410 → PERMANENT_FAILURE | 送信版だけREVOKED、新版は不変 |
| 400 BadDeviceToken / DeviceTokenNotForTopic | APNS_BAD_DEVICE_TOKEN / APNS_TOKEN_NOT_FOR_TOPIC → PERMANENT_FAILURE | 登録解除なし |
| 429 TooManyRequests | HTTP_429 → RETRY_WAIT | Retry-Afterと指数backoff |
| 500 InternalServerError/ServiceUnavailable、503 ServiceUnavailable | HTTP_5XX → RETRY_WAIT | 15分以上、長いRetry-Afterも維持 |
| Shutdown / IdleTimeout / UnrelatedKeyIdInToken / GOAWAY / reset / 接続失敗 / timeout | APNS_CONNECTION → RETRY_WAIT | 短いbackoff、session再生成 |
| ExpiredProviderToken（JWT年齢20分以上） | APNS_TOKEN_REFRESH → RETRY_WAIT | JWT更新、短いbackoff |
| ExpiredProviderToken（20分未満）、設定起因・未知reason/status・壊れたJSON | APNS_CONFIG → RETRY_WAIT | 5分以上＋claim停止・非0終了 |
| 403 Forbidden / 413 PayloadTooLarge | APNS_FORBIDDEN / APNS_PAYLOAD_TOO_LARGE → RETRY_WAIT | 5分以上＋claim停止・非0終了（下記の解釈） |

## 設計の具体化・制限・要確認

1. **依頼文内の矛盾への仮定（レビュー要確認）**: 応答表のForbidden/413はPERMANENT指定だが、
   直後の不変条件と受入テストは「全体障害をPERMANENT_FAILUREにせず保存」と指定されていた。
   後者を優先し、コードを区別したRETRY_WAIT＋プロセス停止とした。自動的に再送し続けない。
   確認質問は送信済み。この解釈を黙って完全一致扱いにはしない。
2. **DB最終照合の後のrotationは外部I/Oと競合し得る**。送信時ずっとDBロックする設計にはしない。
   最後の照合前のrotationでHTTP0件、照合後にrotationして遅延410が来ても新版がACTIVEのままであることを別々に検証。
   「あらゆる時刻のrotationで旧版送信を絶対禁止」とは保証しない。
3. **モックでの受理はAppleの受付ではない。PROVIDER_ACCEPTEDは端末表示・鳴動の証明でもない。**
   実APNs・実端末・実.p8・Apple TLS接続・実APNsのreason/配信挙動は未検証。
   今回はloopbackのh2cとその場で生成した合成P-256鍵だけを使用。
4. **外部exactly-onceは保証しない**。送信後のクラッシュ/timeoutでは先方受理済みの可能性があり、再送し得る。
   apns-idはリクエスト識別、collapse-idは表示の重複軽減であって、送信/表示の厳密な一度だけ保証ではない。
5. 07bのclaimごとのattemptCount増加・最大10試行は変更しない。
   壊れた設定で何度も再起動すればRETRY_EXHAUSTEDになり得るため、設定障害のまま再起動し続けない。
   過去の待機行の再計画も別途。任意項目の実送信用smoke CLIは今回は作成・実行しない。
6. **既存PR06試験の断続的失敗を記録**: 最初の全PG実行で
   `100 concurrent re-registrations: one target, monotonic version 100` が一度409
   `PUSH_REGISTRATION_CONFLICT`になった（15 PASS / 1 FAIL）。該当時間帯のDBログから
   `push_registration_token_key`一意違反を確認したが、同suiteの意図的な競合試験もあるため
   失敗した並行操作との完全な紐付け・根本原因は未確定。
   再実行は16/16 PASS。変更前#39を別の一時領域へ展開し同じ隔離DB方式で当該試験を5回実行、
   5回とも1 PASS / 他14 skipで再現せず。registry実装・schema・当該試験は基点とbyte単位で不変。
   この一時失敗を解消済みとは扱わず、PR06領域の再現性確認事項として残す。範囲外の修正や期待値緩和はしない。

## 隔離・migration

- 新規PostgreSQL17コンテナ `call-now-apns-pr07c-pg17-20260925`、loopback25448、専用tmpfs。
  既存通常/E2E/本番/他PRのDB、ボリューム、プロセスには接続・変更・停止しない。
- 専用DBへ既存29 migrationを正規deploy。**29/29、pending/失敗0、schema driftなし**。
- **新migrationなし、07c独自up/downは対象外**。既存PR01/02b/03b/06/07aのup/down/upと旧データ不変試験は再実行。
- 新PG suiteは一意の`callnow_pr07c_test_*`を作成し、合成データのみを使う。
  suite終了時の削除対象はその試験自身が作った使い捨てDBのみ。稼働DBのreset/db push/履歴手書き変更なし。
- HTTP/2テストは`http://127.0.0.1`以外をnative connectより前に拒否。
  固定Apple接続先のfactoryも、このガードでDNS/接続前に遮断するテストで検証した。
  一時鍵ファイルはテスト生成品だけ（0600、試験後削除）。既存.envや実鍵は読まない。

## 実測テスト

| コマンド / 対象 | 結果 |
|---|---|
| APNs HTTP/2 unit（verifyに含む） | **61/61 PASS** |
| `pnpm test:postgres:apns` | **15/15 PASS**（Vitest 5.13秒） |
| `pnpm test:postgres` | **30/30 PASS** |
| `pnpm test:postgres:ledger` | **17/17 PASS** |
| `pnpm test:postgres:outbox` | **19/19 PASS** |
| `pnpm test:postgres:dispatcher` | **14/14 PASS** |
| `pnpm test:postgres:jobs` | **22/22 PASS** |
| `pnpm test:postgres:device` | **再実行16/16 PASS**（初回1 FAILの注記を参照） |
| `pnpm test:postgres:delivery` | **19/19 PASS** |
| `pnpm test:postgres:apns-worker` | **21/21 PASS** |
| `pnpm verify` | **PASS**、Frontend128 / API363、format/lint/typecheck/build |
| `pnpm db:validate` / `db:generate` | **PASS / PASS** |
| `pnpm db:check-drift` | **差分なし** |
| `git diff --check` | **PASS** |

PGは各suite最新実行合計**173 PASS**（新規15＋既存158）。verify内のPG173 skipは上記で別実行済み。
新規追加はunit61＋PG15＝**76件**。初期の型/lintエラーは修正し、最終verifyで通過。
CIに`test:postgres:apns`を追加。CIはテスト専用DB、デプロイworkflowは手動起動のみで今回起動しない。

主要な新規試験の実測:

- 公開鍵でJWT署名検証、100同時取得/Expired応答、20/50/60分境界、古い応答で新JWTを壊さない。
- 全指定reason・未知/不正JSON・GOAWAY・reset・timeout・abort。session再利用1本、再接続時は2本。
- global設定失敗3種でRETRY_WAIT、次claimなし、実子プロセスexit=1。
  finish自体のDB障害でも停止ラッチ維持。原文providerメッセージ/秘密は出力しない。
- OWNER/MEMBER各1端末の合成intents→モック受理2件、requestId保存、旧データ不変。
- 100 workerでHTTP1件/PROVIDER_ACCEPTED1件。Fakeにはciphertextなし、平文のDB/log保存なし。
- 410は送信版だけ解除、BadDeviceToken/NotForTopicでは解除なし、500/503は15分以上。
- 復号中rotationでHTTP0、送信後rotationへの遅延410でも新版不変。
- apns planner設定有無でPENDING/WAITING_CONFIGURATIONを分岐。実送信なし。
- 既存のSIGKILL、lease回収、fencing、flag off/Fake回帰も再実行し通過。

## 変更ファイル

- `apps/api/src/modules/device-push/`: 新規`apns-config.ts`、`apns-jwt.ts`、`apns-http2-transport.ts`、
  `apns-runtime.ts`、`push-worker-loop.ts`。
- 同ディレクトリ: `push-transport.ts`、`push-delivery-worker.ts`、`prisma-push-delivery-queue.ts`、
  `mobile-delivery-planner.ts`。
- `apps/api/src/cli/{push-deliveries,outbox-dispatch}.ts`、`apps/api/src/config/env.ts`、
  `apps/api/src/modules/mail/reliability/outbox-dispatcher.ts`。
- 新規`apps/api/tests/apns-http2.test.ts`、`apns-http2.postgres.integration.test.ts`、
  `fixtures/apns-mock.ts`、`fixtures/apns-circuit-child.ts`。既存`fixtures/push-worker-harness.ts`はDB名prefix引数のみ。
- `package.json`、`apps/api/package.json`、`.github/workflows/ci.yml`、`.env.example`、`.gitignore`、本報告書。

## 停止位置

commit/pushおよび#39をbaseとするDraft PR作成・CI結果記録まで。
実Apple接続、実.p8使用、実Push/メール送信、main統合、既存DB適用、クラウド・本番変更、デプロイ、iOS実装、07c-liveは**未実施**。
モック検証完了と実配信準備完了は区別する。Draftのままレビューと上記要確認事項の判断を待つ。
