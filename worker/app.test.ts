import { describe, expect, test } from "vitest";
import app from "./app";

const env = {
  DB: {} as any,
  COMMUNITY_SALT: "test-salt",
};

describe("Workers/Hono route surface", () => {
  test("health route runs on the Worker entry without Node runtime APIs", async () => {
    const response = await app.request("https://example.test/api/health", {}, env);
    expect(response.status).toBe(200);
    const body = await response.json() as { status?: string };
    expect(body.status).toBe("ok");
  });

  test("OSM query validation fails before any D1 or upstream access", async () => {
    const response = await app.request(
      "https://example.test/api/osm/toilets?lat=999&lng=139&radius=1500",
      {},
      env
    );
    expect(response.status).toBe(400);
  });

  test("admin endpoints stay hidden when ADMIN_TOKEN is absent", async () => {
    const response = await app.request(
      "https://example.test/api/community/admin/reports",
      {},
      env
    );
    expect(response.status).toBe(404);
  });
});

describe("production rate limiting and bounded request reads", () => {
  test("fails closed without API limiter while health stays diagnosable", async () => {
    const production = { ...env, NODE_ENV: "production" };
    const rejected = await app.request("https://example.test/api/community/toilets", {}, production);
    expect(rejected.status).toBe(503);
    const health = await app.request("https://example.test/api/health", {}, production);
    expect(health.status).toBe(200);
  });

  test("rejects production writes when WRITE_RATE_LIMITER is missing", async () => {
    const production = {
      ...env, NODE_ENV: "production",
      API_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };
    const response = await app.request("https://example.test/api/community/toilets", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }, production);
    expect(response.status).toBe(503);
  });

  test("enforces a request body limit before JSON parsing", async () => {
    const response = await app.request("https://example.test/api/community/toilets", {
      method: "POST", headers: { "content-type": "application/json" },
      body: "x".repeat(100 * 1024 + 1),
    }, env);
    expect(response.status).toBe(413);
  });
});
