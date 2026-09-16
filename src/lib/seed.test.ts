import { describe, expect, it } from "vitest";
import { haversineM, mergeSeedLists, passesGuard, uniquifyIds } from "./seed";
import type { ToiletFacility } from "../types";
// App の SEED_TOILETS と同じ合成を再現して重複IDの回帰を防ぐ
import { GOOGLE_SEED } from "../data/googleSeed";
import { KUMAGAYA_SEED } from "../data/kumagayaSeed";
import { INITIAL_TOILETS } from "../data/toilets";
import { TERMINAL_STATIONS_SEED } from "../data/terminalStationsSeed";

const mk = (id: string, lat: number, lng: number): ToiletFacility =>
  ({ id, lat, lng, reviewCount: 0 } as ToiletFacility);

describe("haversineM", () => {
  it("is ~0 for the same point and ~sane for Shibuya", () => {
    expect(haversineM(35.66, 139.7, 35.66, 139.7)).toBe(0);
    // 渋谷駅〜神宮通公園は約500m
    const d = haversineM(35.659, 139.7006, 35.6642, 139.7021);
    expect(d).toBeGreaterThan(400);
    expect(d).toBeLessThan(700);
  });
});

describe("passesGuard", () => {
  it("rejects homonym misplacements", () => {
    const kumagaya = { center: [36.1477, 139.3889] as [number, number], maxKm: 12 };
    expect(passesGuard(36.14, 139.39, kumagaya)).toBe(true);
    expect(passesGuard(40.7827725, -73.9653627, kumagaya)).toBe(false); // NYの中央公園
    expect(passesGuard(0, 0, undefined)).toBe(true);
  });
});

describe("mergeSeedLists", () => {
  it("prefers primary and drops nearby secondary duplicates", () => {
    const primary = [mk("google-a", 35.66, 139.7)];
    const secondary = [
      mk("osm-near", 35.66005, 139.70005), // ~7m: 重複
      mk("osm-far", 35.67, 139.71), // ~1.4km: 保持
    ];
    const merged = mergeSeedLists(primary, secondary, 30);
    expect(merged.map((t) => t.id)).toEqual(["google-a", "osm-far"]);
  });

  it("unions equipment flags on duplicates", () => {
    const primary = [
      { ...mk("google-a", 35.66, 139.7), attributes: { hasWashlet: false, hasOstomate: false } },
    ];
    const secondary = [
      { ...mk("osm-a", 35.66, 139.7), attributes: { hasWashlet: true, hasOstomate: true } },
    ];
    const merged = mergeSeedLists(primary as any, secondary as any, 30);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("google-a");
    expect(merged[0].attributes.hasWashlet).toBe(true);
    expect(merged[0].attributes.hasOstomate).toBe(true);
  });

  it("keeps primary opening-hours flags (no 24h contradiction)", () => {
    // あまやどり事例：営業時間07:00-23:00＋24hチップの矛盾を防ぐ
    const primary = [
      {
        ...mk("google-a", 35.66, 139.7),
        openingHours: "07:00-23:00",
        attributes: { isOpen24h: false, hasSoap: false, isFree: true },
      },
    ];
    const secondary = [
      {
        ...mk("osm-a", 35.66, 139.7),
        openingHours: "24時間営業",
        attributes: { isOpen24h: true, hasSoap: true, isFree: true },
      },
    ];
    const merged = mergeSeedLists(primary as any, secondary as any, 30);
    expect(merged).toHaveLength(1);
    expect(merged[0].attributes.isOpen24h).toBe(false);
    expect(merged[0].attributes.hasSoap).toBe(false);
    expect(merged[0].openingHours).toBe("07:00-23:00");
  });

  it("unions tri-state flags: true wins, confirmed false beats unknown, both unknown stays null", () => {
    const primary = [
      { ...mk("a", 35.66, 139.7), attributes: { hasWashlet: null, hasOstomate: false, isFree: false } },
    ];
    const secondary = [
      { ...mk("b", 35.66, 139.7), attributes: { hasWashlet: true, hasOstomate: null, isFree: null } },
    ];
    const merged = mergeSeedLists(primary as any, secondary as any, 30);
    expect(merged).toHaveLength(1);
    // true > false > null
    expect(merged[0].attributes.hasWashlet).toBe(true);
    expect(merged[0].attributes.hasOstomate).toBe(false);
    expect(merged[0].attributes.isFree).toBe(false);
    // null同士も「なし」に潰さない
    const bothUnknown = mergeSeedLists(
      [{ ...mk("c", 35.66, 139.7), attributes: { hasSoap: null } }] as any,
      [{ ...mk("d", 35.66, 139.7), attributes: { hasSoap: null } }] as any,
      30
    );
    expect(bothUnknown[0].attributes.hasSoap).toBeNull();
  });

  it("uniquifies colliding ids instead of dropping facilities", () => {
    // 同一ID・別座標の施設（町字IDの誤用のような実データ）が含まれても捨てない
    const out = mergeSeedLists([], [
      mk("od-kumagaya-0000001", 35.66, 139.7),
      mk("od-kumagaya-0000001", 35.67, 139.71),
    ] as any);
    expect(out.map((t) => t.id)).toEqual(["od-kumagaya-0000001", "od-kumagaya-0000001-2"]);
    expect(out).toHaveLength(2);
  });

  it("uniquifyIds never drops facilities and suffixes deterministically", () => {
    const out = uniquifyIds([
      mk("a", 1, 1),
      mk("a", 2, 2),
      mk("a", 3, 3),
      mk("b", 4, 4),
    ] as ToiletFacility[]);
    expect(out.map((t) => t.id)).toEqual(["a", "a-2", "a-3", "b"]);
  });
});

