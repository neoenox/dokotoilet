# きれいトイレ

公衆トイレの「きれい度」を地図で共有するアプリ。
データ元は OpenStreetMap（Overpass API・リアルタイム取得）とユーザー投稿。
Google Maps / Places API は有料のため不採用（地図タイルは OSM / 国土地理院）。

## 開発

```bash
bun install
bun run dev      # http://localhost:3000（tsx + Vite）
bun run lint     # tsc --noEmit
bun run test     # vitest
bun run build    # vite build + server bundle → dist/
bun run smoke    # 本番バンドルのE2Eスモーク（build後に実HTTP検証）
bun start        # 本番起動（dist/server.cjs）
```

管理パネルは `<URL>/#admin`（`ADMIN_TOKEN` が必要）。

本番起動ポートは `process.env.PORT`（未設定時は 3000）。

## シードデータ生成手順（`src/data/`）

1. Overpass API で取得する（例: 渋谷周辺の公衆トイレ）。

   ```ql
   [out:json][timeout:25];
   nwr["amenity"="toilets"](around:3000,35.6590,139.7006);
   out center 100;
   ```

   結果を `/tmp/unique_osm.json` として保存する。
2. `tmp/gen_toilets.js` で `src/data/toilets.ts` を生成する（git 管理外の手元スクリプト）。

   ```bash
   node tmp/gen_toilets.js
   ```

3. フォールバック用の生ノード抜粋は `src/data/realOsmSeed.ts` に手動で追加する
   （Overpass 3ミラー全滅時に半径約4km以内を返す）。

