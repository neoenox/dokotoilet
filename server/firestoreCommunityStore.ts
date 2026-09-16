import crypto from "node:crypto";
import type { ToiletFacility, ToiletReview } from "../src/types";
import { gradeForScore } from "../src/lib/scoring";
import type { ReviewInput, StoredReport } from "./community";
import {
  dedupCommentHash,
  normalizeReportReason,
  reviewDedupId,
} from "./shared/dedup";
import type {
  AddReviewResult,
  CommunityRepository,
  DeleteReviewResult,
  ExternalFacilityObservation,
  ListReportsOptions,
  ResolveReportResult,
} from "./communityRepository";


function reportAtOf(data: Record<string, any>): number {
  if (typeof data.at === "number" && Number.isFinite(data.at)) return data.at;
  if (typeof data.createdAt === "string") {
    const parsed = Date.parse(data.createdAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function storedReportFromDoc(
  id: string,
  data: Record<string, any>
): StoredReport {
  const createdAt =
    typeof data.createdAt === "string" ? data.createdAt : new Date().toISOString();
  return {
    id: typeof data.id === "string" ? data.id : id,
    toiletId:
      typeof data.toiletId === "string"
        ? data.toiletId
        : typeof data.facilityId === "string"
          ? data.facilityId
          : "",
    reviewId: typeof data.reviewId === "string" ? data.reviewId : "",
    reason: typeof data.reason === "string" ? data.reason : "",
    createdAt,
    at: reportAtOf({ ...data, createdAt }),
    status: data.status === "resolved" ? "resolved" : "open",
    ...(typeof data.resolvedAt === "string" ? { resolvedAt: data.resolvedAt } : {}),
    ...(typeof data.resolution === "string" ? { resolution: data.resolution } : {}),
    ...(typeof data.adminNote === "string" ? { adminNote: data.adminNote } : {}),
  };
}

type Plain = Record<string, any>;

export interface FirestoreDocumentSnapshotLike {
  exists: boolean;
  id: string;
  data(): Plain | undefined;
}

export interface FirestoreQuerySnapshotLike {
  docs: FirestoreDocumentSnapshotLike[];
}

export interface FirestoreDocumentRefLike {
  id: string;
  get(): Promise<FirestoreDocumentSnapshotLike>;
  create(data: Plain): Promise<unknown>;
  set(data: Plain, options?: Plain): Promise<unknown>;
}

export interface FirestoreQueryLike {
  where(field: string, op: "==", value: unknown): FirestoreQueryLike;
  get(): Promise<FirestoreQuerySnapshotLike>;
}

export interface FirestoreCollectionLike extends FirestoreQueryLike {
  doc(id?: string): FirestoreDocumentRefLike;
}

export interface FirestoreTransactionLike {
  get(ref: FirestoreDocumentRefLike): Promise<FirestoreDocumentSnapshotLike>;
  get(query: FirestoreQueryLike): Promise<FirestoreQuerySnapshotLike>;
  create(ref: FirestoreDocumentRefLike, data: Plain): FirestoreTransactionLike;
  set(ref: FirestoreDocumentRefLike, data: Plain, options?: Plain): FirestoreTransactionLike;
  update(ref: FirestoreDocumentRefLike, data: Plain): FirestoreTransactionLike;
}

export interface FirestoreLike {
  collection(name: string): FirestoreCollectionLike;
  runTransaction<T>(fn: (tx: FirestoreTransactionLike) => Promise<T>): Promise<T>;
}

interface AggregateDoc {
  reviewCount: number;
  overallSum: number;
  cleanlinessSum: number;
  odorSum: number;
  suppliesSum: number;
}

const EMPTY_AGGREGATE: AggregateDoc = {
  reviewCount: 0,
  overallSum: 0,
  cleanlinessSum: 0,
  odorSum: 0,
  suppliesSum: 0,
};

function asAggregate(raw: Plain | undefined): AggregateDoc {
  return {
    reviewCount: Number(raw?.reviewCount) || 0,
    overallSum: Number(raw?.overallSum) || 0,
    cleanlinessSum: Number(raw?.cleanlinessSum) || 0,
    odorSum: Number(raw?.odorSum) || 0,
    suppliesSum: Number(raw?.suppliesSum) || 0,
  };
}

function nextAggregate(a: AggregateDoc, r: ReviewInput): AggregateDoc {
  return {
    reviewCount: a.reviewCount + 1,
    overallSum: a.overallSum + r.overallScore,
    cleanlinessSum: a.cleanlinessSum + r.cleanlinessScore,
    odorSum: a.odorSum + r.odorScore,
    suppliesSum: a.suppliesSum + r.suppliesScore,
  };
}

function average(sum: number, count: number): number {
  return count > 0 ? Math.round((sum / count) * 10) / 10 : 0;
}

function publicFacilityFromDoc(raw: Plain, reviews: ToiletReview[]): ToiletFacility {
  return { ...(raw as ToiletFacility), reviews, reviewCount: reviews.length };
}

function reviewFromDoc(s: FirestoreDocumentSnapshotLike): ToiletReview {
  const data = s.data() ?? {};
  const { facilityId: _facilityId, facilityKind: _facilityKind, ...review } = data;
  return { ...review, id: data.id ?? s.id } as ToiletReview;
}

function isAlreadyExists(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown };
  return e?.code === 6 || e?.code === "already-exists" || /already exists/i.test(String(e?.message ?? ""));
}

export class FirestoreCommunityStore implements CommunityRepository {
  constructor(private readonly db: FirestoreLike) {}

  private col(name: string) {
    return this.db.collection(name);
  }

  private reviewId(): string {
    return `rev-${crypto.randomUUID()}`;
  }

  private buildReview(id: string, input: ReviewInput): ToiletReview {
    return {
      id,
      userName: input.userName,
      rating: input.overallScore,
      overallScore: input.overallScore,
      cleanlinessScore: input.cleanlinessScore,
      odorScore: input.odorScore,
      suppliesScore: input.suppliesScore,
      comment: input.comment,
      createdAt: new Date().toISOString().split("T")[0],
      helpfulCount: 0,
    };
  }


  private voteId(reviewId: string, ipHash: string): string {
    return crypto.createHash("sha256").update(`${reviewId}|${ipHash}`).digest("hex");
  }

  private async reviewsForFacility(facilityId: string): Promise<ToiletReview[]> {
    const snap = await this.col("reviews").where("facilityId", "==", facilityId).get();
    return snap.docs
      .filter((d) => (d.data() as Record<string, any> | undefined)?.deleted !== true)
      .map(reviewFromDoc)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async getToilets(): Promise<ToiletFacility[]> {
    const [facilities, communityReviews] = await Promise.all([
      this.col("community_toilets").get(),
      this.col("reviews").where("facilityKind", "==", "community").get(),
    ]);
    const reviewsByFacility = new Map<string, ToiletReview[]>();
    for (const doc of communityReviews.docs) {
      const data = doc.data() ?? {};
      if ((data as Record<string, any>).deleted === true) continue;
      const facilityId = String(data.facilityId ?? "");
      if (!facilityId) continue;
      const list = reviewsByFacility.get(facilityId) ?? [];
      list.push(reviewFromDoc(doc));
      reviewsByFacility.set(facilityId, list);
    }
    for (const list of reviewsByFacility.values()) {
      list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    }
    return facilities.docs.map((doc) =>
      publicFacilityFromDoc(doc.data() ?? {}, reviewsByFacility.get(doc.id) ?? [])
    );
  }

  async getExternalReviews(): Promise<Record<string, ToiletReview[]>> {
    const snap = await this.col("reviews").where("facilityKind", "==", "external").get();
    const out: Record<string, ToiletReview[]> = {};
    for (const doc of snap.docs) {
      const data = doc.data() ?? {};
      if ((data as Record<string, any>).deleted === true) continue;
      const facilityId = String(data.facilityId ?? "");
      if (!facilityId) continue;
      (out[facilityId] ??= []).push(reviewFromDoc(doc));
    }
    for (const list of Object.values(out)) {
      list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    }
    return out;
  }

  async addToilet(toilet: ToiletFacility): Promise<{ added: boolean }> {
    const ref = this.col("community_toilets").doc(toilet.id);
    return this.db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) return { added: false };
      const { reviews: _reviews, ...stored } = toilet;
      tx.create(ref, { ...stored, reviewCount: 0 });
      tx.create(this.col("facility_aggregates").doc(toilet.id), EMPTY_AGGREGATE);
      return { added: true };
    });
  }

  async addReview(
    facilityId: string,
    input: ReviewInput,
    ipHash: string
  ): Promise<AddReviewResult> {
    const facilityRef = this.col("community_toilets").doc(facilityId);
    const externalRef = this.col("external_facilities").doc(facilityId);
    const dedupRef = this.col("review_dedup").doc(reviewDedupId(facilityId, ipHash, input.comment));
    const aggregateRef = this.col("facility_aggregates").doc(facilityId);
    const reviewId = this.reviewId();
    const reviewRef = this.col("reviews").doc(reviewId);
    const now = Date.now();

    const outcome = await this.db.runTransaction(async (tx) => {
      const facility = await tx.get(facilityRef);
      const external = facility.exists ? null : await tx.get(externalRef);
      if (!facility.exists && !external?.exists) {
        return { error: "not_found" as const, kind: null as null | "community" | "external" };
      }

      const dedup = await tx.get(dedupRef);
      const validUntil = Number(dedup.data()?.validUntil ?? 0);
      if (dedup.exists && validUntil > now) {
        return { error: "duplicate" as const, kind: null as null | "community" | "external" };
      }

      const aggregateSnap = await tx.get(aggregateRef);
      const aggregate = nextAggregate(
        aggregateSnap.exists ? asAggregate(aggregateSnap.data()) : EMPTY_AGGREGATE,
        input
      );
      const kind = facility.exists ? "community" : "external";
      const review = this.buildReview(reviewId, input);

      tx.create(reviewRef, { ...review, facilityId, facilityKind: kind });
      tx.set(dedupRef, {
        facilityId,
        ipHash,
        reviewId,
        commentHash: dedupCommentHash(input.comment),
        createdAt: new Date(now).toISOString(),
        validUntil: now + 24 * 60 * 60 * 1000,
      });
      tx.set(aggregateRef, aggregate);

      if (kind === "community") {
        const cleanlinessScore = average(aggregate.cleanlinessSum, aggregate.reviewCount);
        const overallScore = average(aggregate.overallSum, aggregate.reviewCount);
        tx.update(facilityRef, {
          reviewCount: aggregate.reviewCount,
          cleanlinessScore,
          cleanlinessGrade: gradeForScore(cleanlinessScore),
          overallScore,
          lastCleaned: "たった今（利用者が確認）",
        });
      }

      return { kind, review };
    });

    if ("error" in outcome && outcome.error) return { error: outcome.error };
    const reviews = await this.reviewsForFacility(facilityId);
    if (outcome.kind === "community") {
      const facility = await facilityRef.get();
      return {
        toilet: publicFacilityFromDoc(facility.data() ?? {}, reviews),
      };
    }

    const count = reviews.length;
    const cleanlinessScore = count
      ? Math.round((reviews.reduce((s, r) => s + r.cleanlinessScore, 0) / count) * 10) / 10
      : undefined;
    const overallScore = count
      ? Math.round((reviews.reduce((s, r) => s + (r.overallScore ?? r.rating), 0) / count) * 10) / 10
      : undefined;
    return {
      facilityId,
      reviews,
      reviewCount: count,
      cleanlinessScore,
      cleanlinessGrade:
        cleanlinessScore === undefined ? undefined : gradeForScore(cleanlinessScore),
      overallScore,
    };
  }

  async voteHelpful(
    reviewId: string,
    ipHash: string
  ): Promise<{ helpfulCount: number; voted: boolean; found: boolean }> {
    const reviewRef = this.col("reviews").doc(reviewId);
    const voteRef = this.col("helpful_votes").doc(this.voteId(reviewId, ipHash));
    return this.db.runTransaction(async (tx) => {
      const review = await tx.get(reviewRef);
      if (!review.exists || review.data()?.deleted === true) {
        return { helpfulCount: 0, voted: false, found: false };
      }
      const vote = await tx.get(voteRef);
      const current = Number(review.data()?.helpfulCount ?? 0);
      if (vote.exists) return { helpfulCount: current, voted: false, found: true };
      tx.create(voteRef, { reviewId, ipHash, createdAt: new Date().toISOString() });
      tx.update(reviewRef, { helpfulCount: current + 1 });
      return { helpfulCount: current + 1, voted: true, found: true };
    });
  }

  async addReport(
    facilityId: string,
    reviewId: string,
    reason: string
  ): Promise<{ ok: boolean; found: boolean; duplicate?: boolean }> {
    const reviewRef = this.col("reviews").doc(reviewId);
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const normReason = normalizeReportReason(reason);
    const reportId = `report-${crypto.randomUUID()}`;
    const reportRef = this.col("reports").doc(reportId);
    return this.db.runTransaction(async (tx) => {
      const reviewSnap = await tx.get(reviewRef) as FirestoreDocumentSnapshotLike;
      if (
        !reviewSnap.exists ||
        reviewSnap.data()?.facilityId !== facilityId ||
        (reviewSnap.data() as Record<string, any>)?.deleted === true
      ) return { ok: false, found: false };
      const existing = await tx.get(this.col("reports").where("reviewId", "==", reviewId)) as FirestoreQuerySnapshotLike;
      const dup = existing.docs.some((d) => {
        const data = (d.data() ?? {}) as Record<string, any>;
        return data.status !== "resolved" &&
          normalizeReportReason(String(data.reason ?? "")) === normReason &&
          reportAtOf(data) >= dayAgo;
      });
      if (dup) return { ok: false, found: true, duplicate: true };
      tx.create(reportRef, {
        id: reportId,
        facilityId,
        toiletId: facilityId,
        reviewId,
        reason,
        createdAt: new Date(now).toISOString(),
        at: now,
        status: "open",
      });
      return { ok: true, found: true };
    });
  }

  async listReports(opts: ListReportsOptions = {}): Promise<StoredReport[]> {
    const status = opts.status ?? "all";
    const rawOffset = Number(opts.offset ?? 0);
    const rawLimit = Number(opts.limit ?? 50);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
    const limit = Number.isFinite(rawLimit)
      ? Math.max(0, Math.min(100, Math.floor(rawLimit)))
      : 50;
    const snap = await this.col("reports").get();
    let list = snap.docs.map((d) =>
      storedReportFromDoc(d.id, (d.data() ?? {}) as Record<string, any>)
    );
    if (status === "open" || status === "resolved") {
      list = list.filter((r) => r.status === status);
    }
    list.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    return list.slice(offset, offset + limit);
  }

  async resolveReport(reportId: string, note?: string): Promise<ResolveReportResult> {
    const ref = this.col("reports").doc(reportId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { found: false };
      const nowIso = new Date().toISOString();
      const patch: Record<string, any> = {
        status: "resolved",
        resolvedAt: nowIso,
      };
      if (typeof note === "string" && note.trim()) {
        patch.resolution = note.trim().slice(0, 500);
        patch.adminNote = patch.resolution;
      }
      tx.update(ref, patch);
      const merged = { ...((snap.data() ?? {}) as Record<string, any>), ...patch };
      return { found: true, report: storedReportFromDoc(reportId, merged) };
    });
  }

  async deleteReview(reviewId: string, reason?: string): Promise<DeleteReviewResult> {
    const reviewRef = this.col("reviews").doc(reviewId);
    const nowIso = new Date().toISOString();
    const resolution =
      typeof reason === "string" && reason.trim()
        ? reason.trim().slice(0, 500)
        : "admin delete";
    return this.db.runTransaction(async (tx) => {
      const current = await tx.get(reviewRef) as FirestoreDocumentSnapshotLike;
      if (!current.exists || current.data()?.deleted === true) return { found: false };
      const data = (current.data() ?? {}) as Record<string, any>;
      const facilityId = String(data.facilityId ?? "");
      const kind = data.facilityKind === "community" ? "community" : "external";
      const related = await tx.get(this.col("reports").where("reviewId", "==", reviewId)) as FirestoreQuerySnapshotLike;
      const aggregateRef = this.col("facility_aggregates").doc(facilityId);
      const aggregateSnap = kind === "community"
        ? await tx.get(aggregateRef) as FirestoreDocumentSnapshotLike
        : null;
      const allReviews = await tx.get(this.col("reviews").where("facilityId", "==", facilityId)) as FirestoreQuerySnapshotLike;
      const remaining = allReviews.docs
        .filter((doc) => doc.id !== reviewId && (doc.data() ?? {}).deleted !== true)
        .map(reviewFromDoc);
      const facRef = this.col("community_toilets").doc(facilityId);
      const facSnap = kind === "community" ? await tx.get(facRef) as FirestoreDocumentSnapshotLike : null;
      tx.update(reviewRef, {
        deleted: true,
        deletedAt: nowIso,
        deleteReason: resolution,
      });
    for (const doc of related.docs) {
      const rd = (doc.data() ?? {}) as Record<string, any>;
      if (rd.status === "resolved") continue;
      const ref = this.col("reports").doc(doc.id);
      tx.update(ref, { status: "resolved", resolvedAt: nowIso, resolution });
    }
    if (kind === "community" && facilityId) {
      const remainingCount = remaining.length;
      const fallbackAggregate: AggregateDoc = {
        reviewCount: remainingCount,
        overallSum: remaining.reduce((s, r) => s + (r.overallScore ?? r.rating ?? 0), 0),
        cleanlinessSum: remaining.reduce((s, r) => s + (r.cleanlinessScore ?? 0), 0),
        odorSum: remaining.reduce((s, r) => s + (r.odorScore ?? 0), 0),
        suppliesSum: remaining.reduce((s, r) => s + (r.suppliesScore ?? 0), 0),
      };
      // The aggregate is read in the same transaction as addReview.  Decrementing
      // it, rather than rebuilding from a non-conflicting query, prevents a
      // concurrent review from being lost between the query and commit.
      const existingAggregate = aggregateSnap?.exists ? asAggregate(aggregateSnap.data()) : fallbackAggregate;
      const deletedAggregate: AggregateDoc = {
        reviewCount: Math.max(0, existingAggregate.reviewCount - 1),
        overallSum: existingAggregate.overallSum - (data.overallScore ?? data.rating ?? 0),
        cleanlinessSum: existingAggregate.cleanlinessSum - (data.cleanlinessScore ?? 0),
        odorSum: existingAggregate.odorSum - (data.odorScore ?? 0),
        suppliesSum: existingAggregate.suppliesSum - (data.suppliesScore ?? 0),
      };
        const count = deletedAggregate.reviewCount;
        const overallSum = deletedAggregate.overallSum;
        const cleanlinessSum = deletedAggregate.cleanlinessSum;
        tx.set(aggregateRef, deletedAggregate);
      if (!facSnap?.exists) return { found: true, facilityId, kind, reviewCount: count };
        if (count === 0) {
          const raw = (facSnap.data() ?? {}) as Record<string, any>;
          const equipmentScore = Number(raw.equipmentScore) || 0;
          const equipmentGrade =
            typeof raw.equipmentGrade === "string"
              ? raw.equipmentGrade
              : gradeForScore(equipmentScore);
          const { overallScore: _dropOverall, lastCleaned: _dropCleaned, ...rest } =
            raw as Record<string, any>;
          tx.set(facRef, {
            ...rest,
            reviewCount: 0,
            cleanlinessScore: equipmentScore,
            cleanlinessGrade: equipmentGrade,
          });
        } else {
          const cleanlinessScore = average(cleanlinessSum, count);
          const overallScore = average(overallSum, count);
          tx.update(facRef, {
            reviewCount: count,
            cleanlinessScore,
            cleanlinessGrade: gradeForScore(cleanlinessScore),
            overallScore,
            lastCleaned: "たった今（利用者が確認）",
          });
        }
      return { found: true, facilityId, kind, reviewCount: count };
    }
    return { found: true, facilityId, kind, reviewCount: remaining.length };
    });
  }

  async registerExternalFacilities(facilities: ExternalFacilityObservation[]): Promise<void> {
    await Promise.all(
      facilities.map(async (facility) => {
        const ref = this.col("external_facilities").doc(facility.id);
        try {
          await ref.create({
            ...facility,
            firstSeenAt: new Date().toISOString(),
          });
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
        }
      })
    );
  }

  async isKnownExternalFacility(facilityId: string): Promise<boolean> {
    return (await this.col("external_facilities").doc(facilityId).get()).exists;
  }

  async listKnownExternalFacilityIds(): Promise<string[]> {
    const snap = await this.col("external_facilities").get();
    return snap.docs.map((doc) => doc.id).sort();
  }
}
