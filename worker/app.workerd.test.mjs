import { beforeAll, describe, expect, test } from "vitest";
import { env } from "cloudflare:workers";

import app from "./app";
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

describe("community D1 data-integrity reporting", () => {
  test("keeps valid facilities visible and warns when a persisted row has malformed JSON", async () => {
    const validId = "toilet-user-integrity-valid";
    const malformedId = "toilet-user-integrity-malformed";
    const createdAt = "2026-11-13T00:00:00.000Z";

    const insert = env.DB.prepare(
      `INSERT OR REPLACE INTO community_toilets
         (facility_id, name, category, lat, lng, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    await insert
      .bind(
        validId,
        "valid integrity fixture",
        "park",
        35,
        139,
        JSON.stringify({ id: validId, equipmentScore: 3, equipmentGrade: "B" }),
        createdAt
      )
      .run();
    await insert
      .bind(
        malformedId,
        "malformed integrity fixture",
        "park",
        35,
        139,
        "{invalid-json",
        createdAt
      )
      .run();

    try {
      const response = await app.request(
        "https://example.test/api/community/toilets",
        {},
        env
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Data-Integrity-Warning")).toBe(
        "malformed-community-facility-records"
      );

      const body = await response.json();
      const ids = body.toilets.map((toilet) => toilet.id);
      expect(ids).toContain(validId);
      expect(ids).not.toContain(malformedId);

      const stored = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM community_toilets WHERE facility_id IN (?, ?)"
      )
        .bind(validId, malformedId)
        .first();
      expect(stored?.count).toBe(2);
    } finally {
      await env.DB.prepare(
        "DELETE FROM community_toilets WHERE facility_id IN (?, ?)"
      )
        .bind(validId, malformedId)
        .run();
    }
  });
});