## コミュニティ投稿API（`server/community.ts`）

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/community/toilets` | 共有トイレ一覧＋外部施設（OSM/Google/OD）の共有レビュー（`externalReviews`） |
| POST | `/api/community/toilets` | 新規登録（バリデーション・ID重複409） |
| POST | `/api/community/toilets/:id/reviews` | 口コミ投稿（重複409・スパムURL400）。対象はコミュニティ登録トイレに限らず `osm-*` / `google-*` / `od-*` の全施設ID |
| POST | `/api/community/reviews/:id/helpful` | 役に立った投票（IP毎1回） |
| POST | `/api/community/reviews/:id/report` | 通報（コミュニティ登録・外部施設の両方のレビューが対象） |

- 投稿系は 10回/分・IP、投票系は 30回/分・IP のレート制限。
- スパムURL判定（コメント・通報理由・施設登録の各テキスト欄）は、NFKC正規化と
  書式/制御文字（LRM・ZWSPなどの不可視文字）+ Default_Ignorable_Code_Point
  （バリエーションセレクタ・ハングルフィラーなど、\p{C} ではないが表示上
  完全に不可視の文字）の除去を行った上でURLパターンに一致させる
  （`server/shared/textPolicy.ts`）。全角英字（ｈｔｔｐｓ://）や不可視文字を
  挟んだURLも検出する。本文中の "http" という語やTLD風表記も拒否される
  （意図的な過剰拒否。unicode監査スイート `server/community.unicode.test.ts` が
  挙動を固定し、プロパティベースファズ `server/community.fuzz.test.ts`
  （fast-check）が「任意のUnicode入力でクラッシュしない・URL/長さ/不可視文字の
  保証をすり抜けない」を普遍的に検証している）。
- 不可視文字のみの入力（ZWSP連打等）は口コミ・通報に加えて施設登録欄
  （名称・住所・フロア・説明）でも拒否/既定値フォールバックされる。制御・書式
  文字は保存前に除去され、さらに `CommunityStore` は読み込み時に保存済みテキスト
  を一律サニタイズするため、#67以前に書かれたレガシー行も自己修復される
  （次回書き込みでファイル全体が正規形に置き換わる。冪等なので清浄データは
  変化しない）。
- 保存先は `data/community.json`（`COMMUNITY_STORE_PATH` で変更可）。
  **データはgit管理で運用する**（`.gitignore` で `data/community.json` のみ追跡）。
  再起動・デプロイ後の復元と、投稿内容の差分レビュー・手動キュレーションにgitを使う。
  コミットのタイミングは投稿が溜まったとき or 運用スクリプト（任意）で定期化する。
  なお、Cloud Run 等の ephemeral FS では**再起動時に未コミット分が消える**ため、
  コミット前に消えても良い量か、永続ボリュームの併用を検討すること。
  サーバーと運用スクリプトは同じ `data/community.json.lock` を使うディスクロックで、
  **書き込み**を直列化する。読み取り（GET）はロックを取らず、ファイルの mtime+size で
  検証したキャッシュを返す（すべての書き込みは rename による原子的置換のため、内容が
  変われば mtime か size が必ず変わり、古い読み取り結果は出ない）。ロックが残るのは
  書き込みの途中でプロセスが死んだ場合のみ。プロセスが強制終了してロックが残った場合は、
  **すべての書き込み元を停止してから** `data/community.json.lock` を手動で削除すること。
  ロックは自動で奪回しないため、稼働中の書き込みを壊さない。
  運用スクリプト（`scripts/community-ops/`、リポジトリ直下から実行）:
  - 差分サマリ（作業ツリー vs HEAD、`--old`/`--new`/`--counts-only` オプション）:
    `bun scripts/community-ops/summarize.ts`
  - スナップショット出力（既定 `data/backups/community-<時刻>.json`、git管理外）:
    `bun scripts/community-ops/export.ts`
  - コミット補助（既定はdry-runでメッセージ案の表示のみ。`--commit` で
    `git add data/community.json` + commit を実行。push はしない）:
    `bun scripts/community-ops/commit.ts`
  - 通報対応（`list` で一覧、`resolve <reportId>` は既定dry-runの削除プレビュー。
    `--apply` で該当レビューを削除し、同一レビューへの全通報・投票・重複ガードを
    掃除してスコアを再計算したうえで書き込む。外部施設のレビューが0件になっても
    `externalReviews` のキーは空配列で保持され、再起動後もその施設への投稿が可能）:
    `bun scripts/community-ops/curate.ts resolve <reportId> --apply`
  - 外部施設の再登録（既定dry-run。`--apply` でコミュニティデータや `--from <backup.json>`
    に痕跡のある外部施設IDを CommunityRepository 経由でバックエンドに再登録する。
    curation でレビューごと消えた OSM 施設の投稿可否復元や、JSON→Firestore 引き継ぎに使用）:
    `bun scripts/community-ops/restore.ts [--apply] [--from <backup.json>] [--backend firestore]`
- ユーザー入力テキスト（ユーザー名・コメント・通報理由・施設登録欄）は保存前に
  `server/shared/textPolicy.ts` で宣言的に処理する（欄ごとのポリシーテーブル +
  共通パイプライン）: 制御文字（NUL等）・双方向制御・
  タグ文字・単独サロゲートは除去、改行・タブは半角スペースへ置換。不可視文字のみの
  入力（ZWSP連打等）は拒否され、ユーザー名が空になる場合は「匿名の利用者」を使う。
  結合記号・全角文字・絵文字は保持する（NFC正規化はしない）。
- `COMMUNITY_SALT` は**必ず固定値**を設定すること（未設定だと起動毎にランダムになり、
  「IP毎1回」の投票・重複ガードが再起動のたびにリセットされる）。
  IPはソルト付きSHA-256ハッシュのみ保存し、ハッシュはAPI応答に含めない。
- **本番配置（F）**: JSON バックエンドは**単一レプリカ + 永続ボリューム**が前提
  （複数レプリカは互いに上書き合う。Cloud Run 等の ephemeral FS は再起動で
  未コミット分が消える）。複数レプリカや消失不可の運用にする場合は
  `COMMUNITY_BACKEND=firestore` へ切り替えること（手順は
  `docs/durable-community-backend.md` Phase 2〜4。JSON→Firestore の dry-run /
  emulator parity / write-freeze 切替、rollback は逆 export + parity 後に行う）。
  デプロイ時の必須環境変数: `COMMUNITY_SALT`（固定の長い乱数）、
  本番は `COMMUNITY_BACKEND` を明示指定（未指定だと起動拒否）。
  `ADMIN_TOKEN` を設定すると通報管理 API が有効になる。
- 通報管理UI（C）: ブラウザで `<公開URL>/#admin` を開くと管理パネルが出る
  （`ADMIN_TOKEN` 入力→通報一覧→解決/レビュー削除）。本格精査は
  `scripts/community-ops/curate.ts` を併用する。
