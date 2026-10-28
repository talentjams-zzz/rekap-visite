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
untouched until E2E passes on v2.

## v2 goals (beyond v1 behavior)
1. Testable core: merge/parse logic in pure TS with Vitest unit tests — the
   single biggest reliability win.
2. Server-side parsing → works in **any modern browser** (v1 was
   Chrome/Edge-only due to File System Access API + client parsing).
3. SQLite → fast queries, proper concurrency, no giant JSON rewrites.
4. E2E safety net: v1 Playwright suite ported to TypeScript.
5. Clean project structure ready to grow (auth, audit log, PWA are
   **deferred**, not in v2 scope).

### v2 behavior additions (deliberate deviations from frozen v1)
- **SOAP column** — per-day free text after the Pharmacist Note; resets to
  blank when a new day's file arrives; the previous day's value moves to
  Riwayat (a new `patient_days.soap` column).
- **Readmission episode reset** — v1 (and pre-fix v2) kept showing the
  previous stay's treatment on a readmitted patient. v2 treats a *changed
  registration date* in the registry file as a new treatment episode:
  - snapshot first: the old episode's final D/O/T + note + SOAP + patient-
    checklist ticks are written to its last Riwayat day (v2-only
    `patient_days` columns; v1 ignores unknown history keys);
  - then clear: diagnosis/operan/terapi/pharmacist note/SOAP/ASO on the row,
    and the 5 patient-level checklist items for that MR;
  - trigger rule (audit of 369 real patients, 627 day transitions): reg-date
    change occurred 3x — always with long absences, never on a 1-day gap;
    long gaps with an UNCHANGED reg date (41x) are missing-facility-file
    artifacts. So the reg-date change — not the archive flag, not the gap —
    is the trigger; a blank reg date is "no signal" and never resets;
  - handover (operan) files carry no reg date and can never trigger it;
    manual unarchive from the UI also does not trigger it.
  - Catatan Pengobatan (row item) is NOT reset (v1: one-time per-patient
    task); labs are kept (latest-report reference data).

### v2.1 performance & upload robustness (lab-data loading guide)
- **Chunked uploads** — client sends 5 files/request, sequential; a failed
  batch is reported and later batches continue. Progress + totals shown.
- **Structured upload errors** — stable codes (FILE_COUNT_LIMIT,
  FILE_TOO_LARGE, UPLOAD_TIMEOUT, INVALID_XLSX, …) + actionable messages
  instead of a bare HTTP status.
- **Bounded memory** — lab path streams one file at a time (no longer
  buffers all 20); worksheets convert lazily with sheet/row caps.
- **Ingest-time lab summaries** — /api/rows reads three integer columns,
  not every tests_json blob; full report stays on the dedicated endpoint.
- **Lab dedupe** — exact (filename, sha256) re-upload is a no-op (no
  re-parse/rewrite/write-back/SSE); a different file for the same MR still
  replaces the old report.
- **Coalesced write-back** — overlapping v1 exports collapse into one;
  unique temp file; graceful-shutdown flush. SSE fires immediately (clients
  read SQLite); the legacy file export is background work.
- **Lazy archived loading** — initial page transfers active + a tiny count;
  the archived list loads once on first Archived-tab open.
- **gzip/br** on JSON payloads; stable row handler identity so memoized
  body rows skip re-render during drags/edits.

### v2.1.1 correctness fixes (review round 2)
- **Staged lab commits** — a lab upload now runs in two phases: (1) stream
  + parse + dedupe with NO transaction open (an overlapping request can no
  longer roll back another request's in-flight transaction — the old code
  held `BEGIN` across the whole multipart stream), then (2) one short
  synchronous commit of everything staged (no network await inside, so the
  event loop can't interleave mid-transaction). A mid-chunk DB failure
  rolls back that transaction only: nothing from the batch persists, the
  response's "nothing was saved" is true, and no change event fires. A
  duplicate that only appears at commit (concurrent identical upload) is
  demoted per-row instead of failing the chunk.
- **Write-back failure semantics** — a failed export stays PENDING (not
  silently dropped): the queue records `lastError`, exposes `pending` /
  `lastError` in `/api/health`, retries on the next change after one quiet
  window (no hot-spin), and `settle()` REJECTS over unresolved work so
  shutdown logs "v1 file may be stale" instead of exiting clean.
- **Shared per-row write coordinator** — checklist chips, field edits,
  archive toggles and ASO saves all advance the same server row revision
  and now share ONE per-row rev map + ONE per-row promise chain. A
  successful write from any control updates the shared rev, so a delayed
  response from one control can no longer make another control self-409.
  Server-side `toggle` on the check endpoints (the server flips its own
  current value) makes rapid same-chip double-clicks compose correctly
  even from a stale render; stale-rev 409s are preserved for genuine
  cross-device conflicts. Successful loads RECONCILE the rev source with
  the loaded rows (never blind-clear), and the rev fallback is the freshly
  loaded row — never a click-time snapshot — so a refresh landing between
  queued writes can't lose the queued write.

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
