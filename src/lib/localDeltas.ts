import type { ToiletFacility, ToiletReview } from "../types";
import { reviewScoreFields, summarizeReviews } from "./scoring";

/**
 * M6: localStorage へ保存するのは「ユーザーデルタ」だけにする。
 *
 * - シード（googleSeed / kumagayaSeed / 初期OSM）は保存せず、起動時に常に最新の
 *   バンドル版シードへデルタを重ねる → シード更新が既存ユーザーにも届く
 * - サーバーが保持するデータ（community 登録トイレ・externalReviews）はデルタに含めない
 *   （サーバー同期済みレビューがローカルに残って、git運用での削除を巻き戻さないように）
 * - OSMリアルタイム取得分はユーザーデルタではなく別キーの上限付きキャッシュ（OSM_CACHE_KEY）
 */

export const LOCAL_DELTA_KEY = "kirei-toilet-delta-v1";
export const OSM_CACHE_KEY = "kirei-toilet-osm-cache-v1";
export const VOTED_REVIEWS_KEY = "kirei-toilet-voted-reviews";
// D: オフライン時の未同期キュー（再送待ち）。起動時・online復帰時に flush する
// - pendingReviews: fetch 自体が失敗した口コミPOST（サーバー応答ありの拒否は含めない）
// - pendingVotes: 送信失敗した helpful 投票（楽観カウント巻き戻し分を再送する）
export const PENDING_REVIEWS_KEY = "kirei-toilet-pending-reviews-v1";
export const PENDING_VOTES_KEY = "kirei-toilet-pending-votes-v1";
export const PENDING_QUEUE_MAX = 100;
// 旧バージョン（トイレ全体スナップショット）のキー。移行後は削除する
export const LEGACY_TOILETS_V3_KEY = "toilet_cleanliness_map_real_v3";
export const LEGACY_TOILETS_V2_KEY = "toilet_cleanliness_map_real_v2";

export const OSM_CACHE_MAX = 600;

export interface LocalDeltaV1 {
  v: 1;
  /** この端末で追加登録したトイレ（サーバー未同期のオフライン登録を含む） */
  userToilets: ToiletFacility[];
  /** シード/OSM取得施設に付けたローカル口コミ（サーバー同期済みのレビューは含めない） */
  reviewDeltas: Record<string, ToiletReview[]>;
}

export function emptyDelta(): LocalDeltaV1 {
  return { v: 1, userToilets: [], reviewDeltas: {} };
}

export function isUserToiletId(id: string): boolean {
  return id.startsWith("toilet-user-");
}

// 旧ビルドのシードに含まれていた引用・自動生成レビュー（移行時・読込時に除外）
function isSeedSyntheticReview(r: ToiletReview): boolean {
  return (
    r.id.startsWith("rev-gmaps-") ||
    r.id.startsWith("rev-init-") ||
    r.userName === "Google口コミより引用"
  );
}

function cleanReviews(reviews: unknown): ToiletReview[] {
  if (!Array.isArray(reviews)) return [];
  return (reviews as ToiletReview[]).filter(
    (r) => r && typeof r.id === "string" && typeof r.rating === "number" && !isSeedSyntheticReview(r)
  );
}

/**
 * 口コミ一覧を次元別に平均して施設へ反映したものを作る（0件は設備推定値へ戻す）。
 * 総合→overallScore / 清潔さ→cleanlinessScore（グレードも清潔さから）を独立集計。
 * subScores は書き換えない（設備推定ベースライン。表示側で口コミから導出する）。
 */
export function recomputeFromReviews(
  t: ToiletFacility,
  reviews: ToiletReview[]
): ToiletFacility {
  const hadReviews = t.reviewCount > 0 || t.reviews.length > 0;
  if (reviews.length === 0) {
    return {
      ...t,
      reviews: [],
      reviewCount: 0,
      ...reviewScoreFields(null, t),
      lastCleaned: undefined,
    };
  }
  return {
    ...t,
    reviews,
    reviewCount: reviews.length,
    ...reviewScoreFields(summarizeReviews(reviews), t),
    ...(hadReviews ? {} : { lastCleaned: "たった今（利用者が確認）" }),
  };
}

