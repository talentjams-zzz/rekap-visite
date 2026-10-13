# SPEC v2 — Rekap Visite (Rebuild)

## Overview
Full modern rebuild of the v1 single-file app. A clinical pharmacist tracks
patient visit activities across daily Excel reports from **4 inpatient
facilities: Nusin, Melati, Sakura, Observasi**. All patient data is keyed by
unique `No. Rekam Medis` (MR number), merged across daily Excel uploads and
months.

**The v1 behavior contract lives in `reference/v1/SPEC.md`.** Everything it
describes (merge rules, riwayat snapshots, telaah reset, auto archive, lab
handling, ASO warnings, checklist, rekap) must keep working after the
rebuild. This document supersedes it only where explicitly stated below.

## v2 Architecture

| Layer | Choice | Notes |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite | SPA, no SSR |
| Tables | TanStack Table | dense data: sorting, per-facility columns, resizable |
| Styling | Tailwind CSS | re-skinned from v1 look, not ported 1:1 |
| Backend | Node 20 + Fastify | single process serves API + static `dist/` |
| Database | SQLite (`node:sqlite`, built into Node 26) | one `rekap.db` file (gitignored), zero native deps |
| Live sync | SSE | same pattern as v1 `server.js` |
| Excel parsing | **server-side** (node `xlsx`) | v1 parsed client-side; v2 uploads via API |
| Auth | none | single user, tailscale-only network |
| Deploy | one Node process, port 8787, systemd/pm2 on the tailscale machine | |

### What moves where (vs v1)
- **Excel parsing + merge logic** → backend, in pure TypeScript modules
  (`src/server/core/`), unit-testable. This was the untestable brain inside
  the 2327-line `index.html`.
- **UI state** (open riwayat rows, column widths, filters) → frontend
  `localStorage`, same as v1.
- **Master data** → SQLite, replacing the 117k-line `master_data.json` blob.

## Data model (SQLite)

- `uploads(id, filename, facility, report_date, sha256, uploaded_at)` — every
  accepted Excel file, for audit + idempotency.
- `patients(id, mr, facility, name, age, room, bed, doctor, diagnosis, operan,
  terapi, date_added, active, archived_at, note)` — one row per patient per
  facility; holds the **latest day's** fields + note + archive state
  (mirrors the v1 row shape).
- `patient_days(id, patient_id, report_date, tgl_reg, name, age, room, bed,
  doctor, diagnosis, operan, terapi, ...)` — the riwayat: one snapshot per
  day the patient appeared, newest first.
- `labs(id, mr, filename, loaded_at, findings_json)` — one lab report per MR,
  latest wins (v1 rule).
- `checklist(patient_id, item_key, checked_at)` — 7 items with timestamps.
- `meta(key, value)` — schema version, maintenance state.

## API sketch

- `GET  /api/health`
- `GET  /api/rows?facility=&status=` — patient rows (join latest day + counts)
- `GET  /api/rows/:id/history` — riwayat entries
- `POST /api/uploads` — multipart `.xlsx` → parse + merge → `{ added, merged, skipped, warnings }`
- `POST /api/rows/:id/lab` — multipart lab file → parse findings
- `PATCH /api/rows/:id` — checklist items, note, archive/unarchive, manual riwayat edits
- `GET  /api/rekap` — checklist aggregates
- `GET  /api/events` — SSE; broadcast after every mutation
- `GET  /api/maintenance`, `POST /api/maintenance/run` — keep v1's monthly
  backup + cleanup job
- Saves keep **optimistic concurrency** from v1: client sends `baseVersion`,
  server 409 on conflict, client re-fetches.

## Migration (manual + automatic)
Core: `server/src/migrate.ts` (shared). CLI: `pnpm migrate`
(`scripts/migrate-v1.ts`, `--force` to re-run over existing data).

**Auto-migration from the latest `master_data.json`** (v1 stays the live
source during transition):
- On server **startup**: if `master_data.json` is newer than the last
  migration (higher `version` or later `savedAt`), re-migrate automatically.
- While running: the server **watches** `master_data.json` (default every 60s,
  `REKAP_POLL_MS`) and re-migrates when v1 saves a newer version — no restart.
- On demand: `POST /api/migrate` forces a re-migration; `GET /api/health`
  reports `migration.upToDate` / `sourceVersion`.
- Env: `REKAP_MASTER` (master file), `REKAP_DB` (db file).

Verification on every migration (manual or auto): row counts per facility,
riwayat entries, lab count, checklist counts, archived count must match the
source JSON; mismatches are logged and reported. After cutover, v1 stops
saving and auto-migration becomes a no-op. The v1 app keeps running
touched until E2E passes on v2.

## v2 goals (beyond v1 behavior)
1. Testable core: merge/parse logic in pure TS with Vitest unit tests — the
   single biggest reliability win.
2. Server-side parsing → works in **any modern browser** (v1 was
   Chrome/Edge-only due to File System Access API + client parsing).
3. SQLite → fast queries, proper concurrency, no giant JSON rewrites.
4. E2E safety net: v1 Playwright suite ported to TypeScript.
5. Clean project structure ready to grow (auth, audit log, PWA are
   **deferred**, not in v2 scope).

## Testing
- **Unit (Vitest)**: filename → facility/date parsing; registry/handover/lab
  parsers; merge rules (latest-file-wins, riwayat append, same-day
  idempotency, out-of-order loads not clearing telaah, auto archive on
  latest input, MR leading zeros, tgl-reg time sorting).
- **E2E (Playwright, TS)**: port `reference/v1/test_*.py` assertions.
- **Migration check**: script asserts counts against source JSON.

## Security / data handling
- **PHI never enters git**: `.gitignore` covers `data/`, `*.xlsx`,
  `master_data.json*`, `rekap.db*`, `backups/`.
- No auth; app reachable only on tailscale/LAN. (Optional shared password is
  a future item, not v2.)
