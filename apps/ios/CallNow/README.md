# CallNow iOS (shell)

通知権限・デバイストークン登録のみの最小限の起動骨組み。設計上の判断や制約は
`docs/ios/step-01-shell-implementation-results.md` を参照してください。

## プロジェクトを開く

このディレクトリに `.xcodeproj` はコミットしていません(手書きのpbxprojは壊れ
やすいため、[XcodeGen](https://github.com/yonaskolb/XcodeGen) の `project.yml`
から都度生成する運用にしています)。

```
brew install xcodegen   # 未インストールの場合のみ
cd apps/ios/CallNow
xcodegen generate
open CallNow.xcodeproj
```

Xcodeの Signing & Capabilities で自分のTeamを選択してからビルドしてください
(Team IDはproject.ymlにハードコードしていません)。

## 開発用サーバー接続先

Debug構成の既定値:

- API: `http://127.0.0.1:8080`
- Origin(`/push-devices`などの書き込み系エンドポイントに必須): `http://127.0.0.1:5500`
  (`apps/api/.env.example` の `PUBLIC_ORIGIN` と同じ)

シミュレータでの動作確認を想定した値です。実機で試す場合は `project.yml` の
`CALLNOW_API_BASE_URL` / `CALLNOW_PUBLIC_ORIGIN` をMacのLAN IPやトンネルURLに
置き換えてください。Release構成の値は本番ドメイン未確定のため意図的に到達不能な
プレースホルダにしています。

## 動作確認状況

XcodeGen/Xcodeが動く環境でのビルド確認・実機/実Push確認は未実施です。詳細は
`docs/ios/step-01-shell-implementation-results.md` の「未実行・未検証」を参照。
