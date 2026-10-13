# PLAN — v2 Rebuild (React + TS + Fastify + SQLite)

Status legend: [ ] todo · [~] in progress · [x] done

Every phase ends with: tests green + commit. v1 behavior is **frozen**
(`reference/v1/SPEC.md` is the contract) — v2 adds structure, not features.

## Phases

- [x] **P0 — Seed repo**: reference snapshot of v1, real data copied locally
      (gitignored), SPEC v2 + this plan.
- [x] **P1 — Backend skeleton**: pnpm workspace (`/server`, `/web`), Fastify +
      SQLite schema (`schema.sql`, engine: `node:sqlite` — built into Node 26,
      zero native deps), `GET /api/health`, serve `web/dist` + SPA fallback.
      `scripts/migrate-v1.mjs` from `master_data.json` → SQLite — all 12 count
      checks PASS against real data (369 patients, 1317 riwayat, 233 labs).
- [x] **P2 — Merge core (pure TS, no I/O)** in `server/src/core/`:
      `types`, `text` (parseDate + Excel serials), `filename` (facility +
      `DD-M-YY` date + input timestamp), `merge` (row identity, riwayat,
      daily-task reset + logs, auto-archive), `parsers` (registry/handover/lab
      incl. resistensi REPORT rows, eGFR/GD-POCT overrides, orphan-column
      guard), `apply` (chronological batch + latest-input rules). **57 Vitest
      tests green** — the brain, proven before any UI touches it.
- [x] **P3 — Frontend skeleton**: Vite + React + TS + Tailwind + TanStack
      Table; `GET /api/rows` endpoint (status/facility filters, checklist
      state, riwayat counts); facility tabs + Archived (Facility column) +
      Rekap placeholder; per-facility columns (Nusin gets Diagnosis/Operan/
      Terapi), sorting (default Tgl Reg desc, time-aware), resizable columns
      persisted in localStorage. Playwright smoke: 55 active / 314 archived.
- [ ] **P4 — Upload flow**: file picker → `POST /api/uploads` → result toast
      (added/merged/skipped/warnings); SSE subscription live-refreshes rows.
- [ ] **P5 — Row interactions**: 7-item checklist with timestamps, note
      editing, archive/unarchive, riwayat expand (inline per-day table),
      manual riwayat edit.
- [ ] **P6 — Lab**: per-MR lab upload, findings table with section headers +
      abnormal/kritis highlighting + komentar, copy-to-clipboard, ASO
      stop-date warnings + "ASO ⚠" filter, archived rows read-only.
- [ ] **P7 — Rekap + Archived filters**: rekap checklist aggregates; archived
      tab facility column + facility dropdown + date-range filter.
- [ ] **P8 — E2E port**: v1 `test_*.py` → TypeScript Playwright in
      `e2e/`, driven against dev server with isolated DB (same approach as
      v1 `conftest.py`).
- [ ] **P9 — Hardening**: optimistic-concurrency 409 handling in client,
      error toasts, empty states, maintenance job (monthly backup + cleanup),
      upload dedupe by sha256.
- [ ] **P10 — Deploy & cutover**: `pnpm build`, systemd unit (or pm2) on the
      tailscale machine, run v2 alongside v1, verify with real data for one
      cycle, then switch the tailscale URL to v2. v1 stays frozen as
      fallback.

## Work-order rules
1. P2 before P4 — merge correctness is proven by unit tests before the UI
   can trigger it.
2. No feature work outside v1 contract without a SPEC v2 change first.
3. Real data (`master_data.json`, `data/`) stays local, gitignored, and is
   the test fixture — never committed.

## Risks / mitigations
| Risk | Mitigation |
|---|---|
| Merge-rule port is unfaithful (v1 has many edge cases) | Unit tests in P2 ported 1:1 from v1 test assertions; E2E port in P8 as second net |
| Migration loses data | Count verification + 5-patient spot check vs v1 UI; v1 JSON kept as backup; cutover only after P10 verification cycle |
| Scope creep (auth, PWA, multi-user) | Explicitly deferred in SPEC; not in any phase |
| v1 app breaks during transition | v1 repo untouched (frozen at baseline `1d95642`); both apps run in parallel until cutover |

## Open defaults (overridable)
- No auth (tailscale-only) · SQLite over Postgres (zero-ops, single user) ·
  SSE over WebSockets · Tailwind re-skin (not a 1:1 CSS port).
