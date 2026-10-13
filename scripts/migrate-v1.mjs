#!/usr/bin/env node
// One-shot migration: v1 master_data.json -> v2 SQLite (data/rekap.db)
// Verifies counts against the source JSON; exits non-zero on mismatch.
// Re-run with --force to wipe and re-migrate.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcFile = path.join(root, 'master_data.json');
const dbFile = process.env.REKAP_DB || path.join(root, 'data', 'rekap.db');
const force = process.argv.includes('--force');

let src;
try {
  src = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
} catch (e) {
  console.error(`Failed to read/parse ${srcFile}: ${e.message}`);
  process.exit(1);
}
const rows = src.rows || [];

fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const tableExists =
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'patients' AND type = 'table'").get().c > 0;
if (tableExists) {
  const n = db.prepare('SELECT COUNT(*) c FROM patients').get().c;
  if (n > 0 && !force) {
    console.error(`DB already contains ${n} patients. Re-run with --force to wipe and re-migrate.`);
    process.exit(1);
  }
}

db.exec(fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8'));

const ROW_ITEMS = ['telaah_resep', 'catatan_pengobatan', 'pio'];
const LOG_FIELDS = { telaah_resep: 'telaahLog', catatan_pengobatan: 'catatanLog', pio: 'pioLog' };
const PATIENT_ITEMS = ['visite', 'pto', 'konseling', 'rekonsiliasi_obat', 'penelusuran_obat'];

db.exec('BEGIN');
try {
  for (const t of [
    'daily_logs', 'patient_days', 'row_checklist', 'patient_checklist',
    'labs', 'facility_latest_input', 'patients', 'uploads', 'meta',
  ]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }

  const insP = db.prepare(`
    INSERT INTO patients (id, mr, facility, date_added, tgl_registrasi, nama, umur, kamar, bed,
                          dokter, diagnosis, operan, terapi, pharmacist_note, archived, archived_at, last_seen)
    VALUES (:id, :mr, :facility, :dateAdded, :tglRegistrasi, :nama, :umur, :kamar, :bed,
            :dokter, :diagnosis, :operan, :terapi, :note, :archived, :archivedAt, :lastSeen)`);
  for (const r of rows) {
    insP.run({
      id: r.id,
      mr: r.mr,
      facility: r.facility,
      dateAdded: r.dateAdded ?? null,
      tglRegistrasi: r.tglRegistrasi ?? null,
      nama: r.nama ?? null,
      umur: r.umur ?? null,
      kamar: r.kamar ?? null,
      bed: r.bed ?? null,
      dokter: r.dokter ?? null,
      diagnosis: r.diagnosis ?? null,
      operan: r.operan ?? null,
      terapi: r.terapi ?? null,
      note: r.pharmacistNote ?? null,
      archived: r.archived ? 1 : 0,
      archivedAt: r.archivedAt ?? null,
      lastSeen: r.lastSeen ?? null,
    });
  }

  const insD = db.prepare(`
    INSERT INTO patient_days (patient_id, report_date, tgl_registrasi, nama, umur, kamar, bed,
                              dokter, diagnosis, operan, terapi)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) {
    for (const h of r.history || []) {
      insD.run(r.id, h.date, h.tglRegistrasi ?? null, h.nama ?? null, h.umur ?? null,
        h.kamar ?? null, h.bed ?? null, h.dokter ?? null, h.diagnosis ?? null,
        h.operan ?? null, h.terapi ?? null);
    }
  }

  const insRC = db.prepare('INSERT OR REPLACE INTO row_checklist (patient_id, item_key, checked_at) VALUES (?, ?, ?)');
  for (const r of rows) {
    for (const k of ROW_ITEMS) {
      const v = (r.checklist || {})[k];
      insRC.run(r.id, k, v ?? null);
    }
  }

  const insDL = db.prepare('INSERT INTO daily_logs (patient_id, item_key, date, ts) VALUES (?, ?, ?, ?)');
  for (const r of rows) {
    for (const [item, field] of Object.entries(LOG_FIELDS)) {
      for (const e of r[field] || []) insDL.run(r.id, item, e.date, e.ts);
    }
  }

  const insPC = db.prepare('INSERT OR REPLACE INTO patient_checklist (mr, item_key, checked_at) VALUES (?, ?, ?)');
  for (const [mr, items] of Object.entries(src.patientChecklist || {})) {
    for (const k of PATIENT_ITEMS) {
      const v = (items || {})[k];
      if (v !== undefined) insPC.run(mr, k, v ?? null);
    }
  }

  const insL = db.prepare('INSERT OR REPLACE INTO labs (mr, filename, loaded_at, max_date, tests_json) VALUES (?, ?, ?, ?, ?)');
  for (const [mr, lab] of Object.entries(src.labResults || {})) {
    insL.run(mr, lab.filename ?? null, lab.loadedAt ?? null, lab.maxDate ?? null,
      JSON.stringify(lab.tests ?? []));
  }

  const insF = db.prepare('INSERT OR REPLACE INTO facility_latest_input (facility, input_ts) VALUES (?, ?)');
  for (const [f, ts] of Object.entries(src.facilityLatestInput || {})) insF.run(f, ts);

  const insM = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  insM.run('schema_version', '1');
  insM.run('migrated_at', new Date().toISOString());
  insM.run('source_saved_at', src.savedAt ?? '');
  insM.run('source_version', String(src.version ?? ''));
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

// ---- Verification against source JSON ----
const count = (sql) => db.prepare(sql).get().c;
const checks = [
  ['patients', count('SELECT COUNT(*) c FROM patients'), rows.length],
  ['patient_days (riwayat)', count('SELECT COUNT(*) c FROM patient_days'),
    rows.reduce((a, r) => a + (r.history?.length || 0), 0)],
  ['labs', count('SELECT COUNT(*) c FROM labs'), Object.keys(src.labResults || {}).length],
  ['row_checklist checked', count('SELECT COUNT(*) c FROM row_checklist WHERE checked_at IS NOT NULL'),
    rows.reduce((a, r) => a + ROW_ITEMS.filter((k) => (r.checklist || {})[k]).length, 0)],
  ['patient_checklist checked', count('SELECT COUNT(*) c FROM patient_checklist WHERE checked_at IS NOT NULL'),
    Object.values(src.patientChecklist || {}).reduce(
      (a, items) => a + PATIENT_ITEMS.filter((k) => (items || {})[k]).length, 0)],
  ['daily_logs', count('SELECT COUNT(*) c FROM daily_logs'),
    rows.reduce((a, r) => a + Object.values(LOG_FIELDS).reduce((b, f) => b + ((r[f] || []).length), 0), 0)],
  ['archived patients', count('SELECT COUNT(*) c FROM patients WHERE archived = 1'),
    rows.filter((r) => r.archived).length],
  ['facility_latest_input', count('SELECT COUNT(*) c FROM facility_latest_input'),
    Object.keys(src.facilityLatestInput || {}).length],
];

let ok = true;
for (const [name, got, want] of checks) {
  const pass = got === want;
  ok = ok && pass;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: got ${got}, want ${want}`);
}

for (const f of ['nusin', 'melati', 'sakura', 'observasi']) {
  const got = db.prepare('SELECT COUNT(*) c FROM patients WHERE facility = ?').get(f).c;
  const want = rows.filter((r) => r.facility === f).length;
  const pass = got === want;
  ok = ok && pass;
  console.log(`${pass ? 'PASS' : 'FAIL'}  patients[facility=${f}]: got ${got}, want ${want}`);
}

console.log(ok ? '\n✓ Migration verified OK' : '\n✗ MISMATCH — see above');
process.exit(ok ? 0 : 1);
