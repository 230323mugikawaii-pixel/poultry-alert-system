# PR07c-smoke — sandbox限定・1件限りの疎通CLI（作成/モック検証のみ）

実施日: 2026-09-25。ブランチ: `phase3/apns-smoke-cli-20260925`。
基点: Draft #40 / `phase3/apns-http2-transport-20260925` /
`b63ea514a066a7c2ecc4c6667cfa63624e1944b9`。
main `b39c6ea4c472e7a12cbb991781d7f9760c70c821`、#35〜#40のブランチは変更しない。
実装commitと最新CIの結果/リンクは、この報告書を含むDraft PR本文へ記録する。

## 実装範囲

- 独立コマンド`pnpm push:apns-smoke`を定義。ただし**今回は実コマンド/entrypointを一度も実行していない**。
  CLIから呼ぶ同じ`runApnsSmoke`関数をテストし、wrapperは静的検証・typecheck/buildだけを行った。
- `--confirm-real-push`なしは設定・入力・transportへ触れる前に終了コード1。
  `APP_ENV=production`も拒否。引数は確認フラグ1個と、`--token-file <path>`または`--token-stdin`の片方だけ。
  二重指定、未知フラグ、端末トークンの直接指定、位置引数、接続先指定は拒否する。入力値はエラーへ含めない。
- 元のAPNs設定を既存`readApnsConfiguration`で検証してから、**sandboxへ固定**する。
  `APNS_ENVIRONMENT=production`でもsandbox。未設定/不正値は上書きで隠さず設定エラー。
  CLI/envから接続先を注入する機能は追加しない。`apns-config.ts`、`apns-runtime.ts`、transport本体は変更なし。
- トークン入力は4KiBで上限管理、前後の空白/改行を除去し、偶数桁hex（最大1024文字）を検証、小文字化。
  標準入力はEOFまで読む。SIGINT/SIGTERMは読取中/送信中のAbortSignalへ伝播する。
- 入力トークンは**その実行だけの一時AES-256-GCM鍵**と既存暗号化クラスでメモリ内のenvelopeへ変換する。
  同じ一時鍵を`createConfiguredApnsTransport`へ渡し、既存transport内部の復号・署名・HTTP/2・応答分類を再利用。
  DB用暗号鍵やKMSを必要とせず、既存環境変数を書き換えない。鍵/トークンをファイルやDBへ保存しない。
- 毎回ランダムな合成alertId UUIDと合成識別子を生成。実DBのAlert/登録レジストリとは無関係。
  既存transportの`send()`を最大1回だけ呼ぶ。worker/queue/dispatcherや再試行ループは起動しない。
  終了時はtransportをcloseする。ACCEPTEDは終了コード0、それ以外は1。
- stdoutは1行JSONの正規化結果のみ。鍵、JWT、平文/暗号文トークン、入力パス、生response/header、raw例外/causeを出さない。
  `.env`を自動ロードしない。新しい送信実装・依存・feature flagは追加しない。

## 出力と分類

| 結果 | stdoutフィールド | 終了コード |
|---|---|---|
| ACCEPTED | `result=ACCEPTED`, `apnsId`（UUID） | 0 |
| RETRY | `result=RETRY`, 正規化`code` | 1（このCLI内で再試行しない） |
| PERMANENT | `result=PERMANENT`, 正規化`code` | 1 |
| 確認不足/引数/設定/入力/キャンセル失敗 | `result=PERMANENT`, 安全な固定コード | 1 |

認証失敗等のAPNs分類は#40のまま。今回Forbidden/413の解釈変更はしない。
ACCEPTEDにcodeがない場合は追加せず、UUIDだけを返す。未定義コードは安全なRESULT_INVALIDに置き換える。
ここでのPERMANENTは**当該CLI呼出しの終了結果**であって、DBレコードを永久失敗へ変更したという意味ではない。

## テストと実測

