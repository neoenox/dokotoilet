// 手動調査JSON → src/data/googleSeed.ts 生成
// 使い方: bun scripts/manual-import/run.ts --in a.json [--in b.json ...] [--out <file>]
// 複数 --in は結合して1ファイルに出力する（渋谷分を消さないため）
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { convertItems, type ManualItem } from "./convert";
import { geocodeBestEffort, sleep } from "./geocode";
import { passesGuard } from "../../src/lib/seed";

interface BatchFile {
  center: [number, number];
  maxKm: number;
  items: ManualItem[];
}

function normalize(raw: unknown, path: string): BatchFile {
  if (Array.isArray(raw)) {
    // ガードなし旧形式（全件ジオコーディング不要な場合のみ使うこと）
    return { center: [0, 0], maxKm: Number.POSITIVE_INFINITY, items: raw as ManualItem[] };
  }
  const b = raw as Partial<BatchFile>;
  if (!Array.isArray(b.items) || !Array.isArray(b.center) || typeof b.maxKm !== "number") {
    throw new Error(`invalid batch file: ${path}`);
  }
  return b as BatchFile;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function argsAll(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === name && i + 1 < process.argv.length) out.push(process.argv[i + 1]);
  });
  return out;
}

const inPaths = argsAll("--in");
if (inPaths.length === 0) {
  console.error("usage: bun scripts/manual-import/run.ts --in <input.json> [--in ...] [--out <file>]");
  process.exit(1);
}
const outPath = arg("--out") ?? path.join(process.cwd(), "src", "data", "googleSeed.ts");

const items: ManualItem[] = [];
for (const p of inPaths) {
  const raw = await readFile(p, "utf-8");
  const batch = normalize(JSON.parse(raw), p);
  for (const item of batch.items) {
    item.batchGuard = { center: batch.center, maxKm: batch.maxKm };
    items.push(item);
  }
}

// Nominatimポリシー遵守: 逐次＋1.2秒間隔
let geocoded = 0;
const unguarded: { name: string; reason: string }[] = [];
const matchedBy: Record<string, number> = {};
const guardRejected: string[] = [];
const { facilities, skipped, warnings } = await convertItems(items, {
  geocode: async ({ name, address, geoQuery, guard }) => {
    // ガードなし旧形式のジオコーディングは同名異地の誤配置を防げないため
    // 取込不可にする（座標ありの項目は geocode 自体が呼ばれないため影響なし。#111）
    if (!guard || !(guard.maxKm < Number.POSITIVE_INFINITY)) {
      unguarded.push({ name, reason: "ガードなし旧形式のためジオコーディング不可（座標を調査値で補完すること）" });
      return null;
    }
    await sleep(1200);
    const g = await geocodeBestEffort(name, address, geoQuery);
    if (g) {
      // 同名異地の誤配置防止（例：中央公園→NY）。外れたら不採用
      if (guard && !passesGuard(g.lat, g.lng, guard)) {
        guardRejected.push(`${name} (>${guard.maxKm}km)`);
        return null;
      }
      geocoded += 1;
      matchedBy[g.matched] = (matchedBy[g.matched] ?? 0) + 1;
      return { lat: g.lat, lng: g.lng };
    }
    return null;
  },
});

const header = `// 自動生成: bun scripts/manual-import/run.ts --in ${inPaths.map((p) => path.basename(p)).join(" --in ")}
// 生成日: ${new Date().toISOString().split("T")[0]}
// 由来: ChatGPT手動調査（Google Maps掲載情報の要約・自治体調査）。座標欠落分はNominatimで補完。
// 規約: 口コミ本文（ユーザー投稿の転載）は取り込まない。件数と要約のみ（README「データ方針」参照）。
// 設備の不明値は null（未確認）として格納。信頼度lowは中立値3.0＋要確認メモ。
import type { ToiletFacility } from "../types";

export const GOOGLE_SEED: ToiletFacility[] = `;
await writeFile(outPath, header + JSON.stringify(facilities, null, 2) + "\n", "utf-8");

console.log(`input: ${items.length}件 / geocoded: ${geocoded}件 ${JSON.stringify(matchedBy)}`);
console.log(`wrote: ${outPath}（${facilities.length}件）`);
for (const s of skipped) console.log(`skip: ${s.name} — ${s.reason}`);
for (const u of unguarded) console.log(`skip(unguarded): ${u.name} — ${u.reason}`);
for (const w of warnings) console.log(`warn: ${w.name} — ${w.reason}`);
for (const r of guardRejected) console.log(`guard-reject: ${r}`);
