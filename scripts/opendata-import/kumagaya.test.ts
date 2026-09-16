import { describe, expect, it } from "vitest";
import { mapKumagayaRows, parseCsv } from "./kumagaya";

const HEADER = [
  "名称", "町字ID", "所在地_連結表記", "設置位置", "緯度", "経度",
  "バリアフリートイレ数", "車椅子使用者用トイレ有無", "乳幼児用設備設置トイレ有無",
  "オストメイト設置トイレ有無", "利用開始時間", "利用終了時間", "利用可能時間特記事項",
  "男性トイレ数_和式", "男性トイレ数_洋式", "女性トイレ数_和式", "女性トイレ数_洋式",
  "男女共同トイレ数_和式", "男女共同トイレ数_洋式",
];

const row = (patch: Record<string, string> = {}): string[] => {
  const base: Record<string, string> = {
    "名称": "テスト公園便所", "町字ID": "0000001", "所在地_連結表記": "埼玉県熊谷市テスト1-1",
    "設置位置": "公園内", "緯度": "36.14", "経度": "139.38",
    "バリアフリートイレ数": "0", "車椅子使用者用トイレ有無": "無",
    "乳幼児用設備設置トイレ有無": "無", "オストメイト設置トイレ有無": "無",
    "利用開始時間": "", "利用終了時間": "", "利用可能時間特記事項": "",
    "男性トイレ数_和式": "", "男性トイレ数_洋式": "", "女性トイレ数_和式": "",
    "女性トイレ数_洋式": "", "男女共同トイレ数_和式": "", "男女共同トイレ数_洋式": "",
    ...patch,
  };
  return HEADER.map((h) => base[h] ?? "");
};

describe("parseCsv", () => {
  it("handles BOM, quotes and commas", () => {
    const rows = parseCsv('\uFEFFa,b\n"1,2",3\n');
    expect(rows).toEqual([["a", "b"], ["1,2", "3"]]);
  });
});

describe("mapKumagayaRows", () => {
  it("maps a basic row to opendata facility", () => {
    const { facilities, skipped } = mapKumagayaRows(HEADER, [row()]);
    expect(skipped).toEqual([]);
    expect(facilities).toHaveLength(1);
    const f = facilities[0];
    expect(f.id).toBe("od-kumagaya-0000001");
    expect(f.dataSource).toBe("opendata");
    // 推定モデル（estimate.ts）: 情報なしの公園トイレは基準値3.0
    expect(f.cleanlinessScore).toBe(3.0);
    expect(f.equipmentGrade).toBe("B");
    expect(f.estimateBasis?.length).toBeGreaterThan(0);
    expect(f.reviewCount).toBe(0);
    // 利用時間列が空でも「24時間」とは断定しない（未確認 = null）。
    // 表示文言も「常時開放」と断定せず未確認にする（#110）。
    expect(f.attributes.isOpen24h).toBeNull();
    expect(f.openingHours).toBe("営業時間未確認");
    // 和式・洋式の件数が両方 0（情報なし）でも "both" とは断定しない
    expect(f.attributes.toiletStyle).toBeNull();
  });

  it("uniquifies facilities that share the same 町字ID", () => {
    const { facilities } = mapKumagayaRows(HEADER, [
      row({ "名称": "A公園便所" }),
      row({ "名称": "B公園便所", "緯度": "36.15", "経度": "139.39" }),
      row({ "名称": "C公園便所", "緯度": "36.16", "経度": "139.40" }),
    ]);
    expect(facilities.map((f) => f.id)).toEqual([
      "od-kumagaya-0000001",
      "od-kumagaya-0000001-2",
      "od-kumagaya-0000001-3",
    ]);
    expect(new Set(facilities.map((f) => f.id)).size).toBe(3);
  });

  it("scores station + equipment via the shared estimate model", () => {
    const { facilities } = mapKumagayaRows(HEADER, [
      row({ "名称": "熊谷駅前便所", "車椅子使用者用トイレ有無": "有", "オストメイト設置トイレ有無": "有" }),
    ]);
    // 3.0 + 駅0.2 + 多機能0.2 + オストメイト0.2 = 3.6（推定はA止まりの範囲内）
    expect(facilities[0].cleanlinessScore).toBe(3.6);
    expect(facilities[0].category).toBe("station");
    expect(facilities[0].estimateBasis?.join("")).toContain("オストメイト");
  });

  it("derives 'both' style only when both counts are positive", () => {
    const { facilities } = mapKumagayaRows(HEADER, [
      row({ "男性トイレ数_和式": "1", "男性トイレ数_洋式": "1" }),
    ]);
    expect(facilities[0].attributes.toiletStyle).toBe("both");
  });

  it("derives western style and opening hours", () => {
    const { facilities } = mapKumagayaRows(HEADER, [
      row({ "男性トイレ数_洋式": "2", "利用開始時間": "8:00:00", "利用終了時間": "17:00:00" }),
    ]);
    expect(facilities[0].attributes.toiletStyle).toBe("western");
    expect(facilities[0].attributes.isOpen24h).toBe(false);
    expect(facilities[0].openingHours).toContain("8:00:00");
  });

  it("skips rows without name or coords", () => {
    const { facilities, skipped } = mapKumagayaRows(HEADER, [
      row({ "名称": "" }),
      row({ "名称": "x", "緯度": "" }),
    ]);
    expect(facilities).toHaveLength(0);
    expect(skipped).toHaveLength(2);
  });

  it("throws on missing columns", () => {
    expect(() => mapKumagayaRows(["名称"], [row()])).toThrow();
  });

  it("uses the last occurrence of duplicated columns", () => {
    const dupHeader = [...HEADER];
    dupHeader.splice(3, 0, "緯度", "経度"); // 空の重複列を前に挿入
    const dupRow = row();
    dupRow.splice(3, 0, "", "");
    const { facilities } = mapKumagayaRows(dupHeader, [dupRow]);
    expect(facilities).toHaveLength(1);
    expect(facilities[0].lat).toBe(36.14);
  });
});
