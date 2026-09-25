import dns from "node:dns";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";

// Cloud Run / コンテナ環境ではIPv6アウトバウンド経路が存在しない場合があり、
// Node fetchの既定(verbatim=IPv6優先)だと外部Overpass API等への接続がハング・タイムアウトする。
// IPv4を優先解決することで確実に即時接続できるようにする。
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  // 古いランタイム等で未サポートの場合は無視
}
import helmet from "helmet";
import path from "path";
import { createServer as createViteServer } from "vite";
import { REAL_OSM_SEED } from "./src/data/realOsmSeed";
import { createCommunityRouter } from "./server/community";
import { createCommunityRuntime } from "./server/communityRuntime";
import {
  isWithinRadius,
  osmCacheKey,
  resolveCommunitySalt,
} from "./server/runtime";
import {
  formatOsmOpeningHours,
  isTheTokyoToiletTags,
  osmAttributesFromTags,
  triFromFee,
  triFromOpen24h,
  triFromYesNo,
} from "./src/lib/osm";
import { isOsmElementType, osmFacilityId } from "./src/lib/osmIds";
import { estimateEquipmentScore } from "./src/lib/estimate";
import { sanitizeText } from "./src/lib/textPolicy";

/** クエリパラメータ→数値。未指定は undefined、指定があれば数値化（数値化不能は NaN）。 */
function parseQueryNum(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const s = v.trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
    return Number(s);
  }
  return NaN;
}

/**
 * 上限付きJSON読み取り。上流（Overpass）の巨大応答でサーバーがOOMしないよう、
 * reader で受信バイトを計数し、上限超過で即座に中断してエラーを投げる。
 * Content-Length 宣言の有無にかかわらず有効（#109）。
 */
