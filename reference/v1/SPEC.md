# SPEC — Rekap Visite Multicentre

## Overview
Single self-contained HTML file for a clinical pharmacist to track patient visit
activities across daily Excel reports from **4 inpatient facilities: Nusin,
Melati, Sakura, Observasi**. All patient data keyed by unique `No. Rekam Medis`
(MR number), merged across multiple daily Excel uploads and multiple months.

The app runs in two modes:
- **Local-file mode** (opened as `file://`) — master data lives in a bound
  `master_data.json` via the File System Access API (Chrome/Edge).
- **Server mode** (served over http by the bundled `server.js`) — master data
  lives on the server with optimistic-concurrency versioning and Server-Sent
  Events for live sync across devices. The app auto-detects the mode from the
  page protocol.

## Data Model

### One row per patient (merged across days)
Each patient has **exactly one row per facility**. When the same MR appears in multiple daily Excel files, the rows **merge** into that single row — the latest file wins for every data field (name, age, room, bed, doctor, diagnosis, operan, terapi). Pharmacist notes and archive status are never touched by a merge. **Telaah Resep is a daily task**: when a patient appears in a later day's file (dateAdded advances), the previous day's Telaah Resep check is automatically cleared. Re-importing the same day's file keeps the check (idempotent), and loading an older file out of order does not clear it. `dateAdded` is updated to the date of the most recent file that contained the patient.

### Daily history (all days preserved)
Merging never discards a day's data. Every day a patient appears, a snapshot of that day's fields is stored in the row's `history` array (one entry per `dateAdded`, newest first). The main row always shows the **latest** day; the **"Riwayat (N)"** button in the Tgl Input column expands an inline table listing **every day** the patient appeared, with that day's Tgl Reg, Nama, Umur, Kamar, Bed, Dokter, Diagnosis, Operan, and Terapi. So yesterday's data is never lost — it stays visible under the merged row.

### Source — Excel files (in `data/` directory)
Two types, uploaded daily, for **4 facilities** (Nusin, Melati, Sakura, Observasi):

**Registry file** (`{facility} DD-M-YY.xlsx`, e.g. `nusin 25-8-26.xlsx`, `melati-26-08-26.xlsx`):
- Tgl Registrasi, No Registrasi, No. Rekam Medis, Nama Pasien, Tgl Lahir, Umur, Dokter, Dokter Tambahan, Jenis Kelamin, Tipe Pembayaran, Kelas, Kamar, Bed, Lama Rawat, Kondisi Klinis, Verif Farmasi

**Handover file** (`operan {facility} DD-M-YY.xlsx`, e.g. `operan nusin 25-8-26.xlsx`) — **Nusin only**:
- Kamar, Bed, NAMA, MEDREC, DPJP, DIAGNOSA, OPERAN, TERAPI

**Facility detection**: the facility is read from the filename (lowercased) by
matching the keywords `nusin` / `melati` / `sakura` / `observasi`. A filename
containing `operan` is treated as that facility's handover file. A file with no
recognized facility keyword is skipped with a warning. The report date is read
from the filename (`DD-M-YY`), so several days can be loaded at once and each
day keeps its own history.

### How rows are built
1. Parse registry file → extract base patient fields per MR
2. Parse handover file → match by MR → merge diagnosis/operan/terapi into the same row
3. Each row gets a `dateAdded` (the date of the most recent Excel file that contained the patient)
4. Rows are keyed by `{MR, facility}` — one row per patient per facility; later files merge into it

### Auto archive / unarchive (based on latest input data)
A patient is **active** iff they appear in their facility's **latest input**.
"Latest input" is the newest **input timestamp** for that facility — NOT just the
date. This is what makes several uploads on the **same date** work: the most
recent upload is the latest input, and a patient who moved out (present in an
earlier same-day file but absent from the newest one) is archived, while a
patient still in the newest file stays active.

After **every** Excel load the app re-syncs all rows:
- A patient **missing** from the latest input is **automatically archived**
  (`archived = true`, `archivedAt` set).
- An **already-archived** patient who **reappears** in the latest input is
  **returned to active** (`archived = false`, `archivedAt` cleared).

