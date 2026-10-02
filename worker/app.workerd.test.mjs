import { beforeAll, describe, expect, test } from "vitest";
import { env } from "cloudflare:workers";

import app from "./app";
import schema from "./schema.sql?raw";

beforeAll(async () => {
  const executableSchema = schema
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  await env.DB.exec(executableSchema);
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
