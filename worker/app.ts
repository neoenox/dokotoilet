// Cloudflare Pages/Workers entry for the community API (#114).
//
// The Worker keeps the existing wire contract while replacing Express/JSON
// persistence with Hono + D1. Production bindings are intentionally not
// provisioned here; deployment/cutover remains a separate operational gate.

import { Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";

import { canonicalizeExternalFacilityId } from "../src/lib/facilityIds";
import { REAL_OSM_SEED } from "../src/data/realOsmSeed";
import { estimateEquipmentScore } from "../src/lib/estimate";
import {
  formatOsmOpeningHours,
  isTheTokyoToiletTags,
  osmAttributesFromTags,
  triFromFee,
  triFromOpen24h,
  triFromYesNo,
} from "../src/lib/osm";
import { isOsmElementType, osmFacilityId } from "../src/lib/osmIds";
import { sanitizeText } from "../src/lib/textPolicy";
import type { ToiletFacility } from "../src/types";
import {
  validateReportInput,
  validateReviewInput,
  validateToiletInput,
} from "../server/communityValidation";
import { D1CommunityRepository } from "./d1CommunityRepository";

interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface WorkerEnv {
  DB: D1Database;
  COMMUNITY_SALT: string;
  ADMIN_TOKEN?: string;
  API_RATE_LIMITER?: RateLimitBinding;
  WRITE_RATE_LIMITER?: RateLimitBinding;
  VOTE_RATE_LIMITER?: RateLimitBinding;
  OSM_CACHE?: KVNamespace;
}

type Variables = {
  store: D1CommunityRepository;
};

const app = new Hono<{ Bindings: WorkerEnv; Variables: Variables }>();

const encoder = new TextEncoder();

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function requestActor(request: Request, salt: string): Promise<string> {
  const actor =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "?";
  return sha256(`${salt}|${actor}`);
}

function safeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

async function readJson(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > 100 * 1024) {
    throw new RequestBodyError(413, "request too large");
  }
  try {
    return raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    throw new RequestBodyError(400, "invalid json");
  }
}

class RequestBodyError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string
  ) {
    super(message);
  }
}

async function allowed(
  binding: RateLimitBinding | undefined,
  key: string
): Promise<boolean> {
  if (!binding) return true;
  return (await binding.limit({ key })).success;
}

function externalId(raw: string): string {
  return canonicalizeExternalFacilityId(raw);
}

app.use("/api/*", async (c, next) => {
  if (
    !(await allowed(
      c.env.API_RATE_LIMITER,
      `${c.req.method}:${new URL(c.req.url).pathname}`
    ))
  ) {
    return c.json({ error: "too many requests" }, 429);
  }
  c.set("store", new D1CommunityRepository(c.env.DB));
  await next();
});

app.get("/api/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() })
);


function parseQueryNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+(\.\d+)?$/.test(value.trim())) return Number.NaN;
  return Number(value);
}

function withinRadius(
  originLat: number,
  originLng: number,
  lat: number,
  lng: number,
  radiusMeters: number
): boolean {
  const toRad = (degree: number) => (degree * Math.PI) / 180;
  const earthRadius = 6_371_000;
  const dLat = toRad(lat - originLat);
  const dLng = toRad(lng - originLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(originLat)) *
      Math.cos(toRad(lat)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(a)) <= radiusMeters;
}

function osmCacheKey(lat: number, lng: number, radius: number): string {
  return `osm:${lat.toFixed(4)}:${lng.toFixed(4)}:${Math.round(radius)}`;
}

