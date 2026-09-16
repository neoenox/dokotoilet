import type { ToiletFacility, TriState, ToiletAttributes } from "../types";

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

export interface AreaGuard {
  center: [number, number];
  maxKm: number;
}

/** 同名異地の誤配置防止（例：中央公園→NY）。範囲外は false */
export function passesGuard(lat: number, lng: number, guard?: AreaGuard): boolean {
  if (!guard) return true;
  return haversineM(lat, lng, guard.center[0], guard.center[1]) / 1000 <= guard.maxKm;
}

/** 2点間の距離（m）。シード重複排除用 */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// 重複時にOR統合する設備フラグ。除外するもの：
// - isOpen24h: openingHours文字列と矛盾するため（例：07:00-23:00表示＋24hチップ）。
//   primary側の値をそのまま使う
// - isFree: 全件trueのため統合が無意味
// - hasSoap/hasAlcohol/hasPaperTowelOrDryer: 旧シードの楽観デフォルト由来で信頼性が低い
/** 3値（true/false/null）のOR統合: どちらかが true なら true。
 * 確認済みの false（「なし」）は未確認(null)より優先（null で確定情報を潰さない）。
 * 両方未確認(null)のときのみ null を維持する。 */
function unionTriState(a: TriState, b: TriState): TriState {
  if (a === true || b === true) return true;
  if (a === false || b === false) return false;
  return null;
}

const UNION_BOOL_KEYS = [
  "hasWashlet",
  "hasMultipurpose",
  "hasBabyTable",
  "hasNursingRoom",
  "hasPowderRoom",
  "hasOstomate",
] as const;

/**
 * シードリストの結合。primary を優先し、secondary 側で primary のいずれかと
 * radiusM 以内にあるものは重複として落とす（例：OSMとGoogleの同一施設）。
 * ただし設備の有無フラグは両者のORを残す（どちらかが確認した設備は活かす）。
 */
export function mergeSeedLists(
  primary: ToiletFacility[],
  secondary: ToiletFacility[],
  radiusM = 30
): ToiletFacility[] {
  const merged: ToiletFacility[] = [...primary];
  for (const cand of secondary) {
    const dup = merged.find(
      (m) => haversineM(m.lat, m.lng, cand.lat, cand.lng) <= radiusM
    );
    if (!dup) {
      merged.push(cand);
      continue;
    }
    // dup.attributes が存在すればライブ参照へ直接統合し、欠落時のみ新規割当する
    // （スプレッドコピーにすると既存オブジェクトへの書戻しが失われるため参照を維持）
    const dupAttrs: Partial<ToiletAttributes> = dup.attributes ?? {};
    const candAttrs: Partial<ToiletAttributes> = cand.attributes ?? {};
    for (const k of UNION_BOOL_KEYS) {
      dupAttrs[k] = unionTriState(dupAttrs[k] ?? null, candAttrs[k] ?? null);
    }
    if (!dup.attributes) dup.attributes = dupAttrs as ToiletAttributes;
  }
  // 防衛: 同一IDが残っていたら施設を捨てずに一意化する（Reactキー/共有レビュー鍵の衝突防止）。
  // 本来はデータ生成側で防ぐべきで、ここが発火したら import スクリプト側を修正する。
  return uniquifyIds(merged);
}

/**
 * 同一IDの施設を捨てずに -2, -3, … の接尾辞で一意化する。
 * 別名の同一ID（例: 町字IDの誤用）で別施設が潰れないようにする最終防衛線。
 */
export function uniquifyIds(toilets: ToiletFacility[]): ToiletFacility[] {
  const seen = new Set<string>();
  return toilets.map((t) => {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      return t;
    }
    let n = 2;
    let next = `${t.id}-${n}`;
    while (seen.has(next)) {
      n += 1;
      next = `${t.id}-${n}`;
    }
    seen.add(next);
    console.warn(
      `[seed] 重複IDを一意化: ${t.id} -> ${next}（${t.name}）。データ生成元（scripts/opendata-import等）を確認してください。`
    );
    return { ...t, id: next };
  });
}