/** base 優先で id 重複なしにレビューを結合（base=サーバー/既存、additions=ローカル未同期分） */
export function mergeReviewLists(
  base: ToiletReview[],
  additions: ToiletReview[]
): ToiletReview[] {
  const byId = new Map<string, ToiletReview>();
  for (const r of [...base, ...additions]) {
    // 先勝ち: base（サーバー・既存）が同一IDの重複で優先される
    if (r && typeof r.id === "string" && !byId.has(r.id)) byId.set(r.id, r);
  }
  return [...byId.values()];
}

/** ローカル未同期レビューを失わずに、サーバーのトイレ情報を正として統合する */
export function unionServerToilet(
  local: ToiletFacility,
  server: ToiletFacility
): ToiletFacility {
  const merged = mergeReviewLists(server.reviews, local.reviews);
  return recomputeFromReviews({ ...server, reviews: server.reviews }, merged);
}

/** id 重複なしに施設リストを結合（base 優先。例: シード + OSMキャッシュ） */
export function mergeFacilityLists(
  base: ToiletFacility[],
  additions: ToiletFacility[]
): ToiletFacility[] {
  const seen = new Set(base.map((t) => t.id));
  const out = [...base];
  for (const t of additions) {
    if (t && typeof t.id === "string" && !seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

/** localStorage の生文字列 → 安全な施設配列（不正データは捨てる）。無ければ空配列 */
export function parseToiletArray(raw: string | null): ToiletFacility[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return (parsed as ToiletFacility[]).filter(
    (t) =>
      t &&
      typeof t === "object" &&
      typeof (t as ToiletFacility).id === "string" &&
      typeof (t as ToiletFacility).lat === "number" &&
      Number.isFinite((t as ToiletFacility).lat) &&
      typeof (t as ToiletFacility).lng === "number" &&
      Number.isFinite((t as ToiletFacility).lng)
  );
}

/** 旧v3/v2（トイレ全体スナップショット）をユーザーデルタへ移行する */
export function migrateLegacyArray(parsed: unknown): LocalDeltaV1 {
  if (!Array.isArray(parsed)) return emptyDelta();
  const userToilets: ToiletFacility[] = [];
  const reviewDeltas: Record<string, ToiletReview[]> = {};
  for (const raw of parsed as ToiletFacility[]) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as ToiletFacility;
    if (typeof t.id !== "string") continue;
    const reviews = cleanReviews(t.reviews);
    if (isUserToiletId(t.id)) {
      // 追加トイレはレビューなしでも保持（オフライン追加の可能性）
      userToilets.push({ ...t, reviews, reviewCount: reviews.length });
    } else if (reviews.length > 0) {
      // シード・OSM取得施設は施設自体を保存せず、口コミ差分だけ残す
      reviewDeltas[t.id] = reviews;
    }
  }
  return { v: 1, userToilets, reviewDeltas };
}

export function parseLocalDelta(raw: string | null): LocalDeltaV1 | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Partial<LocalDeltaV1>;
  if (p.v !== 1) return null;
  if (!Array.isArray(p.userToilets)) return null;
  if (!p.reviewDeltas || typeof p.reviewDeltas !== "object") return null;
  const userToilets = p.userToilets
    .filter(
      (t) =>
        t &&
        typeof t.id === "string" &&
        typeof t.lat === "number" &&
        Number.isFinite(t.lat) &&
        typeof t.lng === "number" &&
        Number.isFinite(t.lng)
    )
    .map((t) => {
      const reviews = cleanReviews(t.reviews);
      return { ...t, reviews, reviewCount: reviews.length };
    });
  const reviewDeltas: Record<string, ToiletReview[]> = {};
  for (const [fid, revs] of Object.entries(p.reviewDeltas)) {
    const cleaned = cleanReviews(revs);
    if (cleaned.length > 0) reviewDeltas[fid] = cleaned;
  }
  return { v: 1, userToilets, reviewDeltas };
}

/**
 * 保存時: state 全体から「サーバーが保持していない差分」だけを抽出する。
 * serverKnowledge は boot のGET・投稿成功時に更新した「サーバーが持っている」情報。
 */
export interface ServerKnowledge {
  facilityIds: ReadonlySet<string>;
  reviewIdsByFacility: ReadonlyMap<string, ReadonlySet<string>>;
}

export function extractDelta(
  state: ToiletFacility[],
  server: ServerKnowledge
): LocalDeltaV1 {
  const userToilets: ToiletFacility[] = [];
  const reviewDeltas: Record<string, ToiletReview[]> = {};
  for (const t of state) {
    if (!t || typeof t.id !== "string") continue;
    if (isUserToiletId(t.id)) {
      const reviews = cleanReviews(t.reviews);
      if (!server.facilityIds.has(t.id)) {
        // サーバー未登録（オフライン追加など）→ 施設ごと保存
        userToilets.push({ ...t, reviews, reviewCount: reviews.length });
      } else {
        // サーバー登録済みでも、未同期のローカル口コミがあれば施設ごと保存して
        // オフライン投稿を失わない。同期済みレビューは含めない（git運用での
        // サーバー側削除がローカルで復活しないように）。完全同期済みなら保存しない。
        const knownSet = server.reviewIdsByFacility.get(t.id) ?? new Set<string>();
        const localOnly = reviews.filter((r) => !knownSet.has(r.id));
        if (localOnly.length > 0) {
          // ローカルのみの口コミでスコアを再計算し、表示と一貫させる
          userToilets.push(recomputeFromReviews(t, localOnly));
        }
      }
      continue;
    }
    const known = server.reviewIdsByFacility.get(t.id);
    const reviews = known && known.size > 0 ? cleanReviews(t.reviews).filter((r) => !known.has(r.id)) : cleanReviews(t.reviews);
    if (reviews.length > 0) reviewDeltas[t.id] = reviews;
  }
  return { v: 1, userToilets, reviewDeltas };
}

/**
 * ErrorBoundary の「端末データを初期化して再読み込み」から呼ぶ最終手段。
 * ユーザー生成データ（ローカルデルタ・OSM キャッシュ・投票済み印）を消す。
 * サーバー同期済みデータはバックエンドに残るため、失うのは
 * 「この端末のみの未同期分」（オフライン投稿・OSM 取得キャッシュ）だけ。
 * localStorage 自体は消さない（他アプリとの共存のため）。
 */
export function clearStoredUserData(): void {
  try {
    localStorage.removeItem(LOCAL_DELTA_KEY);
    localStorage.removeItem(OSM_CACHE_KEY);
    localStorage.removeItem(VOTED_REVIEWS_KEY);
    localStorage.removeItem(PENDING_REVIEWS_KEY);
    localStorage.removeItem(PENDING_VOTES_KEY);
  } catch {
    // localStorage が使えない環境（プライベートモード等）では何もしない
  }
}

/** D: 未同期キュー操作（localStorage 永続・上限付き・不正データ耐性） */

export interface PendingReview {
  facilityId: string;
  review: ToiletReview;
  queuedAt: string;
}

export interface PendingVote {
  toiletId: string;
  reviewId: string;
  queuedAt: string;
}

function readJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const p: unknown = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

function isValidReview(r: unknown): r is ToiletReview {
  return (
    !!r &&
    typeof (r as ToiletReview).id === "string" &&
    typeof (r as ToiletReview).rating === "number"
  );
}

export function loadPendingReviews(): PendingReview[] {
  try {
    return readJsonArray(localStorage.getItem(PENDING_REVIEWS_KEY))
      .filter(
        (p): p is PendingReview =>
          !!p &&
          typeof (p as PendingReview).facilityId === "string" &&
          isValidReview((p as PendingReview).review)
      )
      .slice(-PENDING_QUEUE_MAX);
  } catch {
    return [];
  }
}

export function loadPendingVotes(): PendingVote[] {
  try {
    return readJsonArray(localStorage.getItem(PENDING_VOTES_KEY))
      .filter(
        (p): p is PendingVote =>
          !!p &&
          typeof (p as PendingVote).toiletId === "string" &&
          typeof (p as PendingVote).reviewId === "string"
      )
      .slice(-PENDING_QUEUE_MAX);
  } catch {
    return [];
  }
}

function savePending(key: string, items: unknown[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(items.slice(-PENDING_QUEUE_MAX)));
  } catch {
    /* quota超過等は無視（次回起動時に再試行） */
  }
}

