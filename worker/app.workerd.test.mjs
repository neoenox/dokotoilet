import { beforeAll, describe, expect, test } from "vitest";
import { env } from "cloudflare:workers";

import app from "./app";
import { D1CommunityRepository } from "./d1CommunityRepository";
import { TERMINAL_STATIONS_SEED } from "../src/data/terminalStationsSeed";
import schema from "./schema.sql?raw";

beforeAll(async () => {
  const executableSchema = schema
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const statements = executableSchema
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
});

describe("Workers runtime integration", () => {
  test("executes D1 queries in workerd", async () => {
    const row = await env.DB.prepare("SELECT 1 AS value").first();
    expect(row?.value).toBe(1);
  });

  test("uses the local KV binding in workerd", async () => {
    await env.OSM_CACHE.put("runtime-smoke", "ok");
    expect(await env.OSM_CACHE.get("runtime-smoke")).toBe("ok");
  });

  test("serves community data through the real D1 binding", async () => {
    const response = await app.request(
      "https://example.test/api/community/toilets",
      {},
      env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      toilets: [],
      externalReviews: {},
    });
  });
});

describe("curated manual external facilities", () => {
  const review = {
    userName: "workerd-test",
    overallScore: 4,
    cleanlinessScore: 4,
    odorScore: 4,
    suppliesScore: 4,
    comment: "初回レビューの回帰試験",
  };
  test("accepts the first review for shipped static terminal IDs", async () => {
    const response = await app.request(
      "https://example.test/api/community/toilets/terminal-shinjuku-newoman/reviews",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(review) },
      env
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.facilityId).toBe("terminal-shinjuku-newoman");
    expect(body.reviewCount).toBeGreaterThan(0);
  });

  test("all 14 shipped manual seeds are known without prior D1 registration", async () => {
    const repository = new D1CommunityRepository(env.DB);
    const known = await repository.listKnownExternalFacilityIds();
    expect(TERMINAL_STATIONS_SEED).toHaveLength(14);
    for (const facility of TERMINAL_STATIONS_SEED) {
      expect(await repository.isKnownExternalFacility(facility.id)).toBe(true);
      expect(known).toContain(facility.id);
    }
    expect(await repository.isKnownExternalFacility("terminal-fabricated-1")).toBe(false);
    expect(known).not.toContain("terminal-fabricated-1");
  });

  test("continues to reject fabricated terminal facility IDs", async () => {
    const response = await app.request(
      "https://example.test/api/community/toilets/terminal-made-up-zzzzz/reviews",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(review) },
      env
    );
    expect(response.status).toBe(404);
  });
});
