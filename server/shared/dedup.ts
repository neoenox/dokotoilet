import crypto from "node:crypto";

/**
 * 重複投稿ガード（24h duplicate review guard）で使う「コメント正規化」と
 * その正規形から導出する dedup キー / commentHash の一意実装。
 *
 * JSON バックエンド（CommunityStore.hasDuplicate）と Firestore バックエンド
 * （FirestoreCommunityStore.addReview の review_dedup/{dedupKey}）は、
 * 同一の重複判定をしなければならない。以前は JSON が正規化比較
 * （trim + 空白圧縮 + 小文字化）、Firestore が生コメントのハッシュ比較と
 * 二重実装になり、大文字小文字・空白の揺れが Firestore だけすり抜けていた。
 * 本モジュールへ一本化することで、バックエンド間の乖離は型とテストで防ぐ
 * （「1実装を共有（二重実装の再分裂防止）」方針。facilityIds.ts と同じ発想）。
 *
 * 正規化はトリミング → 連続空白（全角含む）を1つの半角スペースへ圧縮 →
 * 小文字化。textPolicy サニタイズ後のコメントは改行を含まないため、
 * \s の複数文字連続は意図的な装飾空白（強調など）のみで、正規化して
 * 同一視してよい（JSON バックエンドが長年使ってきた規約）。
 */

/** 重複判定用のコメント正規形。JSON / Firestore 両バックエンドで共有する。
 * 比較前に NFC で正準化する（合成済み/分解済みの表記揺れでガードを
 * すり抜ける手口を塞ぐ）。保存テキスト自体は textPolicy 通り NFC しない
 *（表示忠実性のため）。ここは比較専用の正規形である。 */
export function normalizeDedupText(v: string): string {
  return v
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * review_dedup ドキュメントの決定論的 ID。
 * dedupKey = sha256(facilityId + "|" + ipHash + "|" + normalizedComment)
 * 詳細は docs/durable-community-backend.md の review_dedup セクション。
 */
export function reviewDedupId(
  facilityId: string,
  ipHash: string,
  comment: string
): string {
  return crypto
    .createHash("sha256")
    .update(`${facilityId}|${ipHash}|${normalizeDedupText(comment)}`)
    .digest("hex");
}

/**
 * dedup ドキュメントに保存する commentHash（正規形ベース）。
 * 生コメントのハッシュを保存しないことで、コメント文そのものの
 * 追加情報漏えいを避けつつ、正規化規約の変更をドキュメント側でも検証できる。
 */
export function dedupCommentHash(comment: string): string {
  return crypto
    .createHash("sha256")
    .update(normalizeDedupText(comment))
    .digest("hex");
}

/**
 * 通報理由の重複判定用正規化。コメントと同一規約にそろえる
 *（以前は firestoreCommunityStore.ts 内の normalizeReportText として重複していた）。
 */
export function normalizeReportReason(v: string): string {
  return normalizeDedupText(v);
}
