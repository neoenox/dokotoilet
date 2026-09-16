import type { FilterState, ToiletFacility, ToiletSortOption } from "../types";
import { displayGrade } from "./grade";
import { calculateDistanceMeters } from "./geo";

/**
 * 一覧・地図共通の「絞り込み → ソート」純関数。
 * FilterState の全フィールドがここで参照される（未使用フィールドの混入防止）。
 */

/** 実測口コミがあるか（0件のトイレは設備推定値しかないため「未評価」扱い） */
function isEvaluated(t: ToiletFacility): boolean {
  return t.reviewCount > 0;
}

/** 一覧の整列・推定表示に使うスコア: 評価済みは実測平均、未評価は設備推定値。
 * 未スコア（null）の施設は 0 扱い（NaN を返さない。ソート比較子が NaN を
 * 返すと順序不定になるため。未評価同士は id で安定化される）。 */
export function displayScore(t: ToiletFacility): number {
  return (isEvaluated(t) ? t.cleanlinessScore : t.equipmentScore) ?? 0;
}

/** フィルタ1件分の判定（検索・清潔度・設備・データ元・お気に入り・利用シーンプリセット） */
export function matchesFilter(
  t: ToiletFacility,
  f: FilterState,
  favoriteIdSet?: Set<string>
): boolean {
  // お気に入りフィルタ。集合未受領（undefined）は「空集合」扱いとし、
  // フィルタ有効時は全件除外する（素通りで全件表示しない。#105）。
  const favs = favoriteIdSet ?? new Set<string>();
  if ((f.onlyFavorites || f.quickPreset === 'favorites') && !favs.has(t.id)) {
    return false;
  }

  // 利用シーン別ワンタッププリセット
  if (f.quickPreset === 'baby') {
    // 赤ちゃん連れ: おむつ交換台または授乳室あり
    if (t.attributes.hasBabyTable !== true && t.attributes.hasNursingRoom !== true) {
      return false;
    }
  } else if (f.quickPreset === 'barrier_free') {
    // バリアフリー: 多機能トイレまたはオストメイトあり
    if (t.attributes.hasMultipurpose !== true && t.attributes.hasOstomate !== true) {
      return false;
    }
  } else if (f.quickPreset === 'female_safe') {
    // 女性安心: パウダールームあり、または商業施設・ホテル等の安心施設
    if (
      t.attributes.hasPowderRoom !== true &&
      t.category !== 'department' &&
      t.category !== 'hotel' &&
      t.attributes.hasWashlet !== true
    ) {
      return false;
    }
  } else if (f.quickPreset === 'night_24h') {
    // 24時間利用可能
    if (t.attributes.isOpen24h !== true) {
      return false;
    }
  }

  // Search query（施設名・住所・種別・フロア。大文字小文字は区別しない）
  const q = f.searchQuery.trim().toLowerCase();
  if (q) {
    const haystack = [t.name, t.address, t.facilityType, t.floorInfo]
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.toLowerCase());
    if (!haystack.some((s) => s.includes(q))) return false;
  }

  // High cleanliness (Grade S & A, score >= 4.0): 表示グレード基準。
  // 口コミ0件の施設も調査/推定グレードで判定する（初期状態でフィルタが全件除外に
  // なるのを防ぐ。実測・調査・推定の区別はグレード表示の出所タグで行う）。
  // 未スコア（コミュニティ登録直後）はスコア自体が無いため除外する
  //（null < 4.0 は false になり、未評価施設がS・A級に紛れ込むのを防ぐ）。
  if (f.onlyHighCleanliness) {
    const shown = displayGrade(t);
    if (shown.score === null || shown.score < 4.0) return false;
  }

  // Equipment attributes: 「あり」を明示（true）した施設のみ一致。
  // 未確認（null）は「なし」同様に候補から外す（不明を「あり」と断定しない）。
  // attributes 欠落（旧 localStorage・不正なサーバー応答）でも落とさず、
  // 「設備は未確認」扱いで一覧に残す（ErrorBoundary に落とされる前にここで防御）。
  const attrs = t.attributes ?? ({} as Partial<ToiletFacility["attributes"]>);
  if (f.onlyWashlet && attrs.hasWashlet !== true) return false;
  if (f.onlyMultipurpose && attrs.hasMultipurpose !== true) return false;
  if (f.onlyPowderRoom && attrs.hasPowderRoom !== true) return false;
  if (f.only24h && attrs.isOpen24h !== true) return false;

  // Data source
  if (f.dataSource !== "all" && t.dataSource !== f.dataSource) return false;

  return true;
}

export function filterToilets(
  toilets: ToiletFacility[],
  f: FilterState,
  favoriteIdSet?: Set<string>
): ToiletFacility[] {
  return toilets.filter((t) => matchesFilter(t, f, favoriteIdSet));
}

/**
 * 清潔度順ソート: 評価済み（実測口コミあり）を先頭に実測平均の降順、
 * 続いて未評価を設備推定値の降順で並べる。同点は id で安定化。
 */
export function sortToiletsForDisplay(
  toilets: ToiletFacility[]
): ToiletFacility[] {
  return [...toilets].sort((a, b) => {
    const aEval = isEvaluated(a);
    const bEval = isEvaluated(b);
    if (aEval !== bEval) return aEval ? -1 : 1;
    const scoreDiff = displayScore(b) - displayScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    return a.id.localeCompare(b.id);
  });
}

/**
 * 距離順ソート: 基準座標（現在地またはマップ中心）からの直線距離の昇順で並べる。
 */
export function sortToiletsByDistance(
  toilets: ToiletFacility[],
  referencePoint: { lat: number; lng: number }
): ToiletFacility[] {
  return [...toilets].sort((a, b) => {
    const distA = calculateDistanceMeters(referencePoint.lat, referencePoint.lng, a.lat, a.lng);
    const distB = calculateDistanceMeters(referencePoint.lat, referencePoint.lng, b.lat, b.lng);
    if (distA !== distB) return distA - distB;
    return a.id.localeCompare(b.id);
  });
}

/**
 * ソート条件に応じた並び替え。
 * 'distance' は基準座標なしでは清潔度順へフォールバックする（定義済み動作）。
 */
export function sortToilets(
  toilets: ToiletFacility[],
  sortOption: ToiletSortOption = 'cleanliness',
  referencePoint?: { lat: number; lng: number } | null
): ToiletFacility[] {
  if (sortOption === 'distance' && referencePoint) {
    return sortToiletsByDistance(toilets, referencePoint);
  }
  if (sortOption === 'reviews') {
    return [...toilets].sort((a, b) => {
      const diff = (b.reviewCount ?? 0) - (a.reviewCount ?? 0);
      if (diff !== 0) return diff;
      return displayScore(b) - displayScore(a) || a.id.localeCompare(b.id);
    });
  }
  return sortToiletsForDisplay(toilets);
}

/** フィルタ → ソートを1本化したエントリポイント */
export function filterAndSortToilets(
  toilets: ToiletFacility[],
  f: FilterState,
  sortOption: ToiletSortOption = 'cleanliness',
  referencePoint?: { lat: number; lng: number } | null,
  favoriteIdSet?: Set<string>
): ToiletFacility[] {
  return sortToilets(filterToilets(toilets, f, favoriteIdSet), sortOption, referencePoint);
}
