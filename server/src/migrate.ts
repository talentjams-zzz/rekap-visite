// Migration core: v1 master_data.json -> v2 SQLite.
// Shared by the CLI (scripts/migrate-v1.ts) and the server (auto-migration).
import type { DatabaseSync } from 'node:sqlite';
import { labAbnormal } from './core/parsers.js';

export const ROW_ITEMS = ['telaah_resep', 'catatan_pengobatan', 'pio'] as const;
export const LOG_FIELDS: Record<string, string> = {
  telaah_resep: 'telaahLog',
  catatan_pengobatan: 'catatanLog',
  pio: 'pioLog',
};
export const PATIENT_ITEMS = ['visite', 'pto', 'konseling', 'rekonsiliasi_obat', 'penelusuran_obat'] as const;
export const FACILITIES = ['nusin', 'melati', 'sakura', 'observasi'] as const;

export interface V1HistoryEntry {
  date: string;
  tglRegistrasi?: string | null;
  nama?: string | null;
  umur?: string | null;
  kamar?: string | null;
  bed?: string | null;
  dokter?: string | null;
  diagnosis?: string | null;
  operan?: string | null;
  terapi?: string | null;
}

export interface V1LogEntry {
  date: string;
  ts: string;
}

export interface V1Row {
  id: string;
  mr: string;
  facility: string;
  dateAdded?: string | null;
  tglRegistrasi?: string | null;
  nama?: string | null;
  umur?: string | null;
  kamar?: string | null;
  bed?: string | null;
  dokter?: string | null;
  diagnosis?: string | null;
  operan?: string | null;
  terapi?: string | null;
  checklist?: Record<string, string | null>;
  pharmacistNote?: string | null;
  archived?: boolean;
  archivedAt?: string | null;
  lastSeen?: string | null;
  history?: V1HistoryEntry[];
  telaahLog?: V1LogEntry[];
  catatanLog?: V1LogEntry[];
  pioLog?: V1LogEntry[];
  [key: string]: unknown;
}

export interface V1Master {
  savedAt?: string;
  version?: number;
  rows: V1Row[];
  patientChecklist?: Record<string, Record<string, string | null>>;
  labResults?: Record<
    string,
    { filename?: string; loadedAt?: string; maxDate?: string; tests?: unknown[] }
  >;
  facilityLatestInput?: Record<string, string>;
}

export interface MigrationCheck {
  name: string;
  got: number;
  want: number;
  pass: boolean;
}

export interface MigrationReport {
  ok: boolean;
  checks: MigrationCheck[];
}

