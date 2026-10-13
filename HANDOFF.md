# HANDOFF — continue here (P6: Lab)

## State
P0–P5 complete, committed & pushed (see `git log --oneline`). Repo:
`github.com/talentjams-zzz/rekap-visite` (private), branch `main`.
v1 frozen at `/home/rezza/projects/rekap-visite-nusin` (baseline `1d95642`).

## Run
```
pnpm install
pnpm dev        # server :8787 + web :5173 (proxied)
pnpm test       # 57 Vitest unit tests (server)
pnpm migrate    # one-shot v1 JSON -> data/rekap.db (auto-migration also runs on server start/poll)
```

## P6 scope (Lab)
Server: `POST /api/rows/:id/lab` (multipart lab xlsx) → `parseLabFile`
(already ported + unit-tested in `server/src/core/parsers.ts`) → replace
`labs` row (keyed by MR, latest wins) → SSE broadcast. Expose lab summary in
UI row (maxDate, abnormal/kritis counts, ASO due).
Web: lab cell per row → expandable findings table (jenis section headers,
abnormal red, kritis badge, komentar), copy-to-clipboard, ASO stop-date
warnings + "ASO ⚠" filter, archived rows read-only.
v1 reference: `reference/v1/index.html` parseLabFile/labAbnormal/asoDue*
(~lines 1595–1905) and `reference/v1/test_lab*.py`, `test_aso*.py`.

## Test-environment quirks (learned the hard way)
- Real data is local-only (gitignored PHI): `master_data.json`, `data/*.xlsx`.
- Scratch-server test pattern:
  `REKAP_MASTER=/tmp/t/master.json REKAP_DB=/tmp/t/rekap.db PORT=879x REKAP_POLL_MS=0 node server/dist/index.js`
  (cp master_data.json to /tmp first; never mutate the real file's version).
- Playwright: `PYTHONPATH=/home/rezza/.local/lib/python3.14/site-packages python3.14 script.py`
  - use `wait_until="load"` (SSE keeps `networkidle` from ever firing)
  - React `onBlur` needs a REAL blur: `locator.blur()` — `dispatch_event("blur")` does NOT fire it (React listens to focusout)
  - Clipboard: headless needs `ctx.grant_permissions(["clipboard-read","clipboard-write"], origin=...)` or copy falls back and fails
  - Generate test .xlsx files from `server/` dir (xlsx dep lives in that workspace)
  - Archived tab has Facility column at position 4; MR is `td:nth-child(3)` in all tabs
- Kill scratch servers by PID (`ss -ltnp | grep PORT`), never `pkill -f` with a
  pattern that appears in your own command line (it kills your own shell).
- pnpm: xlsx/fastify-multipart deps live in `server/` workspace — require()
  from there, not the root.
- Automated checkers flag `${}` in SQL → use fixed SQL constant tables (see
  `interactions.ts FIELD_SQL`).

## Conventions
- v1 behavior is FROZEN (reference/v1/SPEC.md = contract); v2 adds structure, not features.
- Every phase ends: tests green + commit + push. Optimistic UI updates + reload on API failure.
- `nowTs()` format everywhere: `YYYY-MM-DD HH:MM:SS` (client or server clock).

