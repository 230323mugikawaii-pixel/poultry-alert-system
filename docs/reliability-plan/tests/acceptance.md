# 段階別の受入条件

各PRは小さなテスト専用Teamで確認し、結果を報告して止める。実メールの送信や権限変更は別承認。

| PR | 変更 | 次へ進む条件／最小テスト |
|---|---|---|
| 01 | 台帳の追記だけ | 同一メール100回→台帳1件・旧Alert1件。取得前/Alert直後の停止で未解決が残る。404は不一致にならない。offで既存挙動。本文非保存。 |
| 02a | 既存ingestのtransaction body抽出 | 既存テスト全成功、外部I/Oなし、宛先・監査記録・SSE通知順序が変わらない。 |
| 02b | 同一TXに判定＋Alert＋宛先＋Outbox | commit直前停止→全ロールバック。commit直後停止→Outboxが残る。同時実行100回→各論理レコード1件。 |
| 03 | PostgreSQLジョブ/受付ACK | 耐久化前のDB障害は2xxを返さない。commit後ACK前停止は再配信で復元。期限切れclaimを回収し、旧workerの更新を拒否。 |
| 04 | desired/observedと監視区間 | invalid_grantでdesiredは変化しない。再認証で監視区間を切り捨てない。pause中受信は通知しない。再開境界[開始,終了)の前後1ms。 |
| 05 | 同期ページ・カーソル分離 | 2ページ目直前/直後停止。全IDタスク保存前にcursor更新しない。壊れた1件が他メッセージを止めず、evaluatedSeqだけ保留。 |
| 06 | 定期差分取得 | プッシュを完全停止しても60秒目標内に発見。多重実行でも欠落/重複Alertなし。429はRetry-After、5xxはjitter。 |
| 07 | 独立突き合わせ・失効復旧 | 意図的に飛ばしたIDを通常一覧から回収。500件超/72h超を継続タスクで処理。Gmail History404/Graph410で区間を破棄しない。 |
| 08 | OAuth lease/更新 | 同時20refreshで通常1HTTP。lease喪失後の遅延成功/失敗が新credentialを上書きしない。401再試行は最大1回。invalid_grantでjob保持＋incident。 |
| 09 | watch/subscription管理 | 初回失敗でincident。古いcursor保持。期限切れで差分回収へ。同じmailboxを別Teamが使うときstopで他Teamを止めない。 |
| 10 | 運用者アラート・健康表示 | 監査停止でTTL後UNKNOWN。空の同期成功で既存gapを消さない。DB停止を外部heartbeatが検出。本文/トークン非出力。 |
| 11 | 合成監視 | 送信前にrunを保存。送信曖昧成功はSEND_UNKNOWN。push停止時poll回収でもpush障害を検知。未実行slotも検出。APNs未実装を成功扱いしない。 |
| 12 | SHADOW→LIVE小規模切替 | 旧/新双方を原本と照合。切替直前旧worker停止・切替直後復帰でもgenerationで二重書込なし。rollbackでcursorを最新値に飛ばさない。 |

## 全段階の不変条件

1. 同一(Team,provider,安定mailbox,provider message ID)から論理Alertは1件。
2. SHADOWはAlert/宛先/Outbox/既存通知を変更しない。
3. 取得済みcursorが示す全候補は耐久タスクにある。
4. UNDETERMINEDや未列挙ページを正常完了としない。
5. LIVE/MATCHEDにはAlert+宛先+Outboxが同一TXで存在。
6. 再送は停止履歴/既読/確認済みを初期化しない。
7. API/SMTP/APNsなどの外部呼出しをDB再試行transactionへ含めない。
8. credentialsのversion・leaseは全writerで守る。Promise.raceだけを取消保証にしない。
9. DBは本文・添付・OAuth生token・エラー本文を保存しない。
10. 既存Team/課金/監視権限チェックをworker化で迂回しない。

## 明示して扱う境界

現在INBOXにあるかと、受信時にINBOXだったかは同義ではない。
既存仕様を維持するPRと、移動後の対象範囲を変更するPRを混ぜない。
取得前に原本が完全削除された場合は、証拠の有無に応じUNDETERMINEDまたはcoverage unknown。
APNsの受付は端末表示/実音/人間の確認を意味しない。
