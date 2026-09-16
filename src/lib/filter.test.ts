import { describe, expect, it } from "vitest";
import {
  displayScore,
  filterAndSortToilets,
  matchesFilter,
  sortToiletsForDisplay,
} from "./filter";
import type { FilterState, ToiletFacility } from "../types";

const baseFilter = (over: Partial<FilterState> = {}): FilterState => ({
  dataSource: "all",
  onlyHighCleanliness: false,
  onlyWashlet: false,
  onlyMultipurpose: false,
  onlyPowderRoom: false,
  only24h: false,
  searchQuery: "",
  ...over,
});

function mk(id: string, over: Partial<ToiletFacility> = {}): ToiletFacility {
  return {
    id,
    name: "テストトイレ",
    facilityType: "公衆トイレ",
    category: "park",
    dataSource: "osm",
    lat: 35.66,
    lng: 139.7,
    address: "東京都渋谷区",
    cleanlinessGrade: "B",
    cleanlinessScore: 3.0,
    equipmentGrade: "B",
    equipmentScore: 3.0,
    subScores: { cleanliness: 3.0, odor: 3.0, supplies: 3.0, comfort: 3.0 },
    attributes: {
      hasWashlet: false,
      hasMultipurpose: false,
      hasBabyTable: false,
      hasNursingRoom: false,
      hasPowderRoom: false,
      hasOstomate: false,
      isFree: true,
      isOpen24h: false,
      hasSoap: false,
      hasAlcohol: false,
      hasPaperTowelOrDryer: false,
      toiletStyle: "western",
    },
    openingHours: "常時開放",
    description: "",
    reviewCount: 0,
    reviews: [],
    ...over,
  };
}

const evaluated = (id: string, score: number, extra: Partial<ToiletFacility> = {}) =>
  mk(id, {
    reviewCount: 3,
    cleanlinessScore: score,
    cleanlinessGrade: score >= 4.6 ? "S" : "A",
    ...extra,
  });

