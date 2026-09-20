# Contributing to きれいトイレ

## Quick start

```bash
bun install
bun run dev        # http://localhost:3000 (tsx + Vite)
bun run lint       # tsc --noEmit
bun run test       # vitest run
bun run build      # vite build + server bundle → dist/
bun run smoke      # E2E smoke against production bundle (run after build)
bun start          # production start (dist/server.cjs)
```

## Verification checklist (before PR)

1. `bun install` (frozen lockfile) succeeds.
2. `bun run lint` — `tsc --noEmit` passes (0 errors).
3. `bun run test` — all tests pass.
4. `bun run build` — bundles without errors.
5. `bun run smoke` — `SMOKE PASS`.

CI runs these automatically on push/PR to `main` (`.github/workflows/ci.yml`).

## Coding conventions

- **TypeScript strict** — no `any`; prefer `as const` / literal types.
- **React** — functional components, SSR-safe (no `window` access in render).
- **Tailwind v4** (`@tailwindcss/vite`) — use existing class patterns.
- **Backend** — `server/community.ts` is the data layer; keep JSON + Firestore
  stores contract-compatible (soft-delete parity, idempotent vote/report).
- **Local delta queue** — `src/lib/localDeltas.ts`; permanent 4xx failures
  (except 429) evict from `pending` queue, transient (0/429/5xx) retry.

## Commit style (Conventional Commits)

```
feat:        new feature
fix:         bug fix
refactor:    internal refactor
perf:        performance
test:        tests only
chore:       tooling / deps / docs
docs:        documentation
```

- One logical change per commit.
- Reference issues: `fix: reject helpful votes for deleted reviews (#115)`.
- Squash-merge PRs.

## Data sources & seeds

1. Overpass API → `/tmp/unique_osm.json`
2. `node tmp/gen_toilets.js` → `src/data/toilets.ts` (not git-tracked)
3. Manual fallback → `src/data/realOsmSeed.ts`

`data/community.json` is git-tracked and the canonical store; CI verifies it
remains tracked.