| 対象 | 今回の結果 |
|---|---|
| 新規`apns-smoke.test.ts` | **35/35 PASS**（verify内121ms） |
| `pnpm verify` | **PASS**、22.87秒 |
| Frontend | **128 PASS** |
| API | **398 PASS**（既存363＋新規35）、PostgreSQL専用173 skip |
| format / lint / typecheck / build | **すべてPASS** |
| `git diff --check` | **PASS** |
| schema/migration・既存CLI・07a〜07c送信/queue実装 | 基点との差分0 |
| 実smokeコマンド起動、Apple疎通 | **未実行** |

新規35件の内訳: 確認フラグ1、production拒否1、引数組合せ12、元環境値検証3、
sandbox固定とfile入力2、stdin/UUID1、不正入力6、I/O漏えい防止1、読取abort1、
応答分類/出力最小化4、鍵エラー1、送信abort1、package/wrapper静的検証1。

- #40のローカルHTTP/2フィクスチャを再利用。合成P-256鍵とランダムな合成端末トークンだけを使用。
- **既存の実factoryとtransportをそのまま使い**、選択されたsandboxアドレスを
  テストの`node:http2.connect`境界でloopback h2cへ差し替える。AppleのDNS/接続より前に遮断。
  sandbox以外の外向き接続は禁止。env=productionでもsandbox選択1回、モックHTTP1件を確認。
- DB factoryはテストでfail-closedにし、呼出0を確認。KMS設定が環境にあっても一時ローカル暗号化のみ。
- missing確認フラグではenvアクセスも禁止するProxy、入力を読むと失敗するstreamで早期停止を確認。
- stdoutのフィールドを厳密照合し、入力トークン・鍵・パス・生provider情報が含まれないことを確認。
- テストの初回にケース引数指定/型/lintの不備があったが修正し、最終verifyで通過。期待条件の緩和なし。

## DB/CI・既知事項

- **新migrationなし**。ローカル検証はDATABASE_URL等を渡さず実行。既存DB/コンテナ/ボリュームへ接続・適用しない。
  verifyに元からあるインメモリPGlite試験は実行。実PostgreSQL専用173件はローカルでは未実行/skipとして区別する。
- 新規テストは既存CIの`vitest run`で自動発見される。workflowは変更なし。
  CIの使い捨てPostgreSQL17で既存全スイート・migration/driftを再実行し、最新commitの結果をPR本文へ記録する。
- #40で記録したPR06の断続的409競合やForbidden/413の仕様解釈はこのPRの修正対象にしない。
  親の既知事項が本PRによって解消したとは扱わない。
- **モックのACCEPTEDはApple受理でも実端末表示でもない**。実APNs・実.p8・実トークン、iOS音源/通知は未検証。
- 合成alertIdはアプリ側の実Alertではない。将来のsmokeは通信境界の確認であり、通知の表示/詳細取得E2Eではない。
  再度CLIを呼ぶと別の合成通知になる。受理不明のtimeout/中断後に手動再実行すると重複送信し得る。
- 実疎通には07c-liveの別承認が必要。このPRのレビュー/CI成功を実送信の許可として扱わない。

## 変更ファイル

1. `apps/api/src/cli/apns-smoke.ts` — 独立entrypoint、signal/exit codeのみ。
2. `apps/api/src/modules/device-push/apns-smoke.ts` — 入力検証、sandbox固定、既存transportへの1回委譲、出力制限。
3. `apps/api/tests/apns-smoke.test.ts` — ローカルモック/安全柵35件。
4. `apps/api/package.json` — API workspaceのコマンド定義。
5. `package.json` — rootのコマンド定義。
6. 本報告書。

## 停止位置

commit/push、#40をbaseとするDraft PR作成、最新CI結果の記録までで停止。
実際の`pnpm push:apns-smoke`/entrypoint実行、実Apple接続、実.p8、実Push、main統合、既存DB適用、
本番/クラウド変更、デプロイ、iOS実装、07c-liveは**未実施**。
