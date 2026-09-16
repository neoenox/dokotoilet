import { describe, expect, it } from "vitest";
import { convertItems, type ManualItem } from "./convert";

const base: ManualItem = {
  name: "テスト施設",
  category: "park",
  lat: 35.66,
  lng: 139.7,
  address: "東京都渋谷区テスト1-1",
  openingHours: "24時間営業",
  cleanlinessScore: 4.2,
  confidence: "high",
  scoreBasis: "口コミ10件中8件が好意的",
  equipment: {
    hasWashlet: true,
    hasMultipurpose: true,
    hasBabyTable: null,
    hasPowderRoom: null,
    isOpen24h: true,
  },
  googleMapsUrl: "https://www.google.com/maps/place/?q=place_id:ChIJTEST123",
};

const noGeo = async () => {
  throw new Error("geocode must not be called");
};

describe("convertItems", () => {
  it("maps a full item (google id + scores) without any review text", async () => {
    const { facilities, skipped, warnings } = await convertItems([base], { geocode: noGeo });
    expect(skipped).toEqual([]);
    expect(warnings).toEqual([]);
    expect(facilities).toHaveLength(1);
    const f = facilities[0];
    expect(f.id).toBe("google-ChIJTEST123");
    expect(f.dataSource).toBe("google");
    // 回帰: facilityTypeForCategory 共通化の際に FACILITY_TYPE[category] と
    // 誤記して facilityType が undefined 欠落した。再発防止のため全カテゴリを検証
    expect(f.facilityType).toBe("公衆トイレ");
    for (const [category, label] of [
      ["department", "商業施設・デパート"],
      ["station", "駅・交通施設"],
      ["convenience", "コンビニ"],
      ["hotel", "ホテル・オフィス"],
      ["cafe", "カフェ・飲食店"],
    ] as const) {
      const { facilities: one } = await convertItems(
        [{ ...base, name: `種別確認-${category}`, category }],
        { geocode: noGeo }
      );
      expect(one[0].facilityType).toBe(label);
    }
    expect(f.cleanlinessScore).toBe(4.2);
    expect(f.equipmentScore).toBe(4.2);
    expect(f.attributes.hasWashlet).toBe(true);
    expect(f.attributes.hasBabyTable).toBeNull(); // 未調査(null)を false に潰さない
    // 調査で確認していない項目は true/false と断定せず null（未確認）
    expect(f.attributes.isFree).toBeNull();
    expect(f.attributes.hasSoap).toBeNull();
    expect(f.attributes.toiletStyle).toBeNull();
    // 口コミ本文は取り込まない: 常に未評価で reviews は空
    expect(f.reviewCount).toBe(0);
    expect(f.reviews).toEqual([]);
    expect(JSON.stringify(facilities)).not.toContain("rev-gmaps");
  });

  it("never embeds verbatim review text and warns when legacy excerpts are present", async () => {
    const legacy = {
      ...base,
      reviewExcerpts: [
        { text: "とても綺麗でした", rating: 5 },
        { text: "汚くて臭かった", rating: 2 },
      ],
    } as unknown as ManualItem;
    const { facilities, skipped, warnings } = await convertItems([legacy], { geocode: noGeo });
    expect(skipped).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].name).toBe("テスト施設");
    expect(warnings[0].reason).toContain("転載禁止");
    // 引用文は施設データのどこにも残らない
    const serialized = JSON.stringify(facilities);
    expect(serialized).not.toContain("とても綺麗でした");
    expect(serialized).not.toContain("汚くて臭かった");
    expect(facilities[0].reviewCount).toBe(0);
    expect(facilities[0].reviews).toEqual([]);
  });

  it("null score becomes neutral 3.0 with confirmation note", async () => {
    const { facilities } = await convertItems(
      [{ ...base, cleanlinessScore: null, confidence: "low" }],
      { geocode: noGeo }
    );
    expect(facilities[0].cleanlinessScore).toBe(3.0);
    expect(facilities[0].equipmentGrade).toBe("B");
    expect(facilities[0].description).toContain("要現地確認");
  });

  it("geocodes missing coordinates", async () => {
    const calls: Array<{ name: string; address: string }> = [];
    const { facilities, skipped } = await convertItems(
      [{ ...base, lat: null, lng: null }],
      {
        geocode: async (target) => {
          calls.push(target);
          return { lat: 35.1, lng: 139.1 };
        },
      }
    );
    expect(calls).toEqual([{ name: "テスト施設", address: "東京都渋谷区テスト1-1" }]);
    expect(skipped).toEqual([]);
    expect(facilities[0].lat).toBe(35.1);
  });

  it("skips when geocoding fails", async () => {
    const { facilities, skipped } = await convertItems(
      [{ ...base, lat: null, lng: null }],
      { geocode: async () => null }
    );
    expect(facilities).toHaveLength(0);
    expect(skipped[0].reason).toContain("座標なし");
  });

  it("skips invalid items (category, url)", async () => {
    const { skipped } = await convertItems(
      [
        { ...base, name: "x", category: "mars" },
        { ...base, name: "y", googleMapsUrl: "not-a-url" },
      ],
      { geocode: noGeo }
    );
    expect(skipped).toHaveLength(2);
  });

  it("records external review counts", async () => {
    const { facilities } = await convertItems(
      [{ ...base, externalReviewCount: 114, externalReviewSource: "Google Maps" }],
      { geocode: noGeo }
    );
    expect(facilities[0].externalReviewCount).toBe(114);
    expect(facilities[0].externalReviewSource).toBe("Google Maps");
  });

  it("drops invalid external review counts", async () => {
    const { facilities } = await convertItems(
      [{ ...base, externalReviewCount: -1 }],
      { geocode: noGeo }
    );
    expect(facilities[0].externalReviewCount).toBeUndefined();
    const zero = await convertItems([{ ...base, externalReviewCount: 0 }], { geocode: noGeo });
    expect(zero.facilities[0].externalReviewCount).toBe(0);
  });

  it("records coordSource in facilityNote", async () => {
    const { facilities } = await convertItems(
      [{ ...base, coordSource: "マピオン電話帳" }],
      { geocode: noGeo }
    );
    expect(facilities[0].facilityNote).toContain("マピオン電話帳");
  });

  it("uses per-dimension subScores with fallback to overall", async () => {
    const { facilities } = await convertItems(
      [
        {
          ...base,
          cleanlinessScore: 4.2,
          subScores: { cleanliness: 4.8, odor: 3.2, supplies: null, comfort: 9 },
        },
      ],
      { geocode: noGeo }
    );
    const sub = facilities[0].subScores;
    expect(sub.cleanliness).toBe(4.8);
    expect(sub.odor).toBe(3.2);
    expect(sub.supplies).toBe(4.2); // null→総合へフォールバック
    expect(sub.comfort).toBe(4.2); // 範囲外→総合へフォールバック
    // 総合スコア・グレードは従来どおり
    expect(facilities[0].cleanlinessScore).toBe(4.2);
  });

  it("omits subScores input entirely without changing output", async () => {
    const { facilities } = await convertItems([{ ...base }], { geocode: noGeo });
    expect(facilities[0].subScores).toEqual({
      cleanliness: 4.2,
      odor: 4.2,
      supplies: 4.2,
      comfort: 4.2,
    });
  });

  it("records surveyedAt only when it is YYYY-MM-DD", async () => {
    const { facilities } = await convertItems(
      [{ ...base, surveyedAt: "2026-09-10" }],
      { geocode: noGeo }
    );
    expect(facilities[0].surveyedAt).toBe("2026-09-10");
    const bad = await convertItems([{ ...base, surveyedAt: "2026/09/10" }], {
      geocode: noGeo,
    });
    expect(bad.facilities[0].surveyedAt).toBeUndefined();
  });

  it("gives same-name facilities distinct ids without place_id (#111)", async () => {
    const mkNoPlace = (address: string) => ({
      ...base,
      name: "中央公園",
      address,
      googleMapsUrl: "https://www.google.com/maps/search/?api=1&query=35.6,139.7",
    });
    const { facilities } = await convertItems(
      [mkNoPlace("東京都A区1-1"), mkNoPlace("東京都B区2-2")],
      { geocode: noGeo }
    );
    expect(facilities).toHaveLength(2);
    expect(facilities[0].id).not.toBe(facilities[1].id);
    for (const f of facilities) expect(f.id.length).toBeLessThanOrEqual(80);
  });

  it("keeps long place_ids unique within 80 chars (#111)", async () => {
    const longA = "ChIJ" + "A".repeat(100);
    const longB = "ChIJ" + "A".repeat(99) + "B";
    const { facilities } = await convertItems(
      [
        { ...base, name: "X", googleMapsUrl: `https://x/?q=place_id:${longA}` },
        { ...base, name: "Y", googleMapsUrl: `https://x/?q=place_id:${longB}` },
      ],
      { geocode: noGeo }
    );
    expect(facilities).toHaveLength(2);
    expect(facilities[0].id).not.toBe(facilities[1].id);
    for (const f of facilities) expect(f.id.length).toBeLessThanOrEqual(80);
  });
});
