-- Rekap Visite v2 — SQLite schema (schema_version 1)
-- Mirrors the v1 master_data.json shape (see reference/v1/SPEC.md).

CREATE TABLE IF NOT EXISTS patients (
  id               TEXT PRIMARY KEY,          -- "{mr}_{facility}" (v1 row id)
  mr               TEXT NOT NULL,
  facility         TEXT NOT NULL,             -- nusin | melati | sakura | observasi
  date_added       TEXT,                      -- latest report date containing this patient
  tgl_registrasi   TEXT,                      -- full registration timestamp "YYYY-MM-DD HH:MM:SS"
  nama             TEXT,
  umur             TEXT,
  kamar            TEXT,
  bed              TEXT,
  dokter           TEXT,
  diagnosis        TEXT,
  operan           TEXT,
  terapi           TEXT,
  pharmacist_note  TEXT,
  soap             TEXT,                        -- daily free text; cleared on day advance (v2 feature)
  aso_json         TEXT NOT NULL DEFAULT '[]',  -- [{id,name,stopDate,stopped,stoppedAt}] (v1 row.aso)
  rev              INTEGER NOT NULL DEFAULT 0,  -- optimistic-concurrency revision (bumped on every row write)
  archived         INTEGER NOT NULL DEFAULT 0,
  archived_at      TEXT,
  last_seen        TEXT,
  UNIQUE (mr, facility)
);

-- Riwayat: one snapshot per day the patient appeared (newest first in app)
CREATE TABLE IF NOT EXISTS patient_days (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id      TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  report_date     TEXT NOT NULL,
  tgl_registrasi  TEXT,
  nama            TEXT,
  umur            TEXT,
  kamar           TEXT,
  bed             TEXT,
  dokter          TEXT,
  diagnosis       TEXT,
  operan          TEXT,
  terapi          TEXT,
  soap            TEXT,                         -- that day's SOAP (moved here when the day advances)
  pharmacist_note   TEXT,                         -- v2: note snapshotted on readmission
  visite            TEXT,                         -- v2: per-visit patient checklist state that day
  pto               TEXT,
  konseling         TEXT,
  rekonsiliasi_obat TEXT,
  penelusuran_obat  TEXT,
  UNIQUE (patient_id, report_date)
);
CREATE INDEX IF NOT EXISTS idx_patient_days_patient ON patient_days (patient_id);

-- Per-row checklist (3 items; telaah_resep + pio reset daily per v1 rules)
CREATE TABLE IF NOT EXISTS row_checklist (
  patient_id  TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  item_key    TEXT NOT NULL,   -- telaah_resep | catatan_pengobatan | pio
  checked_at  TEXT,
  PRIMARY KEY (patient_id, item_key)
);

-- Per-patient checklist (5 lifetime items, keyed by MR only — v1 patientChecklist)
CREATE TABLE IF NOT EXISTS patient_checklist (
  mr          TEXT NOT NULL,
  item_key    TEXT NOT NULL,   -- visite | pto | konseling | rekonsiliasi_obat | penelusuran_obat
  checked_at  TEXT,
  PRIMARY KEY (mr, item_key)
);

-- Daily logs of row-checklist activity (v1 telaahLog / catatanLog / pioLog)
CREATE TABLE IF NOT EXISTS daily_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  item_key    TEXT NOT NULL,
  date        TEXT NOT NULL,
  ts          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daily_logs_patient ON daily_logs (patient_id);

-- One lab report per MR, latest wins (v1 labResults[mr])
CREATE TABLE IF NOT EXISTS labs (
  mr          TEXT PRIMARY KEY,
  filename    TEXT,
  loaded_at   TEXT,
  max_date    TEXT,
  tests_json  TEXT NOT NULL
);

-- Latest input timestamp per facility — drives auto archive/unarchive (v1 facilityLatestInput)
CREATE TABLE IF NOT EXISTS facility_latest_input (
  facility    TEXT PRIMARY KEY,
  input_ts    TEXT
);

-- Monthly maintenance runs (v1 lastMaintenance field)
CREATE TABLE IF NOT EXISTS maintenance_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at         TEXT NOT NULL,   -- "YYYY-MM-DD HH:MM:SS"
  trigger        TEXT NOT NULL,   -- manual | scheduled
  backup_file    TEXT NOT NULL,
  rows_before    INTEGER NOT NULL,
  rows_after     INTEGER NOT NULL,
  removed_rows   INTEGER NOT NULL,
  removed_checklist INTEGER NOT NULL,
  removed_lab    INTEGER NOT NULL
);

-- Every accepted Excel upload (audit + idempotency)
CREATE TABLE IF NOT EXISTS uploads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  filename     TEXT NOT NULL,
  facility     TEXT NOT NULL,
  report_date  TEXT NOT NULL,
  sha256       TEXT,
  uploaded_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