- 未同期キュー（D）: オフライン時の口コミ・投票は `kirei-toilet-pending-*-v1` に
  保存され、起動時・`online` 復帰時に自動再送する（成功分だけキューから外す。
  サーバー応答ありの拒否は再送しない）。
- PWA オフライン（E）: OSM/国土地理院タイルは CacheFirst（各200枚・30日）、
  `GET /api/community/toilets` は NetworkFirst（5秒タイムアウト→キャッシュ表示）。
  アプリ shell は precache 済み。
- 口コミはコミュニティ登録トイレに加え、OSM取得・Google手動調査・自治体ODの施設
  （`osm-*` / `google-*` / `od-*`）へも投稿でき、他端末と共有される（M5対応）。
  フロントは起動時に `externalReviews` を取得してシード施設へ重ねる。
- 外部施設IDは検証前に Unicode NFC で正準化する（`canonicalizeExternalFacilityId`）。
  IDは `externalReviews` のキー / Firestore のドキュメントIDとしてそのまま使われるため、
  見た目が同じでも符号化が違う文字列（ハングル Jamo と合成済みハングル、分解済みの
  濁点付き仮名・ラテン文字など）が別施設として登録・保存されるのを防ぐ。合成できる
  分解型の入力は同じ正準IDに合流して受理される（合成できない結合文字を含む入力は
  従来どおり拒否）。トレードオフ: 検証境界でID文字列を
  書き換えるため、応答の `facilityId` は送信された生の文字列ではなく正準形になる。
  長さ上限（80コードポイント）も正準形に対して数える。コミュニティ登録トイレの
  `toilet-user-*` ID は正準化の対象外（既存キーを保護）。
- フロントはAPI不通時に localStorage のみのローカル動作にフォールバックする。

## Google手動調査データの取込（`scripts/manual-import/`）

Places APIは使わず、ChatGPT等による手動リサーチ結果（JSON）を取込む。

1. `docs/manual-research-prompt.md` をChatGPT（Deep Research推奨）に貼って調査する
2. 出力JSONを `scripts/manual-import/inputs/{エリア}.json` に保存する
3. 取込実行（座標欠落分はNominatimで補完、1.2秒間隔）:

   ```bash
   bun scripts/manual-import/run.ts --in scripts/manual-import/inputs/shibuya-01.json
   ```

   `src/data/googleSeed.ts` が生成される。スキップ理由はコンソールに出る
   （座標特定不能・形式不正は取込不可）。
4. 判定不能（score null）は中立値3.0＋要確認メモで取込む。UI上は未評価表示。
5. 設備は `true`（あり） / `false`（なし） / `null`（未確認）の3値で格納する。
   未調査の項目は `null` にし、`false`（確認済みで無い）と区別する。
6. **規約：口コミ本文の転載禁止**。Google Maps 等のユーザー投稿の本文（および
   ほぼ同一の書き換え）は、規約・プライバシー上の理由から取り込まない。取り込むのは
   listing の口コミ「件数」（`externalReviewCount`）と、調査者が自前の文章で書いた
   傾向要約（`scoreBasis`）のみ。`convert.ts` は旧形式の `reviewExcerpts`（口コミ引用）を
   検出すると破棄し `warn:` をコンソールに出力する。調査プロンプト
   `docs/manual-research-prompt.md` も引用収集を要求しない（2026-09 改定）。

