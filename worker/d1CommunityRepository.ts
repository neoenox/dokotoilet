import type { D1Database } from "@cloudflare/workers-types";

import { canonicalizeExternalFacilityId } from "../src/lib/facilityIds";
import { summarizeReviews } from "../src/lib/scoring";
import type { ToiletFacility, ToiletReview } from "../src/types";
import type {
  AddReviewResult,
  CommunityRepository,
  DeleteReviewResult,
  ExternalFacilityObservation,
  ListReportsOptions,
  ResolveReportResult,
} from "../server/communityRepository";
import type { StoredReport } from "../server/community";
import type { ReviewInput } from "../server/communityValidation";

type ReviewRow = {
  review_id: string;
  facility_id: string;
  facility_kind: "community" | "external";
  user_name: string;
  overall_score: number | null;
  cleanliness_score: number;
  odor_score: number;
  supplies_score: number;
  comment: string;
  helpful_count: number;
  created_at: string;
};

type ReportRow = {
  report_id: string;
  facility_id: string;
  review_id: string;
  reason: string;
  status: "open" | "resolved";
  created_at: string;
  resolved_at: string | null;
  resolution: string | null;
  admin_note: string | null;
};

const EXTERNAL_ID_RE = /^(osm|google|od)-(?:[\p{L}\p{N}_-]){1,80}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeDedupText(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function rowToReview(row: ReviewRow): ToiletReview {
  return {
    id: row.review_id,
    userName: row.user_name,
    rating: row.overall_score ?? row.cleanliness_score,
    ...(row.overall_score === null ? {} : { overallScore: row.overall_score }),
    cleanlinessScore: row.cleanliness_score,
    odorScore: row.odor_score,
    suppliesScore: row.supplies_score,
    comment: row.comment,
    createdAt: row.created_at,
    helpfulCount: row.helpful_count,
  };
}

function publicFacility(base: ToiletFacility, reviews: ToiletReview[]): ToiletFacility {
  const summary = summarizeReviews(reviews);
  return {
    ...base,
    reviews,
    reviewCount: reviews.length,
    cleanlinessScore: summary?.cleanlinessScore ?? base.equipmentScore,
    cleanlinessGrade: summary?.cleanlinessGrade ?? base.equipmentGrade,
    ...(summary ? { overallScore: summary.overallScore } : { overallScore: undefined }),
    ...(reviews.length > 0 ? { lastCleaned: "たった今（利用者が確認）" } : {}),
  };
}

function toStoredReport(row: ReportRow): StoredReport {
  const at = Date.parse(row.created_at);
  return {
    id: row.report_id,
    toiletId: row.facility_id,
    reviewId: row.review_id,
    reason: row.reason,
    createdAt: row.created_at,
    at: Number.isFinite(at) ? at : 0,
    status: row.status,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    ...(row.resolution ? { resolution: row.resolution } : {}),
    ...(row.admin_note ? { adminNote: row.admin_note } : {}),
  };
}

/**
 * D1 implementation of the existing CommunityRepository contract.
 *
 * Mutations that need more than one SQL statement use D1 batch(), which D1
 * executes as a transaction. Dedup/vote rows carry the newly-created object
 * id/timestamp so later statements in the same batch only apply for the
 * winning insert.
 */
export class D1CommunityRepository implements CommunityRepository {
  constructor(private readonly db: D1Database) {}

  private async allReviewRows(
    whereSql = "",
    binds: unknown[] = []
  ): Promise<ReviewRow[]> {
    const stmt = this.db.prepare(
      `SELECT review_id, facility_id, facility_kind, user_name,
              overall_score, cleanliness_score, odor_score, supplies_score,
              comment, helpful_count, created_at
         FROM reviews
        WHERE deleted = 0 ${whereSql}
        ORDER BY created_at DESC, review_id DESC`
    );
    const result = await stmt.bind(...binds).all<ReviewRow>();
    return result.results;
  }

  private async reviewsFor(facilityId: string): Promise<ToiletReview[]> {
    const rows = await this.allReviewRows("AND facility_id = ?", [facilityId]);
    return rows.map(rowToReview);
  }

  async getToilets(): Promise<ToiletFacility[]> {
    const facilities = await this.db
      .prepare(
        `SELECT facility_id, data_json
           FROM community_toilets
          ORDER BY created_at DESC, facility_id DESC`
      )
      .all<{ facility_id: string; data_json: string }>();
    const reviewRows = await this.allReviewRows("AND facility_kind = 'community'");
    const grouped = new Map<string, ToiletReview[]>();
    for (const row of reviewRows) {
      const list = grouped.get(row.facility_id) ?? [];
      list.push(rowToReview(row));
      grouped.set(row.facility_id, list);
    }
    return facilities.results.flatMap((row) => {
      try {
        const base = JSON.parse(row.data_json) as ToiletFacility;
        return [publicFacility(base, grouped.get(row.facility_id) ?? [])];
      } catch {
        return [];
      }
    });
  }

  async getExternalReviews(): Promise<Record<string, ToiletReview[]>> {
    const rows = await this.allReviewRows("AND facility_kind = 'external'");
    const result: Record<string, ToiletReview[]> = {};
    for (const row of rows) {
      (result[row.facility_id] ??= []).push(rowToReview(row));
    }
    return result;
  }

  async addToilet(toilet: ToiletFacility): Promise<{ added: boolean }> {
    const now = new Date().toISOString();
    const base: ToiletFacility = {
      ...toilet,
      dataSource: "community",
      reviews: [],
      reviewCount: 0,
      cleanlinessScore: toilet.equipmentScore ?? toilet.cleanlinessScore ?? null,
      cleanlinessGrade: toilet.equipmentGrade ?? toilet.cleanlinessGrade ?? null,
      overallScore: undefined,
    };
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO community_toilets
          (facility_id, name, category, lat, lng, address, floor_info,
           description, data_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        base.id,
        base.name,
        base.category,
        base.lat,
        base.lng,
        base.address,
        base.floorInfo ?? null,
        base.description,
        JSON.stringify(base),
        now
      )
      .run();
    return { added: Number(result.meta.changes ?? 0) > 0 };
  }

  private async facilityKind(
    rawFacilityId: string
  ): Promise<{ id: string; kind: "community" | "external" } | null> {
    const facilityId = canonicalizeExternalFacilityId(rawFacilityId);
    const community = await this.db
      .prepare("SELECT 1 AS found FROM community_toilets WHERE facility_id = ?")
      .bind(facilityId)
      .first<{ found: number }>();
    if (community) return { id: facilityId, kind: "community" };

    if (!EXTERNAL_ID_RE.test(facilityId)) return null;
    const external = await this.db
      .prepare("SELECT 1 AS found FROM external_facilities WHERE facility_id = ?")
      .bind(facilityId)
      .first<{ found: number }>();
    return external ? { id: facilityId, kind: "external" } : null;
  }

  async addReview(
    rawFacilityId: string,
    input: ReviewInput,
    ipHash: string
  ): Promise<AddReviewResult> {
    const facility = await this.facilityKind(rawFacilityId);
    if (!facility) return { error: "not_found" };

    const reviewId = `rev-${crypto.randomUUID()}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const validUntil = new Date(now.getTime() + DAY_MS).toISOString();
    const normalized = normalizeDedupText(input.comment);
    const commentHash = await sha256(normalized);
    const dedupKey = await sha256(
      `${facility.id}|${ipHash}|${normalized}`
    );

    const results = await this.db.batch([
      this.db
        .prepare("DELETE FROM review_dedup WHERE valid_until <= ?")
        .bind(nowIso),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO review_dedup
            (dedup_key, facility_id, review_id, comment_hash, valid_until)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(dedupKey, facility.id, reviewId, commentHash, validUntil),
      this.db
        .prepare(
          `INSERT INTO reviews
            (review_id, facility_id, facility_kind, user_name, overall_score,
             cleanliness_score, odor_score, supplies_score, comment,
             comment_hash, ip_hash, helpful_count, created_at, deleted)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0
            WHERE EXISTS (
              SELECT 1 FROM review_dedup
               WHERE dedup_key = ? AND review_id = ?
            )`
        )
        .bind(
          reviewId,
          facility.id,
          facility.kind,
          input.userName,
          input.overallScore,
          input.cleanlinessScore,
          input.odorScore,
          input.suppliesScore,
          input.comment,
          commentHash,
          ipHash,
          nowIso.split("T")[0],
          dedupKey,
          reviewId
        ),
      this.db
        .prepare(
          `INSERT INTO facility_aggregates
            (facility_id, review_count, overall_sum, cleanliness_sum,
             odor_sum, supplies_sum)
           SELECT ?, 1, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM reviews WHERE review_id = ?)
           ON CONFLICT(facility_id) DO UPDATE SET
             review_count = review_count + 1,
             overall_sum = overall_sum + excluded.overall_sum,
             cleanliness_sum = cleanliness_sum + excluded.cleanliness_sum,
             odor_sum = odor_sum + excluded.odor_sum,
             supplies_sum = supplies_sum + excluded.supplies_sum`
        )
        .bind(
          facility.id,
          input.overallScore,
          input.cleanlinessScore,
          input.odorScore,
          input.suppliesScore,
          reviewId
        ),
    ]);

    if (Number(results[1]?.meta.changes ?? 0) === 0) {
      return { error: "duplicate" };
    }

    const reviews = await this.reviewsFor(facility.id);
    const summary = summarizeReviews(reviews);
    if (facility.kind === "external") {
      return {
        facilityId: facility.id,
        reviews,
        reviewCount: reviews.length,
        cleanlinessScore: summary?.cleanlinessScore,
        cleanlinessGrade: summary?.cleanlinessGrade,
        overallScore: summary?.overallScore,
      };
    }
    const toilet = (await this.getToilets()).find((item) => item.id === facility.id);
    return toilet ? { toilet } : { error: "not_found" };
  }

  async voteHelpful(
    reviewId: string,
    ipHash: string
  ): Promise<{ helpfulCount: number; voted: boolean; found: boolean }> {
    const existing = await this.db
      .prepare(
        "SELECT helpful_count FROM reviews WHERE review_id = ? AND deleted = 0"
      )
      .bind(reviewId)
      .first<{ helpful_count: number }>();
    if (!existing) return { helpfulCount: 0, voted: false, found: false };

    const voteKey = await sha256(`${reviewId}|${ipHash}`);
    const now = new Date().toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO helpful_votes
            (vote_key, review_id, ip_hash, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .bind(voteKey, reviewId, ipHash, now),
      this.db
        .prepare(
          `UPDATE reviews
              SET helpful_count = helpful_count + 1
            WHERE review_id = ? AND deleted = 0
              AND EXISTS (
                SELECT 1 FROM helpful_votes
                 WHERE vote_key = ? AND created_at = ?
              )`
        )
        .bind(reviewId, voteKey, now),
    ]);
    const voted = Number(results[0]?.meta.changes ?? 0) > 0;
    const current = await this.db
      .prepare(
        "SELECT helpful_count FROM reviews WHERE review_id = ? AND deleted = 0"
      )
      .bind(reviewId)
      .first<{ helpful_count: number }>();
    return {
      helpfulCount: current?.helpful_count ?? existing.helpful_count,
      voted,
      found: true,
    };
  }

  async addReport(
    rawFacilityId: string,
    reviewId: string,
    reason: string
  ): Promise<{ ok: boolean; found: boolean; duplicate?: boolean }> {
    const facilityId = canonicalizeExternalFacilityId(rawFacilityId);
    const review = await this.db
      .prepare(
        `SELECT 1 AS found FROM reviews
          WHERE review_id = ? AND facility_id = ? AND deleted = 0`
      )
      .bind(reviewId, facilityId)
      .first<{ found: number }>();
    if (!review) return { ok: false, found: false };

    const now = new Date();
    const nowIso = now.toISOString();
    const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
    const reasonNorm = normalizeDedupText(reason);
    const reportId = `report-${crypto.randomUUID()}`;
    const result = await this.db
      .prepare(
        `INSERT INTO reports
          (report_id, facility_id, review_id, reason, reason_norm, status, created_at)
         SELECT ?, ?, ?, ?, ?, 'open', ?
          WHERE NOT EXISTS (
            SELECT 1 FROM reports
             WHERE review_id = ?
               AND reason_norm = ?
               AND status = 'open'
               AND created_at >= ?
          )`
      )
      .bind(
        reportId,
        facilityId,
        reviewId,
        reason,
        reasonNorm,
        nowIso,
        reviewId,
        reasonNorm,
        cutoff
      )
      .run();
    if (Number(result.meta.changes ?? 0) === 0) {
      return { ok: false, found: true, duplicate: true };
    }
    return { ok: true, found: true };
  }

  async listReports(opts: ListReportsOptions = {}): Promise<StoredReport[]> {
    const status = opts.status ?? "all";
    const limit = Math.max(0, Math.min(100, Math.floor(Number(opts.limit ?? 50))));
    const offset = Math.max(0, Math.floor(Number(opts.offset ?? 0)));
    const where = status === "open" || status === "resolved"
      ? "WHERE status = ?"
      : "";
    const statement = this.db.prepare(
      `SELECT report_id, facility_id, review_id, reason, status, created_at,
              resolved_at, resolution, admin_note
         FROM reports
         ${where}
        ORDER BY created_at DESC, report_id DESC
        LIMIT ? OFFSET ?`
    );
    const query =
      where.length > 0
        ? statement.bind(status, limit, offset)
        : statement.bind(limit, offset);
    const result = await query.all<ReportRow>();
    return result.results.map(toStoredReport);
  }

  async resolveReport(
    reportId: string,
    note?: string
  ): Promise<ResolveReportResult> {
    const now = new Date().toISOString();
    const resolution =
      typeof note === "string" && note.trim()
        ? note.trim().slice(0, 500)
        : null;
    const result = await this.db
      .prepare(
        `UPDATE reports
            SET status = 'resolved',
                resolved_at = ?,
                resolution = COALESCE(?, resolution),
                admin_note = COALESCE(?, admin_note)
          WHERE report_id = ?`
      )
      .bind(now, resolution, resolution, reportId)
      .run();
    if (Number(result.meta.changes ?? 0) === 0) return { found: false };
    const row = await this.db
      .prepare(
        `SELECT report_id, facility_id, review_id, reason, status, created_at,
                resolved_at, resolution, admin_note
           FROM reports WHERE report_id = ?`
      )
      .bind(reportId)
      .first<ReportRow>();
    return row ? { found: true, report: toStoredReport(row) } : { found: false };
  }

  private async refreshAggregate(facilityId: string): Promise<number> {
    const aggregate = await this.db
      .prepare(
        `SELECT COUNT(*) AS review_count,
                COALESCE(SUM(overall_score), 0) AS overall_sum,
                COALESCE(SUM(cleanliness_score), 0) AS cleanliness_sum,
                COALESCE(SUM(odor_score), 0) AS odor_sum,
                COALESCE(SUM(supplies_score), 0) AS supplies_sum
           FROM reviews
          WHERE facility_id = ? AND deleted = 0`
      )
      .bind(facilityId)
      .first<{
        review_count: number;
        overall_sum: number;
        cleanliness_sum: number;
        odor_sum: number;
        supplies_sum: number;
      }>();
    const count = Number(aggregate?.review_count ?? 0);
    await this.db
      .prepare(
        `INSERT INTO facility_aggregates
          (facility_id, review_count, overall_sum, cleanliness_sum, odor_sum, supplies_sum)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(facility_id) DO UPDATE SET
           review_count = excluded.review_count,
           overall_sum = excluded.overall_sum,
           cleanliness_sum = excluded.cleanliness_sum,
           odor_sum = excluded.odor_sum,
           supplies_sum = excluded.supplies_sum`
      )
      .bind(
        facilityId,
        count,
        Number(aggregate?.overall_sum ?? 0),
        Number(aggregate?.cleanliness_sum ?? 0),
        Number(aggregate?.odor_sum ?? 0),
        Number(aggregate?.supplies_sum ?? 0)
      )
      .run();
    return count;
  }

  async deleteReview(
    reviewId: string,
    reason?: string
  ): Promise<DeleteReviewResult> {
    const row = await this.db
      .prepare(
        `SELECT facility_id, facility_kind
           FROM reviews
          WHERE review_id = ? AND deleted = 0`
      )
      .bind(reviewId)
      .first<{ facility_id: string; facility_kind: "community" | "external" }>();
    if (!row) return { found: false };

    const now = new Date().toISOString();
    const resolution =
      typeof reason === "string" && reason.trim()
        ? reason.trim().slice(0, 500)
        : "admin delete";
    await this.db.batch([
      this.db
        .prepare("UPDATE reviews SET deleted = 1 WHERE review_id = ?")
        .bind(reviewId),
      this.db
        .prepare("DELETE FROM review_dedup WHERE review_id = ?")
        .bind(reviewId),
      this.db
        .prepare("DELETE FROM helpful_votes WHERE review_id = ?")
        .bind(reviewId),
      this.db
        .prepare(
          `UPDATE reports
              SET status = 'resolved', resolved_at = ?,
                  resolution = ?, admin_note = COALESCE(admin_note, ?)
            WHERE review_id = ? AND status != 'resolved'`
        )
        .bind(now, resolution, resolution, reviewId),
    ]);
    const reviewCount = await this.refreshAggregate(row.facility_id);
    return {
      found: true,
      facilityId: row.facility_id,
      kind: row.facility_kind,
      reviewCount,
    };
  }

  async registerExternalFacilities(
    facilities: ExternalFacilityObservation[]
  ): Promise<void> {
    const now = new Date().toISOString();
    const statements = facilities.flatMap((facility) => {
      const facilityId = canonicalizeExternalFacilityId(facility.id);
      if (!EXTERNAL_ID_RE.test(facilityId)) return [];
      return [
        this.db
          .prepare(
            `INSERT INTO external_facilities
              (facility_id, source, origin, legacy_id, first_seen_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(facility_id) DO UPDATE SET
               source = excluded.source,
               origin = excluded.origin,
               legacy_id = COALESCE(excluded.legacy_id, legacy_id)`
          )
          .bind(
            facilityId,
            facility.source,
            facility.origin,
            facility.legacyId ?? null,
            now
          ),
      ];
    });
    if (statements.length > 0) await this.db.batch(statements);
  }

  async isKnownExternalFacility(rawFacilityId: string): Promise<boolean> {
    const facilityId = canonicalizeExternalFacilityId(rawFacilityId);
    if (!EXTERNAL_ID_RE.test(facilityId)) return false;
    const row = await this.db
      .prepare("SELECT 1 AS found FROM external_facilities WHERE facility_id = ?")
      .bind(facilityId)
      .first<{ found: number }>();
    return Boolean(row);
  }

  async listKnownExternalFacilityIds(): Promise<string[]> {
    const result = await this.db
      .prepare(
        "SELECT facility_id FROM external_facilities ORDER BY facility_id ASC"
      )
      .all<{ facility_id: string }>();
    return result.results.map((row) => row.facility_id);
  }
}