describe("matchesFilter", () => {
  it("keeps everything with an empty (all) filter", () => {
    const t = mk("a");
    expect(matchesFilter(t, baseFilter())).toBe(true);
  });

  it("filters by name / facilityType / floorInfo, case-insensitive", () => {
    const t = mk("a", { name: "渋谷ヒカリエ", floorInfo: "3F 南側" });
    expect(matchesFilter(t, baseFilter({ searchQuery: "ヒカリエ" }))).toBe(true);
    expect(matchesFilter(t, baseFilter({ searchQuery: "3f" }))).toBe(true);
    expect(matchesFilter(t, baseFilter({ searchQuery: "新宿" }))).toBe(false);
  });

  it("filters by data source", () => {
    const t = mk("a", { dataSource: "community" });
    expect(matchesFilter(t, baseFilter({ dataSource: "community" }))).toBe(true);
    expect(matchesFilter(t, baseFilter({ dataSource: "osm" }))).toBe(false);
  });

  it("applies equipment toggles", () => {
    const washlet = mk("a", { attributes: { ...mk("x").attributes, hasWashlet: true } });
    expect(matchesFilter(washlet, baseFilter({ onlyWashlet: true }))).toBe(true);
    expect(matchesFilter(washlet, baseFilter({ onlyMultipurpose: true }))).toBe(false);
    // 未確認(null)は「あり」フィルタに一致させない（不明を「あり」と断定しない）
    const unknown = mk("u", {
      attributes: { ...mk("x").attributes, hasWashlet: null as boolean | null },
    });
    expect(matchesFilter(unknown, baseFilter({ onlyWashlet: true }))).toBe(false);
    expect(matchesFilter(unknown, baseFilter({}))).toBe(true);
    expect(
      matchesFilter(
        mk("b", {
          attributes: { ...mk("x").attributes, hasMultipurpose: true, hasPowderRoom: true, isOpen24h: true },
        }),
        baseFilter({ onlyMultipurpose: true, onlyPowderRoom: true, only24h: true })
      )
    ).toBe(true);
  });

  it("onlyHighCleanliness keeps S/A (score >= 4.0) and drops the rest", () => {
    expect(matchesFilter(evaluated("s", 4.0), baseFilter({ onlyHighCleanliness: true }))).toBe(true);
    expect(matchesFilter(evaluated("a", 3.9), baseFilter({ onlyHighCleanliness: true }))).toBe(false);
  });

  it("onlyHighCleanliness drops unscored community registrations (null score must not leak through)", () => {
    // 回帰: null < 4.0 は false のため、未スコア施設がS・A級フィルタを素通ししていた。
    // スコアが無い（=未評価）施設はグレード判定の対象外として除外する。
    const unscored = mk("unscored", {
      dataSource: "community",
      cleanlinessGrade: null as never,
      cleanlinessScore: null as never,
      equipmentGrade: null as never,
      equipmentScore: null as never,
    });
    expect(matchesFilter(unscored, baseFilter({ onlyHighCleanliness: true }))).toBe(false);
    // フィルタ無しでは通常通り表示される（消えてはならない）
    expect(matchesFilter(unscored, baseFilter())).toBe(true);
  });

  it("onlyHighCleanliness keeps un-reviewed facilities with a high survey/estimate grade", () => {
    // 口コミ0件でも表示グレード（調査/推定）で判定する。初期状態でフィルタが
    // 全件除外になるのを防ぐため、実測・調査・推定を区別せずスコアで通す
    const unratedHighEstimate = mk("unrated-high", {
      reviewCount: 0,
      cleanlinessScore: 4.5,
      cleanlinessGrade: "A",
      equipmentScore: 4.5,
      equipmentGrade: "A",
    });
    expect(matchesFilter(unratedHighEstimate, baseFilter({ onlyHighCleanliness: true }))).toBe(true);
    expect(matchesFilter(evaluated("rated-high", 4.5), baseFilter({ onlyHighCleanliness: true }))).toBe(true);
    expect(matchesFilter(mk("low-estimate", { equipmentScore: 3.0, equipmentGrade: "B" }), baseFilter({ onlyHighCleanliness: true }))).toBe(false);
  });

  it("handles quickPreset correctly", () => {
    const babyFacility = mk("baby", { attributes: { ...mk("x").attributes, hasBabyTable: true } });
    const regularFacility = mk("regular");
    expect(matchesFilter(babyFacility, baseFilter({ quickPreset: "baby" }))).toBe(true);
    expect(matchesFilter(regularFacility, baseFilter({ quickPreset: "baby" }))).toBe(false);

    const barrierFacility = mk("barrier", { attributes: { ...mk("x").attributes, hasMultipurpose: true } });
    expect(matchesFilter(barrierFacility, baseFilter({ quickPreset: "barrier_free" }))).toBe(true);
    expect(matchesFilter(regularFacility, baseFilter({ quickPreset: "barrier_free" }))).toBe(false);

    const femaleFacility = mk("female", {
      category: "department",
      attributes: { ...mk("x").attributes, hasPowderRoom: true },
    });
    expect(matchesFilter(femaleFacility, baseFilter({ quickPreset: "female_safe" }))).toBe(true);
    expect(matchesFilter(regularFacility, baseFilter({ quickPreset: "female_safe" }))).toBe(false);

    const open24Facility = mk("open24", { attributes: { ...mk("x").attributes, isOpen24h: true } });
    expect(matchesFilter(open24Facility, baseFilter({ quickPreset: "night_24h" }))).toBe(true);
    expect(matchesFilter(regularFacility, baseFilter({ quickPreset: "night_24h" }))).toBe(false);
  });

  it("filters by onlyFavorites when favoriteIdSet is provided", () => {
    const favFacility = mk("fav-1");
    const nonFavFacility = mk("non-fav");
    const favSet = new Set(["fav-1"]);

    expect(matchesFilter(favFacility, baseFilter({ onlyFavorites: true }), favSet)).toBe(true);
    expect(matchesFilter(nonFavFacility, baseFilter({ onlyFavorites: true }), favSet)).toBe(false);
  });

  it("excludes everything when onlyFavorites is set but the set is missing (#105)", () => {
    expect(matchesFilter(mk("fav-1"), baseFilter({ onlyFavorites: true }), undefined)).toBe(false);
    expect(
      matchesFilter(mk("fav-1"), baseFilter({ quickPreset: "favorites" }), undefined)
    ).toBe(false);
  });

  it("treats null scores as 0 in displayScore (no NaN into sort, #105)", () => {
    expect(displayScore(mk("u", { cleanlinessScore: null, equipmentScore: null }))).toBe(0);
  });
});