**Input timestamp** = the file's **filename date** (the logical report date) +
the file's **last-modified time**. The date part dominates the comparison, so a
later day always wins even if its file was saved earlier than an older day's
file; the time part breaks ties within the same date, so the newest same-day
upload wins. Each row records its own `lastSeen` input timestamp (only ever
advances, never rolls back). "Latest" per facility is the max row `lastSeen`,
**overridden by the latest input timestamp loaded for that facility** (tracked
in `facilityLatestInput`, persisted in the master JSON). The tracked value
advances even when a facility's latest file has **zero patients** (an empty
daily report), which is what correctly archives patients who are no longer in
that facility. Loading an **older** file out of order never wrongly archives
current patients. Manual archive/unarchive via the row button is respected until
the next Excel load re-syncs. The load toast reports how many were archived /
returned to active.

### Monthly maintenance (server mode): backup, then remove archived patients
The server runs a built-in monthly job — no cron or external scheduler needed.
It fires **on the 1st of each month at 00:05 local time** (configurable via
`MONTHLY_CLEANUP_TIME` / `MONTHLY_CLEANUP_DAY`), or **on demand** via the
**🧹 Monthly Cleanup** button (top bar, server mode only) /
`POST /api/maintenance/run`. It runs **only at that scheduled moment** while
the server is up — a first-time or mid-month startup never triggers it; if the
server is down on the 1st, that month's run is skipped (use the button). The
job, in order:

1. **Backup first** — writes a full copy of `master_data.json` (active +
   archived, everything) as `rekap-visite-master-YYYY-MM-DD-HH-MM-SS.json`
   (local time) next to the data file — same naming as Export Snapshot.
2. **Verify** — reads the backup back and checks it (valid JSON, same row
   count). If verification fails, **nothing is removed** and the failure is
   logged.
3. **Remove** — only after a verified backup: all rows with `archived = true`
   are deleted, plus **orphaned per-MR data** — `patientChecklist` entries and
   `labResults` for MRs that no longer have any row. Active patients are
   untouched. The write is atomic (temp file + rename), the version bumps, and
   the SSE stream pushes the change to all open devices (they refresh
   automatically).