describe("重複IDの回帰防止（App の SEED_TOILETS 合成を再現）", () => {
  it("合成後のシードに同一IDが無い", () => {
    const assembled = mergeSeedLists(
      GOOGLE_SEED,
      mergeSeedLists(KUMAGAYA_SEED, INITIAL_TOILETS)
    );
    const ids = assembled.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(100);
  });
});

const EQUIPMENT_TRI_KEYS = [
  "hasWashlet",
  "hasMultipurpose",
  "hasBabyTable",
  "hasNursingRoom",
  "hasPowderRoom",
  "hasOstomate",
  "hasSoap",
  "hasAlcohol",
  "hasPaperTowelOrDryer",
] as const;

// S級は実測レビューのみ。キュレーション例外（著名プロジェクト枠）のみ許可
const LANDMARK_S_ALLOWLIST = ["osm-2198890502"];

describe("シードの出所・グレード規約（#101 #102）", () => {
  it("TERMINAL seedは全件 dataSource=manual（opendata/osmと偽装しない）", () => {
    expect(TERMINAL_STATIONS_SEED.length).toBeGreaterThan(0);
    for (const t of TERMINAL_STATIONS_SEED) {
      expect(t.dataSource).toBe("manual");
    }
  });

  it("reviewCount=0 の施設にS級を付けない（landmark例外を除く）", () => {
    const all = [
      ...TERMINAL_STATIONS_SEED,
      ...GOOGLE_SEED,
      ...KUMAGAYA_SEED,
      ...INITIAL_TOILETS,
    ];
    for (const t of all) {
      if (t.reviewCount === 0 && !LANDMARK_S_ALLOWLIST.includes(t.id)) {
        expect(t.cleanlinessGrade, `${t.id}.cleanlinessGrade`).not.toBe("S");
        expect(t.equipmentGrade, `${t.id}.equipmentGrade`).not.toBe("S");
        expect(t.cleanlinessScore).toBeLessThanOrEqual(4.5);
        expect(t.equipmentScore).toBeLessThanOrEqual(4.5);
      }
    }
  });

  it("手動・OSM手書きシードはestimateBasisを開示する", () => {
    for (const t of [...TERMINAL_STATIONS_SEED, ...INITIAL_TOILETS]) {
      expect(
        Array.isArray(t.estimateBasis) && t.estimateBasis.length > 0,
        t.id
      ).toBe(true);
    }
  });

  it("INITIAL_TOILETS（landmark除く）の設備フラグは未確認null（楽観断定しない）", () => {
    for (const t of INITIAL_TOILETS) {
      if (LANDMARK_S_ALLOWLIST.includes(t.id)) continue;
      for (const k of EQUIPMENT_TRI_KEYS) {
        expect(t.attributes[k], `${t.id}.${k}`).toBeNull();
      }
      expect(t.attributes.toiletStyle, `${t.id}.toiletStyle`).toBeNull();
    }
  });
});
