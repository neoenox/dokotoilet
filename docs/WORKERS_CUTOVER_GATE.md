# Workers/D1 本番切替ゲート（#114・#8・#47）

このチェックリストは操作手順と受入条件です。**本番DBへの実行・秘密情報設定・切替はこのPRでは実施しません**。

## ソースとCIの受入
- [ ] #124 と #125 の実装を同じ統合headへ取り込み、`bun run lint`・`bun test`・`bun run test:worker` を実行
- [ ] `worker/app.workerd.test.mjs` で実D1の初回レビュー、未知の手動施設ID 404、既存レビュー取得を確認
- [ ] API 429/503/413、JSONパース400、管理者APIの権限確認、負荷制限のキー分離を検証
- [ ] 非D1バックエンド時代のレビューID・施設IDと現在のD1行の整合性を確認

## Cloudflare側の運用準備（ユーザー判断・Production権限必須）
- [ ] D1 `kirei-toilet-community` の実database_idを確定し、`wrangler.toml` のコメント中の例を実bindingへ置換
- [ ] `worker/schema.sql` の適用先が対象のD1であることを確認。既存データがあれば先にスナップショットを取得
- [ ] KV `OSM_CACHE` を利用する場合は実IDを設定（未設定の場合の挙動も検証）
- [ ] `COMMUNITY_SALT` を安全に設定し、前環境とのIPハッシュ継続可否を確認。値をGitHubへ掲載しない
- [ ] `ADMIN_TOKEN` を設定する場合は権限と保管場所を確認。値をGitHubへ掲載しない
- [ ] `API_RATE_LIMITER`、`WRITE_RATE_LIMITER`、`VOTE_RATE_LIMITER` のnamespace_idがアカウント内で衝突しないことを確認
- [ ] 制限値（API 120/分、write 30/分、vote 60/分）が実トラフィックに合うか評価。共有IP利用者を誤遮断しないか検証

## Stagingからの昇格判定
- [ ] Worker + D1のStaging smoke（ヘルス、OSM、口コミ投稿・表示・重複・429・復旧）を記録
- [ ] #47の静的14施設について、初回口コミ投稿が201で返り、架空IDは404であること
- [ ] D1整合性、復元方法、切戻し手順、担当者を明記
- [ ] 切替中に新旧DBへ同時書込みが発生しない方法を決定
- [ ] Productionリリース実施についてユーザーが明示的に承認

## 判定
- **PASS:** 同一headのCIとStaging実測が成功し、上記項目を証跡つきで満たす
- **BLOCKER:** D1 binding、Secrets、復元手順、レート制限が未準備
- **RESIDUAL RISK:** 共有IPでのLimiter誤判定、外部OSM API、既存口コミ移行
- **KEEP_DRAFT:** 未検証またはProduction承認待ち。Ready化・マージ・Deployはしない
