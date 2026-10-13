# Rekap Visite (v2)

Modern rebuild of the single-file **Rekap Visite Multicentre** app — a
clinical-pharmacist tool that tracks patient visit activities across daily
Excel reports from 4 inpatient facilities (Nusin, Melati, Sakura, Observasi).

- **Spec**: [`SPEC.md`](SPEC.md) — v2 architecture + data model.
  The v1 behavior contract: [`reference/v1/SPEC.md`](reference/v1/SPEC.md).
- **Plan**: [`PLAN.md`](PLAN.md) — phased rebuild (P0–P10).

## Stack
React 18 + TypeScript + Vite + TanStack Table + Tailwind (frontend) ·
Fastify + SQLite + SSE (backend) · Playwright (E2E) · Vitest (unit).

## Layout
```
server/   Fastify API + SQLite + core merge logic (pure TS)
web/      React SPA
e2e/      Playwright tests (ported from reference/v1/test_*.py)
scripts/  migrate-v1.mjs (master_data.json → SQLite)
reference/v1/  frozen v1 app snapshot (the behavior contract)
```

## Data (local only — PHI, gitignored)
`master_data.json` and `data/*.xlsx` are real patient data. They live in the
working directory, are gitignored, and are the test fixtures. Never commit
them.

## Run (after P1)
```
pnpm install
pnpm dev        # server :8787 + web :5173 (proxied)
pnpm test       # vitest unit
pnpm e2e        # playwright
```
