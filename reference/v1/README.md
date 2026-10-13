# Rekap Visite Multicentre

Single-file web app for a clinical pharmacist to track patient visit activities
across daily Excel reports from 4 inpatient facilities: **Nusin, Melati, Sakura,
Observasi**.

No build step, no server. Open `index.html` in Chrome or Edge and work.

## Quick start

1. Open `index.html` in **Chrome or Edge** (File System Access API is required
   for in-place saving; Firefox/Safari/Android fall back to download-on-save).
2. Click **📂 Open Master Data** to load a previous master file, or
   **📄 Load Excel Files** to add new daily data.
3. Click **💾 Save All Data** to write everything to the bound master file
   (`master_data.json` by default) **in place** — one file, overwritten on
   every save. This is what lets a cloud-synced folder (Google Drive, …) keep
   all your devices in sync. Click **📦 Export Snapshot** for an optional
   timestamped backup copy: `rekap-visite-master-YYYY-MM-DD-HH-MM-SS.json`.

> The app remembers which master file it last saved (handle stored in
> IndexedDB). On the next page open it auto-loads that file — no click needed.
> If the file was moved/renamed, an amber banner offers "Reconnect".

## Multi-device (Google Drive / OneDrive / …)

Because **💾 Save All Data** overwrites a single fixed file, you can keep that
file in a cloud-synced folder and use the app on several devices without moving
anything:

1. Put `master_data.json` in a synced folder (e.g. a **Google Drive** folder
   synced with *Drive for desktop*).
2. On each device, open the app once and **📂 Open Master Data** → pick that
   same `master_data.json`. From then on it auto-loads there too.
3. Save on any device → the sync client pushes the update to the others.
   Re-open (or reload) the app on another device to pick up the change.

- **Windows / macOS:** *Drive for desktop* → the folder is a normal local
  folder; set it to **"Always keep on this device"** so it's a real file on
  disk (not online-only).
- **Linux:** no official Drive client — use `rclone` or a FUSE mount
  (`google-drive-ocamlfuse`) to expose the folder locally.
- **Android:** Chrome on Android has no File System Access API, so saving
  **downloads** `master_data.json` — upload it back to the Drive folder to
  push it to the other devices. Loading still works via the file picker.


## Multi-device (server — live sync, no reload)

For full **live sync** (devices update automatically, no reload) and
**conflict-safe saves** across Windows / Linux / **Android**, run the bundled
server on an always-on PC and connect the devices over Tailscale. See
**[SETUP-WINDOWS.md](SETUP-WINDOWS.md)** for the step-by-step guide.

- `server.js` — zero-dependency Node server (stores the data, versioned saves,
  Server-Sent Events for live sync).
- The app auto-detects **server mode** when served over http and uses the server
  API instead of local files. Opened as `file://` it keeps the local-file mode.

## Monthly backup + cleanup (server mode)

The server runs a built-in monthly job — no cron or extra setup. On the **1st
of each month at 00:05** (or on demand via the **🧹 Monthly Cleanup** button):

It runs **only at that scheduled moment** — starting the server mid-month (or
for the first time) never triggers it. If the server is down on the 1st, that
month's run is skipped (use the button).

1. **Backs up** the whole `master_data.json` (active + archived) to a
timestamped `rekap-visite-master-….json` next to the data file.
2. **Verifies** the backup (valid JSON, same row count) — if it fails,
   **nothing is removed**.
3. **Removes** all archived patients (active patients are kept), plus their
   leftover per-patient checklist/lab data. The change live-syncs to all open
devices.

The run is logged in the data file's `lastMaintenance` field and shown in the
🧹 top-bar badge. Backups are **never auto-deleted** — they're the only copy of
removed patients. If a removed patient reappears in a later Excel file they
return as a new row (fresh history); the old history is in the backup.

Env: `MONTHLY_CLEANUP` (default `1`; `0` disables the automatic job),
`MONTHLY_CLEANUP_TIME` (default `"00:05"`, local HH:MM),
`MONTHLY_CLEANUP_DAY` (default `1`, day of month).

## Old-format files (auto-migration)

Older master files (e.g. `rekapitulasi-*.json`) stored **one row per patient
per day** (id `{MR}_{date}_{facility}`, no `history`/`telaahLog`). The app
detects this on load and converts it in place to the current format:

- one row per `{MR, facility}` (latest day wins for data fields, latest
  non-empty value per field)