export function enqueuePendingReview(item: PendingReview): PendingReview[] {
  const cur = loadPendingReviews();
  if (cur.some((p) => p.review.id === item.review.id)) return cur;
  const next = [...cur, item];
  savePending(PENDING_REVIEWS_KEY, next);
  return next;
}

export function enqueuePendingVote(item: PendingVote): PendingVote[] {
  const cur = loadPendingVotes();
  if (cur.some((p) => p.reviewId === item.reviewId)) return cur;
  const next = [...cur, item];
  savePending(PENDING_VOTES_KEY, next);
  return next;
}

/**
 * 再送HTTP結果 → キュー処置の唯一の判定（README「未同期キュー（D）」の実装）。
 *
 * - "sync": 2xx。サーバー応答を状態へ反映し、キューから外す
 * - "keep": 429（レート制限）と 5xx。どちらも時間経過で結果が変わる一時的な拒否。
 *   レート制限は制限ウィンドウ（1分）経過後に同じリクエストが成功しうるため、
 *   破棄せず持ち越して再試行する
 * - "discard": サーバー応答ありの確定拒否（400/404/409 などの4xx）。重複投稿・
 *   未発見（モデレーション済みレビューへの投票）・バリデーションなど、
 *   再送しても結果が変わらないため破棄する（README: 「サーバー応答ありの拒否は
 *   再送しない」）
 *
 * ネットワーク断（fetch 自体の失敗）は Response を介さないためこの関数には届かず、
 * 呼び出し側の catch で keep（持ち越し）になる。
 * status が不明で ok=false の場合は安全側に keep（破棄は確定応答のみに限定）。
 */