4. **Log** — records the run in the data file's `lastMaintenance` field
   (`ranAt`, `trigger` = scheduled/manual, `backupFile`,
   `rowsBefore`/`rowsAfter`, `removedRows`, `removedChecklist`, `removedLab`,
   `sizeBefore`/`sizeAfter`). The top bar shows a **🧹 badge** with the last
   run (full details in the tooltip). The server owns this field: client saves
   preserve it (clients don't send it back).

Backups are **never auto-deleted** — they are the only copy of removed
patients. If a removed patient reappears in a later Excel file, they come back
as a **new row** (fresh history); the old history lives in the monthly backup.
Env: `MONTHLY_CLEANUP` (default `1`; `0` disables the automatic job — the
manual button still works), `MONTHLY_CLEANUP_TIME` (default `"00:05"`, local
HH:MM), `MONTHLY_CLEANUP_DAY` (default `1`, day of month).

### Hasil Lab (lab results, per patient)
A **Hasil Lab** column sits between **Terapi** and **Checklist**. Lab reports are
loaded per patient from `lab-{MR}.xlsx` (MR parsed from the filename) via the
**🧪 Load Lab Results** button. The **latest** report for an MR **completely
replaces** the previous one (no merge). Reports are stored in a per-MR map
(`labResults`) and persisted in the master JSON.

Each report's test rows are read from the sheet that contains the
`Nama Pemeriksaan` header row — the parser scans **all** sheets, not just the
first. (Updated exports sometimes add a cover/summary sheet before the data
sheet; reading only sheet[0] made those files fail to parse and get skipped,
leaving the old result in place.) Columns read: `Nama Pemeriksaan`,
`Hasil Pemeriksaan`, `Komentar`, `Nilai Normal`, `Satuan`, `Keterangan`,
`Tanggal Hasil`. The test category from column A (`Jenis: X` markers) is stored
per test and shown as **Excel-like section header rows** in the expanded table —
one full-width "Jenis: X" banner per section (not a column), shown only for
sections that still have at least one visible test after filtering.
Indications:
- **Abnormal** — a test whose numeric result falls outside its numeric
  `Nilai Normal` range/bound is shown in **red**. Text values (`Negatif`,
  `Kuning`, `MRR`, …) are never flagged. **eGFR** is special-cased: its normal
  value is always overridden to `>60` (abnormal when the result is < 60).
  **GD (POCT)** tests (Sewaktu / 2 Jam PP) are always overridden to `70 - 139`.
- **Lab Kritis** — a test whose `Keterangan` contains **"dilaporkan"** is marked
  critical: a red **"⚠ Lab Kritis"** badge appears at the top of the cell, the
  row is highlighted red, and a red **"LK"** is shown just after the test value.

The cell shows a compact summary (latest `Tanggal Hasil`, `N tests · M abnormal
[· K kritis]`) with a **Hasil Lab** button that expands the full report table
inline (same pattern as Riwayat). The expanded table has **Abnormal** and
**Kritis** filter buttons (union — a test is shown if it matches any active
filter); section headers collapse when a filter leaves a section empty. A
**📋 Copy** button next to the title copies the currently-visible (filtered)
tests to the clipboard as `Test name Value` per line. The trailing `REPORT`
footer row in the Excel is not treated as a test — **unless it carries data**:
in the **Resistensi** (antibiotic-resistance) section the finding is stored in
a `REPORT` row with the result text in the Komentar column (e.g. `Extended
Spectrum Beta Lactamase(ESBL)`). Such rows are kept and shown as a "Resistensi"
test under their `Jenis: Resistensi …` section. (Dropping them is what made an
updated file whose only new content was a resistensi finding parse to the same
report as the old one, so the "full replace" appeared to do nothing.)

The expanded lab table has **7 columns** — Nama Pemeriksaan, Hasil, **Komentar**,
Nilai Normal, Satuan, Keterangan, Tanggal — and **every column is freely
resizable** (drag the right edge of a header, same mechanism as the main table).
Widths persist in `labColWidths` (localStorage + the master JSON), so they're
reusable across sessions and machines.

### Displayed columns per row
| Column | Source |
|---|---|
| Tanggal Registrasi | Registry |
| Tanggal Input | Date of the most recent Excel file that contained the patient |
| No. Rekam Medis | Registry / Handover |
| Nama Pasien | Registry / Handover |
| Kamar | Registry / Handover |
| Bed | Registry / Handover |
| Dokter | Registry / Handover |
| Umur | Registry |
| Diagnosis | Handover |
| Operan (notes) | Handover |
| Terapi | Handover |
| Hasil Lab | Lab file (`lab-{MR}.xlsx`), latest per MR wins |
| Checklist (7 items) | User input per row / per patient |
| Pharmacist Note | User input per row |
| Actions (Archive) | UI |

### Checklist items

**Per-row (daily — auto-cleared when a later day's file is loaded)**:
1. Telaah Resep — checked independently on each row; a new day's file resets it.
   The cleared check is archived in the row's `telaahLog` (one entry per date),
   so the Rekap Checklist tab keeps showing the previous day's completed telaah
   under its own date.

**Per-row (one-time — NOT reset by a later day's file)**:
2. Catatan Pengobatan — a one-time per-patient task stored on the row. It stays
   checked when a later day's file is loaded (unlike Telaah Resep). The cleared
   check is archived in the row's `catatanLog` so the Rekap tab keeps it.

**Per-patient (once per MR, persists across all rows for that patient)**:
3. Penelusuran Obat
4. Rekonsiliasi Obat
5. Visite
6. PTO
7. Konseling

Each checkbox stores its own independent timestamp (`YYYY-MM-DD HH:MM:SS`).
- Telaah Resep is scoped to the row (new row = fresh checkbox, daily reset)
- Catatan Pengobatan is scoped to the row but one-time (no daily reset)
- The other 5 items are scoped to the patient MR — checking on any row of MR=12345 marks it done for all rows of that patient. Timestamp stored once per MR.

## File I/O

### Master data file
Master JSON files live in the project directory (same dir as the HTML).
**"Save All Data"** overwrites the bound master file **in place** — a single
fixed file (`master_data.json` by default). This keeps every device bound to
the SAME file, so a cloud-synced folder (Google Drive / OneDrive / …) stays in
sync automatically. **"Export Snapshot"** writes an optional NEW timestamped
backup copy: `rekap-visite-master-YYYY-MM-DD-HH-MM-SS.json` (local time), next
to the bound file.

**On open**: The last saved state is loaded **automatically**. The app remembers which master file it last saved via a File System Access handle stored in IndexedDB; on page load it re-reads that file and restores all patient rows, checklist states, pharmacist notes, and archive status — no button click needed. If the file can't be found (moved/renamed) or permission is revoked, an amber banner offers "Reconnect master file".

**On "Save All Data"**: Overwrites the currently bound master file **in place** — one click, no download dialog, no new file. If no master file is bound yet, the save picker opens once with `master_data.json` pre-filled; every later save is silent. On browsers without the File System Access API (Android / Firefox / Safari) it downloads `master_data.json` instead.

**On "Export Snapshot"**: Creates `rekap-visite-master-YYYY-MM-DD-HH-MM-SS.json` next to the bound file (the previous "every save = new file" behaviour) without re-binding the app or touching the "last saved" badge.

**Manual load still available**: "Open Master Data" opens a picker and re-binds the app to whichever master file you choose (useful for switching between month backups or timestamped snapshots).

### Adding new daily data
- **"Load Excel Files"** button opens a file picker (multi-select). User selects one or more Excel files.
- `dateAdded` = the **filename date** of the most recent file that contained the patient (not "today"), so several days can be loaded at once.
- New patients get a new row. If the MR already has a row for that facility, the row is **updated in place** (latest file wins) — no duplicate rows.
- Checklist states, pharmacist notes, and archive status persist for all existing rows.

### JSON schema
```json
{
  "savedAt": "2026-08-25T20:00:00",
  "rows": [
    {
      "id": "656218_nusin",
      "mr": "656218",
      "facility": "nusin",
      "dateAdded": "2026-08-25",
      "lastSeen": "2026-08-25 14:30:00",
      "tglRegistrasi": "2026-08-24 09:15:00",
      "nama": "YUDHA AVIV PERMANA",
      "umur": "22 thn",
      "kamar": "317",
      "bed": "5",
      "dokter": "dr. Putri Anggiana Rahma Dewi, Sp.B.",
      "diagnosis": "Hemoroid Eksterna",
      "operan": "...",
      "terapi": "...",
      "hasilLab": null,
      "checklist": {
        "telaah_resep": "2026-08-25 14:30:00",
        "catatan_pengobatan": null
      },
      "pharmacistNote": "",
      "archived": false,
      "archivedAt": null,
      "telaahLog": [
        { "date": "2026-08-24", "ts": "2026-08-24 10:00:00" }
      ],
      "catatanLog": [],
      "history": [
        { "date": "2026-08-25", "tglRegistrasi": "2026-08-24 09:15:00", "nama": "YUDHA AVIV PERMANA", "umur": "22 thn", "kamar": "317", "bed": "5", "dokter": "dr. Putri Anggiana Rahma Dewi, Sp.B.", "diagnosis": "Hemoroid Eksterna", "operan": "...", "terapi": "..." }
      ]
    }
  ],
  "patientChecklist": {
    "656218": {
      "penelusuran_obat": "2026-08-25 15:00:00",
      "rekonsiliasi_obat": "2026-08-25 16:00:00",
      "visite": null,
      "pto": null,
      "konseling": null
    }
  },
  "labResults": {
    "656218": {
      "loadedAt": "2026-08-25 17:00:00",
      "maxDate": "2026-08-25 08:00:00",
      "tests": [
        { "nama": "Hemoglobin", "jenis": "Hematologi Lengkap", "hasil": "8.6", "komentar": "", "normal": "13.2 - 17.3", "satuan": "g/dL", "keterangan": "", "tanggal": "2026-08-25 08:00:00", "abnormal": true, "kritis": false },
        { "nama": "eGFR", "jenis": "eGFR", "hasil": "45.0", "komentar": "", "normal": ">60", "satuan": "mL/mnt/1.73m2", "keterangan": "", "tanggal": "2026-08-25 08:00:00", "abnormal": true, "kritis": false },
        { "nama": "APTT", "jenis": "APTT", "hasil": "47.00", "komentar": "", "normal": "14.00 - 36.00", "satuan": "detik", "keterangan": "Hasil telah dilaporkan via telepon ...", "tanggal": "2026-08-25 08:00:00", "abnormal": true, "kritis": true }
      ]
    }
  },
  "facilityLatestInput": {
    "nusin": "2026-08-25 14:30:00",
    "melati": "2026-08-25 14:28:00",
    "sakura": "2026-08-25 14:29:00",
    "observasi": "2026-08-25 14:27:00"
  },
  "colWidths": {
    "nama": 180,
    "diagnosis": 200
  },
  "labColWidths": {
    "nama": 160,
    "keterangan": 200
  },
  "lastMaintenance": {
    "ranAt": "2026-09-01 00:05:12",
    "trigger": "scheduled",
    "backupFile": "rekap-visite-master-2026-09-01-00-05-12.json",
    "rowsBefore": 120,
    "rowsAfter": 84,
    "removedRows": 36,
    "removedChecklist": 36,
    "removedLab": 22,
    "sizeBefore": 3500000,
    "sizeAfter": 2900000
  }
}
```

### Monthly JSON exports (optional)
User can export a month's slice as a separate JSON file for backup. These are never required for loading — the master file is the single source of truth.

## UI Layout

### Top bar
- Title: "Rekap Visite Multicentre"
- Buttons: [Open Master Data] [Load Excel Files] [Load Lab Results] [Save All Data] [Export Snapshot]
  - In server mode the "Open Master Data" button is hidden (data comes from the server).
- Badges: Archived count, last-saved time, and a connection badge (server mode only: 🟢 synced / 🟡 unsaved edits / 🔴 offline).
- Search box (filter by MR or patient name) with a match count.

### Tabs
- One tab per facility: **Nusin / Melati / Sakura / Observasi** (each shows its active-patient count).
- **Archived** (count) — with a Facility dropdown + Tgl Registrasi date-range filter.
- **Rekap Checklist** — daily breakdown of completed items, with "Copy MRs".

### Filter bar (facility tabs)
"Filter undone:" toggle buttons for each of the 7 checklist items — a row is shown only if it matches **none** of the active filters (i.e. it still has that item undone).

### Patient table
Sortable by clicking any column header (ascending → descending → default). Default sort: Tanggal Registrasi descending. **Tgl Reg stores the full registration timestamp** (date + time, as written in the source file, e.g. 2026-09-18 15:31:39), so sorting by it orders rows by date and then by time; the time is shown on a second line in the cell. Rows whose source had no time (older data) sort as 00:00:00 of that day.

**Resizable columns** — each column header has a drag handle on its right edge; drag to resize. Widths are sized to fit a 1080p (1920px) monitor by default and persist in `localStorage` **and** in the master JSON (`colWidths`), so they're reusable across sessions and machines. If the total table width exceeds the container (e.g. after widening columns, or on a smaller screen), the table scrolls horizontally (`.table-wrap` has `overflow-x: auto`).

Each row shows all columns. Checklist column contains 7 checkboxes, each with a timestamp label that appears when checked.

Pharmacist Note is an editable text area per row.

Archive button per row moves the patient to the archived view.

### Archived tab
Same table layout (plus a Facility column). Unarchive button per row restores to active view.

## Technical requirements
- **Single HTML file** — no build step. SheetJS (xlsx) is bundled locally (`xlsx.full.min.js`) so it works offline (no CDN).
- **Two data modes**:
  - *Local-file* (`file://`): the bound `master_data.json` is overwritten in place on "Save All Data"; "Export Snapshot" writes an optional timestamped copy.
  - *Server* (http via `server.js`): the server stores the master with a version number; saves are optimistic-concurrency (409 on conflict) and an SSE stream pushes live updates to other devices.
- **Browser**: Chrome/Edge (File System Access API required for local-file save).
- **Responsive**: Should work on desktop and tablet.

## Implementation status
Built (in order):
1. Parse Excel files (registry + handover), extract patient data, merge by `{MR, facility}`
2. Patient table with all columns, sorting, and resizable columns
3. Checklist with per-item timestamps (7 items: 2 per-row, 5 per-patient)
4. Pharmacist note text field
5. Archive/unarchive with facility tabs + Archived tab (facility + date-range filter)
6. JSON save/load (local-file in-place + Export Snapshot) with multi-file merge
7. Multi-facility upgrade (4 facilities, facility detection from filename)
8. Hasil Lab column (per-patient lab report, abnormal/kritis, section headers, filters, copy)
9. Riwayat (daily history) + Rekap Checklist tab
10. Server mode (`server.js`): versioned saves, optimistic concurrency, SSE live sync
11. Polish UI, styling, edge cases

## Testing
Playwright-based verification scripts (`test_*.py`) drive the real app in a
headless browser. `conftest.py` starts `server.js` on port 8765 with an isolated
data file for the session. Run: `python3 -m pytest test_*.py -v`.
