// OSM Nominatim によるジオコーディング（無料・キー不要）。
// 利用ポリシー: 1 req/s 以下・連絡可能なUA必須。
export async function geocodeNominatim(
  address: string,
  fetchFn: typeof fetch = fetch
): Promise<{ lat: number; lng: number } | null> {
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" +
    encodeURIComponent(address);
  const res = await fetchFn(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "kirei-toilet/1.0 (+https://github.com/kaenozu/dokotoilet)",
      Referer: "https://github.com/kaenozu/dokotoilet",
    },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ lat: string; lon: string }>;
  if (!Array.isArray(data) || data.length === 0) return null;
  const lat = parseFloat(data[0].lat);
  const lng = parseFloat(data[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cleanAddress(address: string): string {
  return address
    .replace(/^日本[、。]?\s*/, "")
    .replace(/〒\d{3}-\d{4}\s*/, "")
    .trim();
}

/**
 * 名前→住所の順で試す。番地まで含む日本語住所は Nominatim が苦手なため、
 * 施設名を優先する。どのクエリでヒットしたかも返す（ログ用）。
 * 候補間の連続リクエストで Nominatim ポリシー（1 req/s）を割らないよう、
 * 2件目以降の前に約1.1秒待つ（#111）。
 */
export async function geocodeBestEffort(
  name: string,
  address: string | null,
  geoQuery?: string,
  fetchFn: typeof fetch = fetch
): Promise<{ lat: number; lng: number; matched: string } | null> {
  const candidates: Array<{ q: string; label: string }> = [];
  if (geoQuery) candidates.push({ q: geoQuery, label: "geoQuery" });
  candidates.push({ q: name, label: "name" });
  if (address) {
    const cleaned = cleanAddress(address);
    if (cleaned && cleaned !== name) candidates.push({ q: cleaned, label: "address" });
  }
  for (let i = 0; i < candidates.length; i++) {
    if (i > 0) await sleep(1100);
    const c = candidates[i];
    const g = await geocodeNominatim(c.q, fetchFn);
    if (g) return { ...g, matched: c.label };
  }
  return null;
}