## 自治体オープンデータの取込（`scripts/opendata-import/`）

初弾として熊谷市「公衆トイレ一覧」（くまっぷオープンデータ、2023年10月2日掲載、126件）を取込済み。
出典表記は各施設の `facilityNote` と本READMEで行う（CC-BY 相当の帰属表示）。

```bash
bun scripts/opendata-import/run-kumagaya.ts            # inputs のCSVから生成
bun scripts/opendata-import/run-kumagaya.ts --fetch    # 公式URLから再取得して生成
```

注意：公式CSVは緯度/経度列が重複している（前半は空、後半に実値）。
`mapKumagayaRows` は最終出現を採用する。他自治体を追加する際は列定義を確認すること。

## データ方針

- `cleanlinessScore` / `cleanlinessGrade` は実測レビュー平均。
  `reviewCount === 0` の施設もグレード表示するが出所を明示する
  （`src/lib/grade.ts` の `evaluationKind`：実測 / 調査 / 推定の3段階）。
  Google由来は手動判断値を「調査評価」、その他は設備値を「推定」として表示し、
  実測レビューと混同させない。口コミ投稿で実測に更新される。
- スコア→グレード判定は `src/lib/scoring.ts` の `gradeForScore` に一本化すること。
- 設備フラグは `true`（あり） / `false`（なし） / `null`（未確認）の3値。
  OSM タグ欠落時は楽観的に true にせず `null`（未確認）にする
  （例: `hasSoap` は `soap=yes` のみ true、`isFree` は `fee=no` のみ true で
  `fee` タグ欠落を「無料」と断定しない。変換は `src/lib/osm.ts` に一本化）。
- **口コミ本文の転載禁止**：外部サイト（Google Maps 等）のユーザー投稿本文を
  アプリ・リポジトリに転載しない（規約・プライバシー上の理由）。
  `src/data/googleSeed.ts` は口コミ本文を含まない（過去の引用は 2026-09 に除去済み）。
  Google 由来施設のスコアは件数と要約に基づく手動判断値で、`reviewCount === 0` のため
  UI上は「調査評価」として扱う（実測レビューとは区別表示）。
- 設備からの推定は `src/lib/estimate.ts` に一本化（基準3.0＋設備・管理条件の加減点）。
  推定はA止まり（S級は実測のみ）、根拠（`estimateBasis`）をUIで開示する。
  適用先：熊谷OD取込（`scripts/opendata-import/kumagaya.ts`）とOSM変換（`server.ts`）。

## ライセンスとデータ帰属

- コード: MIT License（`LICENSE` 参照）。
- 同梱データ（`src/data/` 配下のシード・生成物）はコードのライセンス対象外で、出典ごとの条件に従う。
  - **OpenStreetMap 由来**（`src/data/realOsmSeed.ts`・`src/data/toilets.ts`、
    OSM リアルタイム取得の変換結果）: © OpenStreetMap contributors, ODbL。
    抽出・再利用は ODbL 条件（派生 DB のシェアアライク等）に従うこと。
    https://www.openstreetmap.org/copyright
  - **熊谷市「公衆トイレ一覧」**（くまっぷオープンデータ、2023年10月2日掲載）: CC-BY 相当。
    出典: https://www2.wagmap.jp/kumagaya/OpenData
  - **Google Maps 由来の手動調査データ**（`src/data/googleSeed.ts`）: 事実情報（座標・設備・
    口コミ件数）と調査者が自前で書いた要約のみで、ユーザー投稿本文は含まない（転載禁止方針）。
    「Google」は Google LLC の商標。
- 地図タイルは © OpenStreetMap contributors（ODbL）および国土地理院。帰属は地図上のコントロールに常時表示。
- コミュニティ投稿（口コミ・施設登録）は投稿者のコンテンツ。削除依頼・モデレーションは
  `scripts/community-ops/` の運用フローで対応する。