describe("displayScore", () => {
  it("uses the real review average when evaluated, else the equipment estimate", () => {
    expect(displayScore(evaluated("x", 4.2))).toBe(4.2);
    expect(displayScore(mk("y", { equipmentScore: 3.6 }))).toBe(3.6);
  });
});

describe("sortToiletsForDisplay / filterAndSortToilets", () => {
  it("puts evaluated toilets first (score desc), then unevaluated by estimate", () => {
    const toilets = [
      mk("unrated-3.4", { equipmentScore: 3.4 }),
      evaluated("rated-4.2", 4.2),
      evaluated("rated-4.8", 4.8),
      mk("unrated-4.1", { equipmentScore: 4.1 }),
    ];
    expect(sortToiletsForDisplay(toilets).map((t) => t.id)).toEqual([
      "rated-4.8",
      "rated-4.2",
      "unrated-4.1",
      "unrated-3.4",
    ]);
  });

  it("stays deterministic for equal scores (id asc)", () => {
    const toilets = [mk("z", { equipmentScore: 3.5 }), mk("a", { equipmentScore: 3.5 })];
    expect(sortToiletsForDisplay(toilets).map((t) => t.id)).toEqual(["a", "z"]);
  });

  it("filters then sorts (one combined call)", () => {
    const washletAttrs = { ...mk("x").attributes, hasWashlet: true };
    const toilets = [
      evaluated("keep-low", 3.0, { attributes: washletAttrs }), // 清潔度3.0: S・A級で除外
      evaluated("keep-high", 4.8, { attributes: washletAttrs }),
      mk("drop-unrated", {
        attributes: { ...washletAttrs, hasWashlet: false },
        cleanlinessScore: 4.2,
        equipmentScore: 4.2,
      }), // 未評価だが推定4.2でS・A級は通る。ウォシュレット無しで除外
    ];
    const out = filterAndSortToilets(
      toilets,
      baseFilter({ onlyHighCleanliness: true, onlyWashlet: true })
    );
    expect(out.map((t) => t.id)).toEqual(["keep-high"]);
  });

  it("sorts by distance when sortOption is distance and referencePoint is given", () => {
    const near = mk("near", { lat: 35.6601, lng: 139.7001 });
    const mid = mk("mid", { lat: 35.6650, lng: 139.7050 });
    const far = mk("far", { lat: 35.6800, lng: 139.7200 });
    const ref = { lat: 35.6600, lng: 139.7000 };

    const sorted = filterAndSortToilets([far, near, mid], baseFilter(), "distance", ref);
    expect(sorted.map((t) => t.id)).toEqual(["near", "mid", "far"]);
  });

  it("falls back to cleanliness order for distance sort without a reference (#105)", () => {
    const low = evaluated("low", 3.0);
    const high = evaluated("high", 4.8);
    expect(filterAndSortToilets([low, high], baseFilter(), "distance", null).map((t) => t.id)).toEqual([
      "high",
      "low",
    ]);
    expect(filterAndSortToilets([low, high], baseFilter(), "distance", undefined).map((t) => t.id)).toEqual([
      "high",
      "low",
    ]);
  });

  it("sorts by review count for the reviews option (wired to UI, #105)", () => {
    const few = evaluated("few", 4.8);
    const many = { ...evaluated("many", 3.0), reviewCount: 10, reviews: [] };
    const none = mk("none");
    expect(filterAndSortToilets([none, few, many], baseFilter(), "reviews").map((t) => t.id)).toEqual([
      "many",
      "few",
      "none",
    ]);
  });
});
