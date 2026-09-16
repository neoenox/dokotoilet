import type { FacilityCategory, ToiletFacility } from "../../src/types";
import { estimateEquipmentScore } from "../../src/lib/estimate";

// 熊谷市「公衆トイレ一覧」（くまっぷオープンデータ、2023/10/02掲載）
// 出典: https://www2.wagmap.jp/kumagaya/OpenData
// CSV直リンク: https://www2.wagmap.jp/kumagaya/kumagaya/opendatafile/map_50/CSV/opendata_705.csv

export const KUMAGAYA_CSV_URL =
  "https://www2.wagmap.jp/kumagaya/kumagaya/opendatafile/map_50/CSV/opendata_705.csv";
export const KUMAGAYA_SOURCE_LABEL = "熊谷市「公衆トイレ一覧」（2023年10月2日掲載）";

// 最小CSVパーサ（クォート対応。外部依存なし）
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else if (ch === "\r") {
      // skip (handled with \n)
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export interface KumagayaMapped {
  facilities: ToiletFacility[];
  skipped: { name: string; reason: string }[];
}

const num = (v: string): number => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};
const has = (v: string): boolean => v === "有";

export function mapKumagayaRows(header: string[], rows: string[][]): KumagayaMapped {
  // 注意: 公式CSVは緯度/経度列が重複している（前半は空、後半の経度→緯度順に実値）。
  // 最終出現を採用する（Python csv.DictReader と同じ挙動）。
  const col = (name: string): number => header.lastIndexOf(name);
  const c = {
    name: col("名称"),
    id: col("町字ID"),
    address: col("所在地_連結表記"),
    place: col("設置位置"),
    lat: col("緯度"),
    lng: col("経度"),
    barrier: col("バリアフリートイレ数"),
    wheelchair: col("車椅子使用者用トイレ有無"),
    baby: col("乳幼児用設備設置トイレ有無"),
    ostomate: col("オストメイト設置トイレ有無"),
    start: col("利用開始時間"),
    end: col("利用終了時間"),
    note: col("利用可能時間特記事項"),
    mWashiki: col("男性トイレ数_和式"),
    mYoshiki: col("男性トイレ数_洋式"),
    wWashiki: col("女性トイレ数_和式"),
    wYoshiki: col("女性トイレ数_洋式"),
    uWashiki: col("男女共同トイレ数_和式"),
    uYoshiki: col("男女共同トイレ数_洋式"),
  };
  for (const [k, v] of Object.entries(c)) {
    if (v < 0) throw new Error(`column missing: ${k}`);
  }

  const facilities: ToiletFacility[] = [];
  const skipped: { name: string; reason: string }[] = [];
  // 町字IDは「町字」単位のコードで施設ごとに一意ではない。同一IDの2件目以降は
  // 行順に -2, -3 … を付与して施設ID（Reactキー・サーバー共有レビュー鍵）を一意化する
  const usedIds = new Map<string, number>();

  for (const r of rows) {
    const name = (r[c.name] || "").trim();
    if (!name) {
      skipped.push({ name: "(無名)", reason: "名称が空" });
      continue;
    }
    const lat = parseFloat(r[c.lat]);
    const lng = parseFloat(r[c.lng]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      skipped.push({ name, reason: "座標なし" });
      continue;
    }
    const rawId = (r[c.id] || "").trim() || `${lat},${lng}`;
    const baseId = `od-kumagaya-${rawId}`;
    const nth = (usedIds.get(baseId) ?? 0) + 1;
    usedIds.set(baseId, nth);
    const id = nth === 1 ? baseId : `${baseId}-${nth}`;
    const wheelchair = has(r[c.wheelchair]);
    const baby = has(r[c.baby]);
    const ostomate = has(r[c.ostomate]);
    const barrier = num(r[c.barrier]);
    const hasMultipurpose = wheelchair || barrier > 0;

    const yoshiki = num(r[c.mYoshiki]) + num(r[c.wYoshiki]) + num(r[c.uYoshiki]);
    const washiki = num(r[c.mWashiki]) + num(r[c.wWashiki]) + num(r[c.uWashiki]);
    // 両方 0 は「情報なし」。和式・洋式のどちらかが確認できる場合のみ断定する。
    // 全セル空（0件）を "both"（両方あり）と断定するのは過剰解釈。
    const toiletStyle: "western" | "japanese" | "both" | null =
      yoshiki > 0 && washiki === 0
        ? "western"
        : washiki > 0 && yoshiki === 0
        ? "japanese"
        : yoshiki > 0 && washiki > 0
        ? "both"
        : null;

    const start = (r[c.start] || "").trim();
    const end = (r[c.end] || "").trim();
    const timeNote = (r[c.note] || "").trim();
    const hasHours = (start && start !== "なし") || (end && end !== "なし");
    const openingHours = hasHours
      ? `${start || "?"}～${end || "?"}${timeNote ? `（${timeNote}）` : ""}`
      : "営業時間未確認";
    // 利用時間列が無いことは「24時間営業」の根拠にならない。
    // 常時開放と断定せず null（未確認）とする。表示文言も未確認にする。
    const isOpen24h: boolean | null = hasHours ? false : null;
    const category: FacilityCategory = name.includes("駅") ? "station" : "park";
    // 設備推定スコア（実測口コミなし）。推定モデルは src/lib/estimate.ts に一本化
    const estimate = estimateEquipmentScore({
      category,
      hasWashlet: null, // CSVにウォシュレット列なし。断定せず null
      hasMultipurpose: hasMultipurpose,
      hasOstomate: ostomate,
      hasBabyTable: baby,
      toiletStyle,
      isFree: null,
      isOpen24h,
    });
    const score = estimate.score;
    const grade = estimate.grade;
    const place = (r[c.place] || "").trim();

    facilities.push({
      id,
      name,
      facilityType: "熊谷市 管理公衆便所",
      category,
      dataSource: "opendata",
      lat,
      lng,
      address: (r[c.address] || "").trim() || "住所不明",
      cleanlinessGrade: grade,
      cleanlinessScore: score,
      equipmentGrade: grade,
      equipmentScore: score,
      subScores: { cleanliness: score, odor: score, supplies: score, comfort: score },
      attributes: {
        // CSVに無い項目は true/false と断定せず null（未確認）で保存する
        hasWashlet: null,
        hasMultipurpose: wheelchair || barrier > 0,
        hasBabyTable: baby,
        hasNursingRoom: null,
        hasPowderRoom: null,
        hasOstomate: ostomate,
        isFree: null,
        isOpen24h,
        hasSoap: null,
        hasAlcohol: null,
        hasPaperTowelOrDryer: null,
        toiletStyle,
      },
      openingHours,
      description: `${KUMAGAYA_SOURCE_LABEL}に基づく設備情報。実測口コミなし。${place ? `設置位置: ${place}` : ""}`,
      reviewCount: 0,
      reviews: [],
      facilityNote: `出典：熊谷市「公衆トイレ一覧」（くまっぷオープンデータ）。公式設備データ。`,
      estimateBasis: estimate.basis,
      googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
      officialOpenDataId: id,
    });
  }

  return { facilities, skipped };
}
