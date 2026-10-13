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
- [x] **P4 — Upload flow**: `POST /api/uploads` (multipart, xlsx parsed
      server-side via P2 core, upload-time = input timestamp), SQLite
      write-back, uploads audit table (sha256), SSE `change` broadcast
      (uploads + auto-migration); UI: upload bar + toasts + EventSource
      live refresh. UI round-trip verified: 20 active → upload → toast
      "+1 new · 20 archived" → table + tab counts update without reload.
- [x] **P5 — Row interactions**: 8-item checklist chips (3 row + 5
      patient-level) with timestamps + optimistic updates, in-place editing
      of diagnosis/operan/terapi/note (editable fields also recorded into
      the current day's riwayat snapshot — v1 manual-riwayat regression),
      archive/restore, riwayat expand (inline past-days table, fetched on
      demand). Verified: UI round-trip + DB persistence (incl. snapshot).
- [x] **P6 — Lab**: per-MR lab upload (lab-{MR}.xlsx, latest wins →
      `POST /api/uploads/lab`), lab summary cell (date + abnormal/kritis
      counts, ⚠ Lab Kritis badge), expandable findings table (Jenis section
      headers, abnormal red, kritis red+LK, Abnormal/Kritis filter bar, copy
      visible tests to clipboard), `GET /api/patients/:mr/lab`. **ASO** (meds
      to stop): migration now preserves `row.aso` (was being dropped — 22 real
      rows), ASO cell (add/name/date/✓stop/×, due = red), top "⚠️ ASO Alert : N
      meds" banner, per-facility "ASO ⚠" row filter, archived read-only.
      Verified: banner 23 = v1 computation, upload round-trip replaced MR
      report, ASO med persisted. Faithfulness fix: all facilities get the full
      column set (v1 COLS_SHORT === COLS_FULL).
- [x] **P7 — Rekap + Archived filters**: `GET /api/rekap` (v1
      buildRekapData: current checks + daily-log stamps per date, MRs
      deduped; patient-level items) — verified byte-identical to v1
      algorithm on real data (232 patients, 21 dates, all 7 totals match).
      Rekap tab: stat cards + per-date breakdown + Copy MRs + MR tags that
      jump to the row's tab. Archived tab: facility dropdown + Tgl Reg
      date-range filter (date-part compare, v1 boundary semantics).
- [x] **P8 — E2E port**: `e2e/` (Node Playwright, `pnpm test:e2e`) —
      12 specs porting v1's 23 `test_*.py` behaviors against scratch servers
      (isolated master+DB+port per test, synthetic fixtures, no PHI):
      checklist reset semantics (telaah/pio/CP), riwayat + manual-riwayat
      regression, lab (parse/flags/sections/copy/latest-wins/skip), ASO +
      banner, auto-archive/unarchive, MR leading zeros, time-aware Tgl Reg
      sort, editable fields on all facilities. `test_monthly_cleanup` →
      fixme (P9); v1 local-file save mode has no v2 equivalent (server
      persistence). **Found + fixed 2 real bugs**: state.ts write-back
      INSERT had 19 placeholders for 18 cols (P6's aso change — every
      registry upload 500'd, undetected because P6 verified lab uploads
      only); expanded lab panel went stale after SSE reload (now
      signature-checked auto-refresh).
- [x] **P9 — Hardening**: optimistic-concurrency 409 handling in client,
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
