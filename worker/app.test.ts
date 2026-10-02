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
