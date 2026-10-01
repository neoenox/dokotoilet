import { describe, expect, test } from "vitest";

import type { CommunityDB } from "../../server/community";
import type { ToiletFacility, ToiletReview } from "../../src/types";
import { buildD1MigrationSql } from "./d1-sql";

const baseAttributes = {
  hasWashlet: null,
  hasMultipurpose: null,
  hasBabyTable: null,
  hasNursingRoom: null,
  hasPowderRoom: null,
  hasOstomate: null,
  isFree: null,
  isOpen24h: null,
  hasSoap: null,
  hasAlcohol: null,
  hasPaperTowelOrDryer: null,
  toiletStyle: null,
} as const;

function review(id: string, helpfulCount = 0): ToiletReview {
  return {
    id,
    userName: "利用者",
    rating: 4,
    overallScore: 4,
    cleanlinessScore: 5,
    odorScore: 4,
    suppliesScore: 3,
    comment: " clean  enough ",
    createdAt: "2026-09-30",
    helpfulCount,
  };
}

function fixture(): CommunityDB {
  const communityReview = review("rev-community", 1);
  const externalReview = review("rev-external", 0);
  const toilet: ToiletFacility = {
    id: "toilet-user-abc",
    name: "試験トイレ",
    facilityType: "公衆トイレ",
    category: "park",
    dataSource: "community",
    lat: 35,
    lng: 139,
    address: "東京都",
    cleanlinessGrade: "A",
    cleanlinessScore: 4,
    equipmentGrade: "B",
    equipmentScore: 3,
    subScores: { cleanliness: 4, odor: 4, supplies: 4, comfort: 4 },
    attributes: baseAttributes,
    openingHours: "未確認",
    description: "O'Brien test",
    reviewCount: 1,
    reviews: [communityReview],
  };
  return {
    version: 2,
    toilets: [toilet],
    helpfulVotes: { "rev-community": ["ip-hash"] },
    reports: [{
      id: "report-1",
      toiletId: "toilet-user-abc",
      reviewId: "rev-community",
      reason: "理由",
      createdAt: "2026-09-30T00:00:00.000Z",
      status: "open",
    }],
    reviewKeys: {
      "rev-community": { ipHash: "ip-hash", at: Date.parse("2026-09-30T12:00:00.000Z") },
    },
    externalReviews: { "osm-node-123": [externalReview] },
  };
}

describe("D1 migration SQL", () => {
  test("covers all durable community records without overwriting existing D1 rows", () => {
    const output = buildD1MigrationSql(fixture(), "2026-09-30T18:00:00.000Z");
    expect(output).toContain("BEGIN IMMEDIATE;");
    expect(output).toContain("INSERT OR ABORT INTO community_toilets");
    expect(output).toContain("INSERT OR ABORT INTO external_facilities");
    expect(output).toContain("INSERT OR ABORT INTO reviews");
    expect(output).toContain("INSERT OR ABORT INTO facility_aggregates");
    expect(output).toContain("INSERT OR ABORT INTO helpful_votes");
    expect(output).toContain("INSERT OR ABORT INTO reports");
    expect(output).toContain("INSERT OR ABORT INTO review_dedup");
    expect(output).toContain("O''Brien test");
    expect(output).toContain("COMMIT;");
    expect(output).not.toContain("DELETE FROM");
    expect(output).not.toContain("INSERT OR REPLACE");
  });

  test("is deterministic when capturedAt is fixed", () => {
    const a = buildD1MigrationSql(fixture(), "2026-09-30T18:00:00.000Z");
    const b = buildD1MigrationSql(fixture(), "2026-09-30T18:00:00.000Z");
    expect(a).toBe(b);
  });

  test("fails closed on inconsistent snapshot", () => {
    const db = fixture();
    db.helpfulVotes["missing-review"] = ["x"];
    expect(() => buildD1MigrationSql(db, "2026-09-30T18:00:00.000Z"))
      .toThrow(/missing review/);
  });
});