/** Wipe all v2 tables and re-insert from the v1 master. Verified against source. */
export function runMigration(db: DatabaseSync, src: V1Master, schemaSql: string): MigrationReport {
  const rows = src.rows || [];
  db.exec(schemaSql);

  // Table names are a fixed allowlist (never user input); guard as defense in depth.
  const TABLES = [
    'daily_logs', 'patient_days', 'row_checklist', 'patient_checklist',
    'labs', 'facility_latest_input', 'patients', 'uploads', 'meta',
  ];
  for (const t of TABLES) {
    if (!/^[a-z_]+$/.test(t)) throw new Error(`unsafe table identifier: ${t}`);
  }

  db.exec('BEGIN');
  try {
    for (const t of TABLES) {
      db.prepare(`DELETE FROM ${t}`).run();
    }

    const insP = db.prepare(`
      INSERT INTO patients (id, mr, facility, date_added, tgl_registrasi, nama, umur, kamar, bed,
                            dokter, diagnosis, operan, terapi, pharmacist_note, soap, aso_json, archived, archived_at, last_seen)
      VALUES (:id, :mr, :facility, :dateAdded, :tglRegistrasi, :nama, :umur, :kamar, :bed,
              :dokter, :diagnosis, :operan, :terapi, :note, :soap, :aso, :archived, :archivedAt, :lastSeen)`);
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
        soap: (r.soap as string | null) ?? null,
        aso: JSON.stringify(Array.isArray(r.aso) ? r.aso : []),
        archived: r.archived ? 1 : 0,
        archivedAt: r.archivedAt ?? null,
        lastSeen: r.lastSeen ?? null,
      });
    }

    const insD = db.prepare(`
      INSERT INTO patient_days (patient_id, report_date, tgl_registrasi, nama, umur, kamar, bed,
                                dokter, diagnosis, operan, terapi, soap)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rows) {
      for (const h of r.history || []) {
        insD.run(r.id, h.date, h.tglRegistrasi ?? null, h.nama ?? null, h.umur ?? null,
          h.kamar ?? null, h.bed ?? null, h.dokter ?? null, h.diagnosis ?? null,
          h.operan ?? null, h.terapi ?? null, (h as { soap?: string | null }).soap ?? null);
      }
    }

    const insRC = db.prepare('INSERT OR REPLACE INTO row_checklist (patient_id, item_key, checked_at) VALUES (?, ?, ?)');
    for (const r of rows) {
      for (const k of ROW_ITEMS) {
        insRC.run(r.id, k, (r.checklist || {})[k] ?? null);
      }
    }

    const insDL = db.prepare('INSERT INTO daily_logs (patient_id, item_key, date, ts) VALUES (?, ?, ?, ?)');
    for (const r of rows) {
      for (const [item, field] of Object.entries(LOG_FIELDS)) {
        const log = (r as Record<string, unknown>)[field];
        for (const e of (log as V1LogEntry[] | undefined) || []) insDL.run(r.id, item, e.date, e.ts);
      }
    }

    const insPC = db.prepare('INSERT OR REPLACE INTO patient_checklist (mr, item_key, checked_at) VALUES (?, ?, ?)');
    for (const [mr, items] of Object.entries(src.patientChecklist || {})) {
      for (const k of PATIENT_ITEMS) {
        const v = (items || {})[k];
        if (v !== undefined) insPC.run(mr, k, v ?? null);
      }
    }

    // Summary counts computed with the same v1 rules the UI uses (v2.1):
    // v1 files carry raw test fields (no flags), v2 write-back files carry
    // the overridden `normal` values, so recomputing from the stored
    // fields is stable in both cases.
    const insL = db.prepare(
      'INSERT OR REPLACE INTO labs (mr, filename, loaded_at, max_date, tests_json, test_count, abnormal_count, kritis_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const [mr, lab] of Object.entries(src.labResults || {})) {
      const tests = (lab.tests ?? []) as { hasil?: string; normal?: string; keterangan?: string }[];
      insL.run(
        mr,
        lab.filename ?? null,
        lab.loadedAt ?? null,
        lab.maxDate ?? null,
        JSON.stringify(lab.tests ?? []),
        tests.length,
        tests.filter((t) => labAbnormal(String(t.hasil ?? ''), String(t.normal ?? ''))).length,
        tests.filter((t) => String(t.keterangan ?? '').toLowerCase().includes('dilaporkan')).length,
      );
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
  const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  const checks: [string, number, number][] = [
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
      rows.reduce((a, r) => a + Object.values(LOG_FIELDS).reduce((b, f) => b + (((r as Record<string, unknown>)[f] as V1LogEntry[] | undefined)?.length || 0), 0), 0)],
    ['archived patients', count('SELECT COUNT(*) c FROM patients WHERE archived = 1'),
      rows.filter((r) => r.archived).length],
    ['facility_latest_input', count('SELECT COUNT(*) c FROM facility_latest_input'),
      Object.keys(src.facilityLatestInput || {}).length],
  ];
  for (const f of FACILITIES) {
    checks.push([
      `patients[facility=${f}]`,
      (db.prepare('SELECT COUNT(*) c FROM patients WHERE facility = ?').get(f) as { c: number }).c,
      rows.filter((r) => r.facility === f).length,
    ]);
  }

  const report: MigrationReport = {
    ok: true,
    checks: checks.map(([name, got, want]) => {
      const pass = got === want;
      if (!pass) report.ok = false;
      return { name, got, want, pass };
    }),
  };
  return report;
}

export interface MigrationState {
  lastMigratedAt: string | null;
  sourceVersion: string | null;
  sourceSavedAt: string | null;
}

/** null when the DB was never migrated. */
export function migrationState(db: DatabaseSync): MigrationState | null {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'migrated_at'")
    .get() as { value: string } | undefined;
  if (!row) return null;
  const get = (k: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null;
  return {
    lastMigratedAt: row.value,
    sourceVersion: get('source_version'),
    sourceSavedAt: get('source_saved_at'),
  };
}

/** True when the v1 master is newer than what the DB was last migrated from. */
export function isSourceNewer(db: DatabaseSync, src: V1Master): boolean {
  const state = migrationState(db);
  if (!state) return true;
  const lastVersion = Number(state.sourceVersion || 0);
  if (typeof src.version === 'number' && src.version > lastVersion) return true;
  const lastSaved = state.sourceSavedAt || '';
  if (src.savedAt && lastSaved && src.savedAt > lastSaved) return true;
  return false;
}