function mapOsmElement(el: any) {
  const itemLat = el?.lat ?? el?.center?.lat;
  const itemLng = el?.lon ?? el?.center?.lon;
  if (
    !isOsmElementType(el?.type) ||
    typeof itemLat !== "number" ||
    !Number.isFinite(itemLat) ||
    typeof itemLng !== "number" ||
    !Number.isFinite(itemLng)
  ) {
    return null;
  }

  const tags = el.tags ?? {};
  const cleanTag = (value: unknown): string =>
    typeof value === "string" ? sanitizeText(value).trim() : "";
  const facilityId = osmFacilityId(el.type, el.id);
  let name = cleanTag(tags.name) || cleanTag(tags["name:ja"]);
  if (!name) {
    const operator = cleanTag(tags.operator);
    const description = cleanTag(tags.description);
    name = operator
      ? `${operator} 公衆トイレ`
      : description
        ? `公衆トイレ (${description})`
        : `公衆便所 (OSM #${el.id})`;
  } else if (!name.includes("トイレ") && !name.includes("便所")) {
    name = `${name} 公衆トイレ`;
  }

  const isTheTokyoToilet = isTheTokyoToiletTags(tags);
  const isWheelchair = tags.wheelchair === "yes";
  const hasDiaper = tags.diaper === "yes" || tags.changing_table === "yes";
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
    cleanTag(tags.operator).includes("JR") ||
    cleanTag(tags.operator).includes("メトロ") ||
    cleanTag(tags.operator).includes("地下鉄") ||
    tags.location === "underground" ||
    cleanTag(tags.description).includes("駅")
  ) {
    category = "station";
  }

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
      /squat/.test(tags["toilets:position"] ?? "") &&
      !/sit/.test(tags["toilets:position"] ?? "")
        ? "japanese"
        : null,
    isFree,
    isOpen24h,
    landmark: isTheTokyoToilet,
  });

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
    cleanlinessGrade: estimate.grade,
    cleanlinessScore: estimate.score,
    equipmentGrade: estimate.grade,
    equipmentScore: estimate.score,
    subScores: {
      cleanliness: estimate.score,
      odor: estimate.score,
      supplies: estimate.score,
      comfort: estimate.score,
    },
    attributes: osmAttributesFromTags(tags),
    openingHours: formatOsmOpeningHours(tags.opening_hours),
    description: `OpenStreetMap (${el.type} ID: ${el.id}) に登録されている実在の公衆トイレです。${cleanTag(tags.description)}`,
    reviewCount: 0,
    reviews: [],
    facilityNote: isTheTokyoToilet
      ? "著名建築家が設計した渋谷区のデザイン公衆トイレ。"
      : "OpenStreetMapに実在登録されている公衆トイレ。利用者の最新口コミ募集中。",
    officialOpenDataId: facilityId,
    estimateBasis: estimate.basis,
    googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${itemLat},${itemLng}`,
  };
}

app.get("/api/osm/toilets", async (c) => {
  const latValue = parseQueryNumber(c.req.query("lat"));
  const lngValue = parseQueryNumber(c.req.query("lng"));
  const radiusValue = parseQueryNumber(c.req.query("radius"));
  if (
    (latValue !== undefined && !(latValue >= -90 && latValue <= 90)) ||
    (lngValue !== undefined && !(lngValue >= -180 && lngValue <= 180)) ||
    (radiusValue !== undefined && !(radiusValue >= 1 && radiusValue <= 3000))
  ) {
    return c.json(
      {
        error:
          "invalid query parameter: lat (-90..90), lng (-180..180), radius (1..3000)",
      },
      400
    );
  }

  const lat = latValue ?? 35.659;
  const lng = lngValue ?? 139.7006;
  const radius = radiusValue ?? 1500;
  const key = osmCacheKey(lat, lng, radius);
  const cached = c.env.OSM_CACHE ? await c.env.OSM_CACHE.get(key, "json") : null;
  if (cached && typeof cached === "object") {
    const payload = cached as { toilets?: Array<{ id?: string }> };
    await c.get("store").registerExternalFacilities(
      (payload.toilets ?? [])
        .map((toilet) => toilet.id)
        .filter((id): id is string => typeof id === "string")
        .map((id) => ({ id, source: "osm" as const, origin: "live-osm" as const }))
    );
    return c.json(cached);
  }

  const liveRadius = Math.min(radius, 1200);
  const query = `[out:json][timeout:5];(node["amenity"="toilets"](around:${liveRadius},${lat},${lng});way["amenity"="toilets"](around:${liveRadius},${lat},${lng}););out center 80;`;
  const mirrors = [
    "https://lz4.overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
    "https://overpass-api.de/api/interpreter",
  ];

  let rawElements: any[] = [];
  let upstreamSucceeded = false;
  for (const mirror of mirrors) {
    try {
      const response = await fetch(mirror, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "kirei-toilet/1.0 (+https://github.com/neoenox/dokotoilet)",
        },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(3800),
      });
      if (!response.ok) continue;
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (contentLength > 8 * 1024 * 1024) continue;
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > 8 * 1024 * 1024) continue;
      const data = JSON.parse(text) as { elements?: unknown };
      if (!Array.isArray(data.elements)) continue;
      rawElements = data.elements;
      upstreamSucceeded = true;
      break;
    } catch {
      // Try the next mirror. No upstream error details are exposed to clients.
    }
  }

  let source: "overpass" | "seed" | "none" = upstreamSucceeded
    ? "overpass"
    : "none";
  if (!upstreamSucceeded) {
    rawElements = REAL_OSM_SEED.filter((element: any) => {
      const itemLat = element.lat ?? element.center?.lat;
      const itemLng = element.lon ?? element.center?.lon;
      return (
        typeof itemLat === "number" &&
        typeof itemLng === "number" &&
        withinRadius(lat, lng, itemLat, itemLng, radius)
      );
    });
    if (rawElements.length > 0) source = "seed";
  }

  const toilets = rawElements
    .slice(0, 500)
    .map(mapOsmElement)
    .filter((toilet): toilet is NonNullable<ReturnType<typeof mapOsmElement>> =>
      toilet !== null
    )
    .slice(0, 400);

  await c.get("store").registerExternalFacilities(
    toilets.map((toilet) => ({
      id: toilet.id,
      source: "osm" as const,
      origin: "live-osm" as const,
    }))
  );

  const payload = {
    elements: rawElements.slice(0, 500),
    toilets,
    count: toilets.length,
    source,
    truncated: rawElements.length > 500 || toilets.length > 400,
    timestamp: new Date().toISOString(),
  };
  if (c.env.OSM_CACHE && (upstreamSucceeded || toilets.length > 0)) {
    await c.env.OSM_CACHE.put(key, JSON.stringify(payload), {
      expirationTtl: 15 * 60,
    });
  }
  return c.json(payload);
});

app.get("/api/community/toilets", async (c) => {
  const store = c.get("store");
  return c.json({
    toilets: await store.getToilets(),
    externalReviews: await store.getExternalReviews(),
  });
});

app.post("/api/community/toilets", async (c) => {
  const actor = await requestActor(c.req.raw, c.env.COMMUNITY_SALT);
  if (!(await allowed(c.env.WRITE_RATE_LIMITER, `toilet:${actor}`))) {
    return c.json({ error: "too many requests" }, 429);
  }
  const validated = validateToiletInput(await readJson(c.req.raw));
  if (!validated.ok || !validated.value) {
    return c.json({ error: validated.error }, 400);
  }
  const value = validated.value;
  const toilet: ToiletFacility = {
    id: value.id,
    name: value.name,
    facilityType:
      value.category === "department"
        ? "商業施設・デパート"
        : value.category === "station"
          ? "駅・交通施設"
          : value.category === "convenience"
            ? "コンビニ"
            : value.category === "park"
              ? "公衆トイレ"
              : "その他施設",
    category: value.category,
    dataSource: "community",
    lat: value.lat,
    lng: value.lng,
    address: value.address,
    floorInfo: value.floorInfo,
    cleanlinessGrade: null,
    cleanlinessScore: null,
    equipmentGrade: null,
    equipmentScore: null,
    subScores: {
      cleanliness: null,
      odor: null,
      supplies: null,
      comfort: null,
    },
    attributes: {
      hasWashlet: value.attributes.hasWashlet,
      hasMultipurpose: value.attributes.hasMultipurpose,
      hasBabyTable: value.attributes.hasBabyTable,
      hasNursingRoom: null,
      hasPowderRoom: value.attributes.hasPowderRoom,
      hasOstomate: null,
      isFree: null,
      isOpen24h: value.attributes.isOpen24h,
      hasSoap: null,
      hasAlcohol: null,
      hasPaperTowelOrDryer: null,
      toiletStyle: null,
    },
    openingHours:
      value.attributes.isOpen24h === true
        ? "24時間営業"
        : value.attributes.isOpen24h === false
          ? "施設営業時間に準ずる"
          : "営業時間未確認",
    description: value.description,
    reviewCount: 0,
    reviews: [],
    facilityNote: "ユーザー報告に基づく新規登録トイレ情報。",
  };
  const { added } = await c.get("store").addToilet(toilet);
  if (!added) return c.json({ error: "duplicate id" }, 409);
  return c.json({ toilet }, 201);
});

app.post("/api/community/toilets/:id/reviews", async (c) => {
  const actor = await requestActor(c.req.raw, c.env.COMMUNITY_SALT);
  if (!(await allowed(c.env.WRITE_RATE_LIMITER, `review:${actor}`))) {
    return c.json({ error: "too many requests" }, 429);
  }
  const validated = validateReviewInput(await readJson(c.req.raw));
  if (!validated.ok || !validated.value) {
    return c.json({ error: validated.error }, 400);
  }
  const facilityId = externalId(c.req.param("id"));
  const result = await c
    .get("store")
    .addReview(facilityId, validated.value, actor);
  if (result.error === "not_found") {
    return c.json({ error: "toilet not found" }, 404);
  }
  if (result.error === "duplicate") {
    return c.json({ error: "duplicate review" }, 409);
  }
  if (result.toilet) return c.json({ toilet: result.toilet }, 201);
  return c.json(
    {
      facilityId: result.facilityId,
      reviewCount: result.reviewCount,
      cleanlinessScore: result.cleanlinessScore,
      cleanlinessGrade: result.cleanlinessGrade,
      reviews: result.reviews,
    },
    201
  );
});

app.post("/api/community/reviews/:reviewId/helpful", async (c) => {
  const actor = await requestActor(c.req.raw, c.env.COMMUNITY_SALT);
  if (!(await allowed(c.env.VOTE_RATE_LIMITER, `vote:${actor}`))) {
    return c.json({ error: "too many requests" }, 429);
  }
  const result = await c
    .get("store")
    .voteHelpful(c.req.param("reviewId"), actor);
  if (!result.found) return c.json({ error: "review not found" }, 404);
  return c.json({
    helpfulCount: result.helpfulCount,
    voted: result.voted,
  });
});

app.post("/api/community/reviews/:reviewId/report", async (c) => {
  const actor = await requestActor(c.req.raw, c.env.COMMUNITY_SALT);
  if (!(await allowed(c.env.WRITE_RATE_LIMITER, `report:${actor}`))) {
    return c.json({ error: "too many requests" }, 429);
  }
  const body = await readJson(c.req.raw);
  const validated = validateReportInput(body);
  if (!validated.ok || !validated.value) {
    return c.json({ error: validated.error }, 400);
  }
  const toiletId =
    body && typeof body === "object" && "toiletId" in body
      ? (body as { toiletId?: unknown }).toiletId
      : undefined;
  if (typeof toiletId !== "string") {
    return c.json({ error: "toiletId required" }, 400);
  }
  const result = await c
    .get("store")
    .addReport(
      externalId(toiletId),
      c.req.param("reviewId"),
      validated.value.reason
    );
  if (!result.found) return c.json({ error: "review not found" }, 404);
  if (result.duplicate) return c.json({ error: "duplicate report" }, 409);
  return c.json({ ok: true }, 201);
});

async function requireAdmin(c: any) {
  const expected = c.env.ADMIN_TOKEN?.trim();
  if (!expected) return c.json({ error: "not found" }, 404);
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }
  if (!safeEqual(header.slice(7), expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return null;
}

app.get("/api/community/admin/reports", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const statusRaw = c.req.query("status");
  const status =
    statusRaw === "open" || statusRaw === "resolved" ? statusRaw : "all";
  const limit = Number(c.req.query("limit") ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);
  const store = c.get("store");
  const reports = await store.listReports({ status, limit, offset });
  const names = new Map((await store.getToilets()).map((t) => [t.id, t.name]));
  return c.json({
    reports: reports.map((report) => ({
      ...report,
      facilityName: names.get(report.toiletId),
    })),
  });
});

app.post("/api/community/admin/reports/:id/resolve", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const actor = await requestActor(c.req.raw, c.env.COMMUNITY_SALT);
  if (!(await allowed(c.env.WRITE_RATE_LIMITER, `admin:${actor}`))) {
    return c.json({ error: "too many requests" }, 429);
  }
  const body = (await readJson(c.req.raw)) as {
    note?: unknown;
    adminNote?: unknown;
  };
  const note =
    typeof body.note === "string"
      ? body.note
      : typeof body.adminNote === "string"
        ? body.adminNote
        : undefined;
  const result = await c.get("store").resolveReport(c.req.param("id"), note);
  if (!result.found) return c.json({ error: "report not found" }, 404);
  return c.json({ ok: true, report: result.report });
});

app.delete("/api/community/admin/reviews/:reviewId", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const actor = await requestActor(c.req.raw, c.env.COMMUNITY_SALT);
  if (!(await allowed(c.env.WRITE_RATE_LIMITER, `admin:${actor}`))) {
    return c.json({ error: "too many requests" }, 429);
  }
  const body = (await readJson(c.req.raw)) as { reason?: unknown };
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  const result = await c
    .get("store")
    .deleteReview(c.req.param("reviewId"), reason);
  if (!result.found) return c.json({ error: "review not found" }, 404);
  return c.json({ ok: true, ...result });
});

app.onError((error, c) => {
  console.error("[worker] request failed", error);
  if (error instanceof RequestBodyError) {
    return c.json({ error: error.message }, error.status);
  }
  return c.json({ error: "internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "not found" }, 404));

export default app;
