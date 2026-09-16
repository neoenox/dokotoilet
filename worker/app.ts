// Cloudflare Pages/Workers entry for the community API (#114).
//
// Strangler scope: this Hono app will grow route-by-route (health ->
// community -> osm proxy) until it replaces server.ts for production.
// Express files stay untouched until the Pages cutover is verified.

import { Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";

export interface WorkerEnv {
  DB: D1Database;
  COMMUNITY_SALT: string;
  ADMIN_TOKEN?: string;
}

const app = new Hono<{ Bindings: WorkerEnv }>();

app.get("/api/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() })
);

app.notFound((c) => c.json({ error: "not found" }, 404));

export default app;