async function readJsonWithLimit(res: globalThis.Response, maxBytes: number): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    // text.length は UTF-16 コード単位のため、マルチバイト応答で実バイト数を
    // 上限より小さく見積もる。reader 経由の計数と単位を揃える（#109 レビュー）。
    const byteLength = Buffer.byteLength(text);
    if (byteLength > maxBytes) throw new Error(`response too large (${byteLength} bytes)`);
    return JSON.parse(text);
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`response too large (>${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return JSON.parse(text);
}

async function startServer() {
  const app = express();
  // Cloud Run / AI Studio は PORT 環境変数を注入する
  const PORT = parseInt(process.env.PORT || "3000", 10) || 3000;

  // Cloud Runはリバースプロキシ配下のため、rate-limitのIP判定用に信頼段数を設定する。
  // 段数は TRUST_PROXY_HOPS（既定1）で変更する。CDN追加時は段数を増やすと
  // req.ip 偽装→投票なりすましの恐れがあるため要精査（.env.example参照）。
  const trustProxyHops = Math.max(
    0,
    parseInt(process.env.TRUST_PROXY_HOPS ?? "1", 10) || 0
  );
  app.set("trust proxy", trustProxyHops);
  // helmetの既定CSPは地図タイル（OSM/国土地理院）とVite開発サーバを壊すため調整する。
  // 開発時（Viteミドルウェア）はCSPを無効化するのが定石。
  // connect-src/script-src は既定維持（地図タイル用の img-src のみ追加）。
  app.use(
    helmet({
      contentSecurityPolicy:
        process.env.NODE_ENV === "production"
          ? {
              directives: {
                ...helmet.contentSecurityPolicy.getDefaultDirectives(),
                "img-src": [
                  "'self'",
                  "data:",
                  "https://tile.openstreetmap.org",
                  "https://cyberjapandata.gsi.go.jp",
                ],
              },
            }
          : false,
    })
  );
  app.use(express.json({ limit: "100kb" }));

  // Health check (apiLimiter適用外: 死活監視をレート制限で落とさないため先に定義)
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // OSMプロキシの踏み台化を防ぐ（/api/配下は1分60リクエスト/IP）
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  app.use("/api/", apiLimiter);

  // Community storage is explicit in production. JSON remains the local/default
  // development backend; Firestore is loaded only when COMMUNITY_BACKEND=firestore.
  const communityRuntime = await createCommunityRuntime({
    backend: process.env.COMMUNITY_BACKEND,
    nodeEnv: process.env.NODE_ENV,
    jsonPath: process.env.COMMUNITY_STORE_PATH,
  });
  const communityStore = communityRuntime.store;
  const communitySalt = resolveCommunitySalt(
    process.env.NODE_ENV,
    process.env.COMMUNITY_SALT
  );

  const adminToken = process.env.ADMIN_TOKEN?.trim() || undefined;
  if (adminToken) {
    console.log("[community] admin moderation API enabled");
  }

  app.use(
    "/api/community",
    createCommunityRouter(
      communityStore,
      communitySalt,
      (facilityId) => communityRuntime.isKnownExternalFacility(facilityId),
      adminToken
    )
  );

  // In-memory cache for live OpenStreetMap Overpass queries (15-minute TTL, LRU cap)
  const osmCache = new Map<string, { timestamp: number; data: any }>();
  const OSM_CACHE_TTL = 15 * 60 * 1000;
  const OSM_CACHE_MAX = 200;

  function osmCacheSet(key: string, data: any) {
    if (osmCache.has(key)) osmCache.delete(key);
    while (osmCache.size >= OSM_CACHE_MAX) {
      const oldest = osmCache.keys().next();
      if (oldest.done) break;
      osmCache.delete(oldest.value);
    }
    osmCache.set(key, { timestamp: Date.now(), data });
  }

  const cacheSweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of osmCache) {
      if (now - entry.timestamp >= OSM_CACHE_TTL) osmCache.delete(key);
    }
  }, 5 * 60 * 1000);
  (cacheSweeper as unknown as { unref?: () => void }).unref?.();

  app.get("/api/osm/toilets", async (req, res) => {
    try {
      const q = {
        lat: parseQueryNum(req.query.lat),
        lng: parseQueryNum(req.query.lng),
        radius: parseQueryNum(req.query.radius),
      };
      if (
        (q.lat !== undefined && !(q.lat >= -90 && q.lat <= 90)) ||
        (q.lng !== undefined && !(q.lng >= -180 && q.lng <= 180)) ||
        (q.radius !== undefined && !(q.radius >= 1 && q.radius <= 3000))
      ) {
        console.warn("[osm-proxy] invalid query parameters:", req.query);
        res.status(400).json({
          error:
            "invalid query parameter: lat (-90..90), lng (-180..180), radius (1..3000)",
        });
        return;
      }
      const lat = q.lat ?? 35.659;
      const lng = q.lng ?? 139.7006;
      const radius = q.radius ?? 1500;

      const cacheKey = osmCacheKey(lat, lng, radius);
      const cached = osmCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < OSM_CACHE_TTL) {
        await communityRuntime.observeExternalFacilities(
          Array.isArray(cached.data?.toilets)
            ? cached.data.toilets
                .map((t: any) => t?.id)
                .filter((id: unknown): id is string => typeof id === "string")
                .map((id: string) => ({
                  id,
                  source: "osm" as const,
                  origin: "live-osm" as const,
                }))
            : []
        );
        res.json(cached.data);
        return;
      }

      // node と way を対象にして relation（広域境界等）を除外し、Overpassの再帰負荷とタイムアウトを大幅低減
      // Honor the server-validated client radius (up to 3 km) so the returned data\n      // matches the search range shown by the UI.\n      const liveRadius = radius;
      const overpassQuery = `[out:json][timeout:5];(node["amenity"="toilets"](around:${liveRadius},${lat},${lng});way["amenity"="toilets"](around:${liveRadius},${lat},${lng}););out center 80;`;
      const mirrors = [
        "https://lz4.overpass-api.de/api/interpreter",
        "https://z.overpass-api.de/api/interpreter",
        "https://overpass-api.de/api/interpreter",
      ];

      let rawElements: any[] = [];
      let upstreamSucceeded = false;
      let lastMirrorError: unknown = null;

      for (const mirrorUrl of mirrors) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3800);
          try {
            const osmResponse = await fetch(mirrorUrl, {
              method: "POST",
              body: "data=" + encodeURIComponent(overpassQuery),
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent":
                  "kirei-toilet/1.0 (+https://github.com/kaenozu/dokotoilet)",
              },
              signal: controller.signal,
            });
            if (!osmResponse.ok) {
              lastMirrorError = new Error(`HTTP ${osmResponse.status}`);
              continue;
            }
            // 巨大応答によるOOMを防ぐため、上限（8MB）を超えたら読み捨てる。
            // Content-Length が無い chunked 応答もあるため reader で計数する。
            const data = await readJsonWithLimit(osmResponse, 8 * 1024 * 1024);
            if (!Array.isArray((data as any)?.elements)) {
              lastMirrorError = new Error("Overpass response missing elements array");
              continue;
            }
            rawElements = (data as any).elements as any[];
            upstreamSucceeded = true;
            break;
          } finally {
            clearTimeout(timeoutId);
          }
        } catch (e) {
          lastMirrorError = e;
          continue;
        }
      }

      if (!upstreamSucceeded) {
        console.warn(
          "[osm-proxy] Overpass mirrors unavailable; falling back to seed dataset:",
          lastMirrorError instanceof Error
            ? lastMirrorError.message
            : "(non-200 / malformed responses)"
        );
      }

      let source: "overpass" | "seed" | "none" = upstreamSucceeded
        ? "overpass"
        : "none";
      if (!upstreamSucceeded) {
        const matchedSeed = REAL_OSM_SEED.filter((el: any) => {
          const itemLat = el.lat ?? el.center?.lat;
          const itemLng = el.lon ?? el.center?.lon;
          return (
            typeof itemLat === "number" &&
            Number.isFinite(itemLat) &&
            typeof itemLng === "number" &&
            Number.isFinite(itemLng) &&
            isWithinRadius(lat, lng, itemLat, itemLng, radius)
          );
        });
        if (matchedSeed.length > 0) {
          rawElements = matchedSeed;
          source = "seed";
        }
      }

      const toilets = rawElements
        .map((el: any) => {
          const itemLat = el.lat ?? el.center?.lat;
          const itemLng = el.lon ?? el.center?.lon;
          const tags = el.tags || {};
          if (!isOsmElementType(el.type)) return null;
          const facilityId = osmFacilityId(el.type, el.id);
          // 上流OSMタグは第三者が編集できるため、表示名・説明文に使う前に
          // 制御・書式文字を除去する（XSS土台化の防止。HTML特殊文字は
          // React側のエスケープ描画＋title属性表示のためサーバーでは触らない）。
          const cleanTag = (v: unknown): string =>
            typeof v === "string" ? sanitizeText(v).trim() : "";
          let name = cleanTag(tags.name) || cleanTag(tags["name:ja"]);
          if (!name) {
            const operator = cleanTag(tags.operator);
            const desc = cleanTag(tags.description);
            if (operator) {
              name = `${operator} 公衆トイレ`;
            } else if (desc) {
              name = `公衆トイレ (${desc})`;
            } else {
              name = `公衆便所 (OSM #${el.id})`;
            }
          } else if (!name.includes("トイレ") && !name.includes("便所")) {
            name = `${name} 公衆トイレ`;
          }

          const isTheTokyoToilet = isTheTokyoToiletTags(tags);
          const isWheelchair = tags.wheelchair === "yes";
          const hasDiaper =
            tags.diaper === "yes" || tags.changing_table === "yes";
          const hasWashlet = triFromYesNo(tags.washlet);
          const isFree = triFromFee(tags.fee);
          const isOpen24h = triFromOpen24h(tags.opening_hours);
          const isOstomate = triFromYesNo(tags.ostomate);

          let category:
            | "park"
            | "station"
            | "convenience"
            | "hotel"
            | "department"
            | "cafe" = "park";
          if (
            tags.operator?.includes("JR") ||
            tags.operator?.includes("メトロ") ||
            tags.operator?.includes("地下鉄") ||
            tags.location === "underground" ||
            tags.description?.includes("駅")
          ) {
            category = "station";
          }

          // 設備推定スコア（実測口コミなし）。推定モデルは src/lib/estimate.ts に一本化。
          // THE TOKYO TOILET は維持管理体制が明確なキュレーション枠（根拠を開示）
          const positionTags = tags["toilets:position"] ?? "";
          const estimate = estimateEquipmentScore({
            category,
            hasWashlet,
            hasMultipurpose: isWheelchair
              ? true
              : tags.wheelchair === "no"
              ? false
              : null,
            hasOstomate: isOstomate,
            hasBabyTable: hasDiaper ? true : null,
            toiletStyle:
              /squat/.test(positionTags) && !/sit/.test(positionTags)
                ? "japanese"
                : null,
            isFree,
            isOpen24h,
            landmark: isTheTokyoToilet,
          });
          const grade = estimate.grade;
          const score = estimate.score;

          const pros: string[] = [];
          if (isTheTokyoToilet)
            pros.push(
              "The Tokyo Toilet プロジェクト (有名建築家デザイン)"
            );
          if (isWheelchair)
            pros.push("多機能・だれでもトイレ / 車椅子対応");
          if (hasWashlet)
            pros.push("温水洗浄便座 (ウォシュレット完備)");
          if (hasDiaper)
            pros.push("おむつ交換台・ベビーシート設置");
          if (isOstomate) pros.push("オストメイト対応設備あり");
          if (isOpen24h) pros.push("24時間利用可能");
          if (isFree) pros.push("無料利用可能");

          const cons: string[] = [];
          if (hasWashlet === false)
            cons.push("ウォシュレット非対応");
          if (tags.wheelchair === "no")
            cons.push("車椅子非対応の構造");

          const rawContact = tags["contact:website"];
          const safeContact =
            typeof rawContact === "string" &&
            /^https?:\/\/[^\\"'\s]+$/i.test(rawContact.trim())
              ? rawContact.trim()
              : undefined;

          return {
            id: facilityId,
            name,
            facilityType: isTheTokyoToilet
              ? "THE TOKYO TOILET (渋谷区デザイン公衆トイレ)"
              : cleanTag(tags.operator)
              ? `${cleanTag(tags.operator)} 管理公衆便所`
              : "公衆便所 (OpenStreetMap実在登録)",
            category,
            dataSource: "osm" as const,
            lat: itemLat,
            lng: itemLng,
            address:
              cleanTag(tags["addr:full"]) ||
              cleanTag(tags["addr:street"]) ||
              "周辺道路・公園内",
            cleanlinessGrade: grade,
            cleanlinessScore: score,
            equipmentGrade: grade,
            equipmentScore: score,
            subScores: {
              cleanliness: score,
              odor: score,
              supplies: score,
              comfort: score,
            },
            attributes: osmAttributesFromTags(tags),
            openingHours: formatOsmOpeningHours(tags.opening_hours),
            description: `OpenStreetMap (${el.type} ID: ${el.id}) に登録されている実在の公衆トイレです。${
              cleanTag(tags.description)
            }`,
            reviewCount: 0,
            reviews: [],
            facilitySummary: isTheTokyoToilet
              ? "著名建築家が設計した渋谷区の最新デザイン公衆トイレ。設備充実。"
              : "OpenStreetMapに実在登録されている公衆トイレ。利用者の最新口コミ募集中。",
            facilityNote: isTheTokyoToilet
              ? "著名建築家が設計した渋谷区の最新デザイン公衆トイレ。設備充実。"
              : "OpenStreetMapに実在登録されている公衆トイレ。利用者の最新口コミ募集中。",
            pros,
            cons,
            tips: safeContact ? `公式情報: ${safeContact}` : undefined,
            officialOpenDataId: facilityId,
            estimateBasis: estimate.basis,
            googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${itemLat},${itemLng}`,
          };
        })
        .filter(
          (t) =>
            t &&
            typeof t.lat === "number" &&
            Number.isFinite(t.lat) &&
            typeof t.lng === "number" &&
            Number.isFinite(t.lng)
        );

      let truncated = false;
      if (rawElements.length > 500) {
        console.warn(
          `[osm-proxy] truncating rawElements ${rawElements.length} to 500`
        );
        rawElements = rawElements.slice(0, 500);
        truncated = true;
      }
      let limitedToilets = toilets;
      if (limitedToilets.length > 400) {
        console.warn(
          `[osm-proxy] truncating toilets ${limitedToilets.length} to 400`
        );
        limitedToilets = limitedToilets.slice(0, 400);
        truncated = true;
      }

      await communityRuntime.observeExternalFacilities(
        limitedToilets
          .map((t: any) => t?.id)
          .filter((id: unknown): id is string => typeof id === "string")
          .map((id: string) => ({
            id,
            source: "osm" as const,
            origin: "live-osm" as const,
          }))
      );

      const responsePayload = {
        elements: rawElements,
        toilets: limitedToilets,
        count: limitedToilets.length,
        source,
        truncated,
        timestamp: new Date().toISOString(),
      };

      if (upstreamSucceeded || limitedToilets.length > 0) {
        osmCacheSet(cacheKey, responsePayload);
      }
      res.json(responsePayload);
    } catch (err: any) {
      console.warn("[osm-proxy] API error:", err?.message ?? err);
      res.status(502).json({
        elements: [],
        toilets: [],
        count: 0,
        source: "error",
        // 内部エラー文言（上流URL・タイムアウト詳細等）は外部に露出させない（#109）
        error: "upstream unavailable",
        timestamp: new Date().toISOString(),
      });
    }
  });

  // express.json のパース失敗（SyntaxError / entity.too.large）は 400 系で返す。
  // 汎用500に落とすと監視・クライアント判定を誤らせる（#109）。
  app.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      next: NextFunction
    ) => {
      const rec: Record<string, unknown> =
        typeof err === "object" && err !== null
          ? (err as Record<string, unknown>)
          : {};
      const status = typeof rec.status === "number" ? rec.status : null;
      if (err instanceof SyntaxError && status !== null) {
        res.status(status >= 500 ? 400 : status).json({ error: "invalid JSON body" });
        return;
      }
      next(err);
    }
  );

  app.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      next: NextFunction
    ) => {
      console.error(
        "Unhandled request error:",
        err instanceof Error ? err.message : err
      );
      if (res.headersSent) {
        next(err);
        return;
      }
      res.status(500).json({ error: "internal server error" });
    }
  );

  // 未登録の /api/* は JSON 404 を返す（#109 レビュー）。
  // SPAフォールバック（HTML 200）に落ちるとAPIクライアントの res.ok 判定が
  // 崩れるため、静的配信より先に JSON で握りつぶす。
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});