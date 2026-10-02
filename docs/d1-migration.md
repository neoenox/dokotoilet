# D1 migration and local acceptance

Issue #114 moves the community backend from the long-lived Express/JSON process to a Workers/Hono + D1 runtime.

## Repository-side dry run

Generate import SQL from the authoritative JSON snapshot without contacting Cloudflare:

```bash
bun scripts/community-migrate/d1-sql.ts \
  --in data/community.json \
  --out tmp/community-d1-import.sql
```

The generator validates the complete snapshot first and fails closed on broken review/report/vote references. The SQL uses `INSERT OR ABORT`; it does not delete or overwrite an existing D1 database.

The generated SQL contains community content and hashed actor identifiers. Keep it under `tmp/` or another private working directory and do not commit it.

## Staging/local D1 procedure

After creating a disposable local/staging D1 database, apply `worker/schema.sql` first, then the generated SQL. Verify counts for:

- community toilets
- community and external reviews
- external facility registry
- helpful votes
- reports
- active 24-hour duplicate guards
- aggregate rows

Run the repository test suite and the Worker route regression tests before any deployment.

```bash
bun run test
bun run test:worker
```

`test:worker` runs under Cloudflare's current `@cloudflare/vitest-plugin`/workerd integration and exercises the local D1 and KV bindings.

## Production boundary

This repository does **not** provision Production D1/KV, set `COMMUNITY_SALT` or `ADMIN_TOKEN`, change DNS, deploy Workers/Pages, or cut over live traffic automatically.

Production cutover requires a separately approved run with:

1. exact source SHA and current Production snapshot,
2. rollback copy and destination,
3. D1/KV bindings and Secrets,
4. schema + migration dry run/parity evidence,
5. deployment,
6. health/community/OSM/moderation smoke,
7. rollback verification.