export type PendingQueueAction = "sync" | "discard" | "keep";

export function pendingQueueAction(res: { ok: boolean; status?: number }): PendingQueueAction {
  if (res.ok) return "sync";
  const status = res.status;
  if (typeof status !== "number") return "keep";
  if (status === 429) return "keep";
  if (status >= 500) return "keep";
  return "discard";
}

export function removePendingReview(reviewId: string): void {
  savePending(
    PENDING_REVIEWS_KEY,
    loadPendingReviews().filter((p) => p.review.id !== reviewId)
  );
}

export function removePendingVote(reviewId: string): void {
  savePending(
    PENDING_VOTES_KEY,
    loadPendingVotes().filter((p) => p.reviewId !== reviewId)
  );
}

/** 起動時: 最新シードへユーザーデルタを重ねる（存在しない施設の差分は捨てる） */
export function applyDeltaToSeeds(
  seeds: ToiletFacility[],
  delta: LocalDeltaV1
): ToiletFacility[] {
  const byId = new Map(seeds.map((t) => [t.id, t]));
  const out = [...seeds];
  for (const ut of delta.userToilets) {
    if (!ut || typeof ut.id !== "string") continue;
    const existing = byId.get(ut.id);
    if (existing) {
      const idx = out.findIndex((t) => t.id === ut.id);
      if (idx >= 0) {
        const reviews = cleanReviews(ut.reviews);
        out[idx] = recomputeFromReviews(existing, mergeReviewLists(existing.reviews, reviews));
      }
    } else {
      byId.set(ut.id, ut);
      out.push(ut);
    }
  }
  for (const [fid, revs] of Object.entries(delta.reviewDeltas)) {
    const t = byId.get(fid);
    if (!t || revs.length === 0) continue;
    const idx = out.findIndex((x) => x.id === fid);
    if (idx >= 0) {
      const cleaned = cleanReviews(revs);
      out[idx] = recomputeFromReviews(out[idx], mergeReviewLists(out[idx].reviews, cleaned));
    }
  }
  return out;
}
