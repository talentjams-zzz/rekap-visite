import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function openDb(file: string): DatabaseSync {
  // A fresh checkout has no data/ dir (gitignored) — create the parent so a
  // first `pm2 start` doesn't crash with "unable to open database file".
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // Wait up to 5 s for a locked database instead of failing instantly
  // (guards against a second process touching the same file).
  db.exec('PRAGMA busy_timeout = 5000;');
  const schema = readFileSync(path.join(here, '..', 'schema.sql'), 'utf8');
  db.exec(schema);
  // Lightweight column upgrades for databases created before a column existed
  // (CREATE TABLE IF NOT EXISTS does not add columns to existing tables).
  const cols = db.prepare("PRAGMA table_info('patients')").all() as { name: string }[];
  if (!cols.some((c) => c.name === 'aso_json')) {
    db.exec("ALTER TABLE patients ADD COLUMN aso_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!cols.some((c) => c.name === 'rev')) {
    db.exec('ALTER TABLE patients ADD COLUMN rev INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.some((c) => c.name === 'soap')) {
    db.exec('ALTER TABLE patients ADD COLUMN soap TEXT');
  }
  // patient_days predates SOAP on existing databases.
  const dayCols = db.prepare('PRAGMA table_info(patient_days)').all() as { name: string }[];
  if (!dayCols.some((c) => c.name === 'soap')) {
    db.exec('ALTER TABLE patient_days ADD COLUMN soap TEXT');
  }
  // v2 readmission snapshots: note + per-visit patient checklist per day.
  const dayNewCols: Array<[string, string]> = [
    ['pharmacist_note', 'ALTER TABLE patient_days ADD COLUMN pharmacist_note TEXT'],
    ['visite', 'ALTER TABLE patient_days ADD COLUMN visite TEXT'],
    ['pto', 'ALTER TABLE patient_days ADD COLUMN pto TEXT'],
    ['konseling', 'ALTER TABLE patient_days ADD COLUMN konseling TEXT'],
    ['rekonsiliasi_obat', 'ALTER TABLE patient_days ADD COLUMN rekonsiliasi_obat TEXT'],
    ['penelusuran_obat', 'ALTER TABLE patient_days ADD COLUMN penelusuran_obat TEXT'],
  ];
  for (const [col, ddl] of dayNewCols) {
    if (!dayCols.some((c) => c.name === col)) db.exec(ddl);
  }
  return db;
}
