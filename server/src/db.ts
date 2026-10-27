import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { labAbnormal } from './core/parsers.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * One-time backfill (v2.1): recompute the lab summary columns from the
 * stored tests_json so pre-existing databases serve the same numbers from
 * the cheap integer columns as the old tests_json parsing did.
 */
function backfillLabCounts(db: DatabaseSync): void {
  const rows = db.prepare('SELECT mr, tests_json FROM labs').all() as {
    mr: string;
    tests_json: string;
  }[];
  const up = db.prepare(
    'UPDATE labs SET test_count = ?, abnormal_count = ?, kritis_count = ? WHERE mr = ?',
  );
  db.exec('BEGIN');
  let total = 0;
  let abnormal = 0;
  let kritis = 0;
  for (const r of rows) {
    let tests: { hasil?: string; normal?: string; keterangan?: string }[] = [];
    try {
      const v: unknown = JSON.parse(r.tests_json || '[]');
      tests = Array.isArray(v) ? (v as typeof tests) : [];
    } catch {
      /* corrupt blob: keep zeros — the row's full report was unreadable too */
    }
    const t = tests.length;
    const a = tests.filter((x) => labAbnormal(x.hasil ?? '', x.normal ?? '')).length;
    const k = tests.filter((x) =>
      String(x.keterangan ?? '').toLowerCase().includes('dilaporkan'),
    ).length;
    up.run(t, a, k, r.mr);
    total += t;
    abnormal += a;
    kritis += k;
  }
  db.exec('COMMIT');
  // openDb runs before the Fastify logger exists — console is the channel.
  console.log(
    `[openDb] lab summary backfill: ${rows.length} row(s), ${total} tests, ` +
      `${abnormal} abnormal, ${kritis} critical`,
  );
}

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
  // v2.1: lab summary columns (ingest-time counts; backfilled once).
  const labCols = db.prepare("PRAGMA table_info(labs)").all() as { name: string }[];
  if (!labCols.some((c) => c.name === 'test_count')) {
    db.exec('ALTER TABLE labs ADD COLUMN test_count INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE labs ADD COLUMN abnormal_count INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE labs ADD COLUMN kritis_count INTEGER NOT NULL DEFAULT 0');
    backfillLabCounts(db);
  }
  return db;
}
