import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { CommunityDB, ReviewKey, StoredReport } from "../../server/community";
import { assertCommunitySnapshotValid } from "../../server/communitySnapshot";
import type { ToiletFacility, ToiletReview } from "../../src/types";

const DAY_MS = 24 * 60 * 60 * 1000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sql(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite SQL number: ${String(value)}`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizeText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceForExternalId(id: string): "osm" | "google" | "od" {
  if (id.startsWith("osm-")) return "osm";
  if (id.startsWith("google-")) return "google";
  if (id.startsWith("od-")) return "od";
  throw new Error(`unsupported external facility id: ${id}`);
}

function reviewScores(review: ToiletReview) {
  const overall = Number(review.overallScore ?? review.rating);
  const cleanliness = Number(review.cleanlinessScore);
  const odor = Number(review.odorScore);
  const supplies = Number(review.suppliesScore);
  for (const [name, value] of Object.entries({ overall, cleanliness, odor, supplies })) {
    if (!Number.isFinite(value)) throw new Error(`invalid ${name} score on ${review.id}`);
  }
  return { overall, cleanliness, odor, supplies };
}

type ReviewLocation = {
  review: ToiletReview & { ipHash?: string };
  facilityId: string;
  kind: "community" | "external";
};

function collectReviews(db: CommunityDB): ReviewLocation[] {
  const out: ReviewLocation[] = [];
  for (const toilet of db.toilets) {
    for (const review of toilet.reviews ?? []) {
      out.push({ review, facilityId: toilet.id, kind: "community" });
    }
  }
  for (const [facilityId, reviews] of Object.entries(db.externalReviews ?? {})) {
    for (const review of reviews ?? []) {
      out.push({ review, facilityId, kind: "external" });
    }
  }
  return out;
}

function facilityBase(toilet: ToiletFacility): ToiletFacility {
  return {
    ...toilet,
    dataSource: "community",
    reviews: [],
    reviewCount: 0,
    overallScore: undefined,
    cleanlinessScore: toilet.equipmentScore ?? toilet.cleanlinessScore ?? null,
    cleanlinessGrade: toilet.equipmentGrade ?? toilet.cleanlinessGrade ?? null,
  };
}

function aggregateSql(reviews: ReviewLocation[]): string[] {
  const grouped = new Map<string, { count: number; overall: number; cleanliness: number; odor: number; supplies: number }>();
  for (const item of reviews) {
    const score = reviewScores(item.review);
    const current = grouped.get(item.facilityId) ?? { count: 0, overall: 0, cleanliness: 0, odor: 0, supplies: 0 };
    current.count += 1;
    current.overall += score.overall;
    current.cleanliness += score.cleanliness;
    current.odor += score.odor;
    current.supplies += score.supplies;
    grouped.set(item.facilityId, current);
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([facilityId, a]) =>
    `INSERT OR ABORT INTO facility_aggregates (facility_id, review_count, overall_sum, cleanliness_sum, odor_sum, supplies_sum) VALUES (${sql(facilityId)}, ${a.count}, ${a.overall}, ${a.cleanliness}, ${a.odor}, ${a.supplies});`
  );
}

function reportSql(report: StoredReport): string {
  const status = report.status === "resolved" ? "resolved" : "open";
  return `INSERT OR ABORT INTO reports (report_id, facility_id, review_id, reason, reason_norm, status, created_at, resolved_at, resolution, admin_note) VALUES (${[
    sql(report.id),
    sql(report.toiletId),
    sql(report.reviewId),
    sql(report.reason),
    sql(normalizeText(report.reason)),
    sql(status),
    sql(report.createdAt),
    sql(report.resolvedAt),
    sql(report.resolution),
    sql(report.adminNote),
  ].join(", ")});`;
}

function activeDedupSql(
  reviewLocation: Map<string, ReviewLocation>,
  reviewKeys: Record<string, ReviewKey>,
  capturedAt: string
): string[] {
  const now = Date.parse(capturedAt);
  if (!Number.isFinite(now)) throw new Error(`invalid capturedAt: ${capturedAt}`);
  const lines: string[] = [];
  for (const [reviewId, key] of Object.entries(reviewKeys).sort(([a], [b]) => a.localeCompare(b))) {
    const item = reviewLocation.get(reviewId);
    if (!item || !key || typeof key.ipHash !== "string" || !Number.isFinite(key.at)) continue;
    const validUntilMs = key.at + DAY_MS;
    if (validUntilMs <= now) continue;
    const normalized = normalizeText(item.review.comment);
    const commentHash = sha256(normalized);
    const dedupKey = sha256(`${item.facilityId}|${key.ipHash}|${normalized}`);
    lines.push(
      `INSERT OR ABORT INTO review_dedup (dedup_key, facility_id, review_id, comment_hash, valid_until) VALUES (${sql(dedupKey)}, ${sql(item.facilityId)}, ${sql(reviewId)}, ${sql(commentHash)}, ${sql(new Date(validUntilMs).toISOString())});`
    );
  }
  return lines;
}

export function buildD1MigrationSql(db: CommunityDB, capturedAt = new Date().toISOString()): string {
  const analysis = assertCommunitySnapshotValid(db);
  const reviews = collectReviews(db);
  const byReviewId = new Map(reviews.map((item) => [item.review.id, item]));
  const lines: string[] = [
    "-- Generated by scripts/community-migrate/d1-sql.ts",
    `-- source_digest=${analysis.digest}`,
    `-- captured_at=${capturedAt}`,
    "-- Apply only to an empty/staging D1 database after worker/schema.sql.",
    "PRAGMA foreign_keys = ON;",
    "BEGIN IMMEDIATE;",
  ];

  for (const toilet of [...db.toilets].sort((a, b) => a.id.localeCompare(b.id))) {
    const base = facilityBase(toilet);
    lines.push(
      `INSERT OR ABORT INTO community_toilets (facility_id, name, category, lat, lng, address, floor_info, description, data_json, created_at) VALUES (${[
        sql(base.id), sql(base.name), sql(base.category), sql(base.lat), sql(base.lng),
        sql(base.address), sql(base.floorInfo), sql(base.description), sql(JSON.stringify(base)), sql(capturedAt),
      ].join(", ")});`
    );
  }

  for (const facilityId of Object.keys(db.externalReviews ?? {}).sort()) {
    lines.push(
      `INSERT OR ABORT INTO external_facilities (facility_id, source, origin, legacy_id, first_seen_at) VALUES (${sql(facilityId)}, ${sql(sourceForExternalId(facilityId))}, 'migration', NULL, ${sql(capturedAt)});`
    );
  }

  for (const item of reviews.sort((a, b) => a.review.id.localeCompare(b.review.id))) {
    const score = reviewScores(item.review);
    const ipHash = typeof item.review.ipHash === "string" ? item.review.ipHash : (db.reviewKeys[item.review.id]?.ipHash ?? "");
    lines.push(
      `INSERT OR ABORT INTO reviews (review_id, facility_id, facility_kind, user_name, overall_score, cleanliness_score, odor_score, supplies_score, comment, comment_hash, ip_hash, helpful_count, created_at, deleted) VALUES (${[
        sql(item.review.id), sql(item.facilityId), sql(item.kind), sql(item.review.userName),
        sql(score.overall), sql(score.cleanliness), sql(score.odor), sql(score.supplies),
        sql(item.review.comment), sql(sha256(normalizeText(item.review.comment))), sql(ipHash),
        sql(item.review.helpfulCount ?? 0), sql(item.review.createdAt), "0",
      ].join(", ")});`
    );
  }

  lines.push(...aggregateSql(reviews));

  for (const [reviewId, voters] of Object.entries(db.helpfulVotes ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    for (const ipHash of [...voters].sort()) {
      lines.push(
        `INSERT OR ABORT INTO helpful_votes (vote_key, review_id, ip_hash, created_at) VALUES (${sql(sha256(`${reviewId}|${ipHash}`))}, ${sql(reviewId)}, ${sql(ipHash)}, ${sql(capturedAt)});`
      );
    }
  }

  for (const report of [...(db.reports ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(reportSql(report));
  }
  lines.push(...activeDedupSql(byReviewId, db.reviewKeys ?? {}, capturedAt));
  lines.push("COMMIT;", "");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const input = path.resolve(arg("--in") ?? process.env.COMMUNITY_STORE_PATH ?? "data/community.json");
  const output = path.resolve(arg("--out") ?? "tmp/community-d1-import.sql");
  const capturedAt = arg("--captured-at") ?? new Date().toISOString();
  const raw = await readFile(input, "utf-8");
  const db = JSON.parse(raw) as CommunityDB;
  const text = buildD1MigrationSql(db, capturedAt);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, text, "utf-8");
  const analysis = assertCommunitySnapshotValid(db);
  process.stdout.write(
    `D1 migration SQL generated: ${output}\nsource_digest=${analysis.digest}\nfacilities=${analysis.counts.toilets} community_reviews=${analysis.counts.communityReviews} external_reviews=${analysis.counts.externalReviews} reports=${analysis.counts.reports} votes=${analysis.counts.helpfulVotes}\n`
  );
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    process.stderr.write(`D1 migration generation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