- every day preserved in `history` (Riwayat button)
- past-day Telaah Resep checks archived in `telaahLog` (Rekap keeps them)
- latest-day Telaah Resep kept as the live checklist

Just open an old file with **📂 Open Master Data** — it converts automatically
and a toast confirms it. Save afterwards to persist the new format (as a new
timestamped file).

## Daily workflow

1. Export the day's Excel files from the EMR into `data/` (or keep them
   wherever you like — the picker finds them).
2. Click **📄 Load Excel Files** and select the day's files (multi-select).
   - Registry files: `nusin DD-M-YY.xlsx`, `melati-...`, `sakura-...`,
     `observasi-...`
   - Handover files (Nusin only): `operan nusin DD-M-YY.xlsx`
3. The report date is read **from the filename**, so you can load several days
   at once and each day keeps its own history.
4. Tick checklist items, add pharmacist notes, archive discharged patients.
5. **💾 Save All Data**.

## Data model

- **One row per patient per facility**, keyed by `{MR, facility}`.
- When the same MR appears in a later daily file, the row is **updated in
  place** (latest file wins for name/age/room/bed/doctor/diagnosis/operan/
  terapi). Pharmacist notes and archive status are never touched by a merge.
- **Telaah Resep resets daily**: when a patient appears in a *later* day's
  file, the previous day's Telaah Resep check is cleared (it's a daily task).
  Re-importing the same day's file keeps the check; loading an older file out
  of order doesn't clear it either. The other 5 checklist items are per-patient
  and persist across merges.
- **Rekap keeps past work**: a cleared Telaah Resep check is archived in the
  row's `telaahLog`, so the Rekap Checklist tab still shows the previous day's
  completed telaah under its own date — the daily reset never erases history.
- **Daily history**: every day a patient appears, a snapshot is stored in the
  row's `history` array. The main row always shows the latest day; the
  **"Riwayat (N)"** button in the Tgl Input column expands an inline table of
  every day the patient appeared.
- `dateAdded` = the date of the most recent file that contained the patient
  (taken from the filename).

### Checklist (6 items)

| Item | Scope |
|---|---|
| Telaah Resep | per row (daily — auto-cleared when a later day's file is loaded) |
| Penelusuran Obat | per patient MR (persists across all rows) |
| Rekonsiliasi Obat | per patient MR |
| Visite | per patient MR |
| PTO | per patient MR |
| Konseling | per patient MR |

Each checkbox stores its own timestamp (`YYYY-MM-DD HH:MM:SS`).

## Tabs

- **Nusin / Melati / Sakura / Observasi** — active patients per facility.
  Nusin shows Diagnosis/Operan/Terapi; the others don't.
- **Archived** — with facility dropdown + Tgl Registrasi date-range filter.
- **Rekap Checklist** — daily breakdown of completed items, with "Copy MRs".

## Testing

Playwright-based verification scripts (`test_*.py`) drive the real app in a
headless browser. `conftest.py` starts `server.js` on port 8765 with an isolated
data file for the session, so the tests never touch your real `master_data.json`.

```bash
python3 -m pytest test_*.py -v
```

Requires `node` (for `server.js`) and the Playwright Chromium browser
(`python3 -m playwright install chromium`).

## Files

| File | Purpose |
|---|---|
| `index.html` | The app (single file) |
| `server.js` | Zero-dependency Node server (versioned saves + SSE live sync) |
| `xlsx.full.min.js` | SheetJS 0.20.3, bundled locally (no CDN / works offline) |
| `conftest.py` | Test harness — starts the server on :8765 for the pytest session |
| `test_*.py` | Playwright verification scripts (run with `python3 -m pytest test_*.py -v`) |
| `data/` | Daily Excel reports (**PHI — not in git**) |
| `master_data.json` | The live master state file — **💾 Save All Data** overwrites it in place (**PHI — not in git**) |
| `rekap-visite-master-*.json` | Optional timestamped backup copies from **📦 Export Snapshot** (**PHI — not in git**) |
| `SPEC.md` | Full specification |
| `PLAN.md` | Multi-facility upgrade plan |
| `Rekap-Visite.html` | Older snapshot (superseded by `index.html`) |

## Notes

- **Privacy**: `data/` and all master files (`rekap-visite-master-*.json`,
  `master_data.json`) contain PHI and are excluded from git via `.gitignore`.
- **Offline**: SheetJS is bundled, so the app works without internet.
- **Browser**: Chrome/Edge recommended. Firefox/Safari can load and edit but
  save via download instead of in-place write.
