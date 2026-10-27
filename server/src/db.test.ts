// v2.1: upgrading a database that has labs WITHOUT the summary columns must
// add the columns and backfill them from tests_json (one-time, on open).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from './db.js';

const here = path.dirname(new URL(import.meta.url).pathname);

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'rekap-dbtest-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A pre-v2.1 schema: labs WITHOUT the summary columns. */
function legacySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE patients (
      id TEXT PRIMARY KEY, mr TEXT NOT NULL, facility TEXT NOT NULL,
      date_added TEXT, tgl_registrasi TEXT, nama TEXT, umur TEXT, kamar TEXT, bed TEXT,
      dokter TEXT, diagnosis TEXT, operan TEXT, terapi TEXT, pharmacist_note TEXT,
      aso_json TEXT NOT NULL DEFAULT '[]', rev INTEGER NOT NULL DEFAULT 0, soap TEXT,
      archived INTEGER NOT NULL DEFAULT 0, archived_at TEXT, last_seen TEXT,
      UNIQUE (mr, facility)
    );
    CREATE TABLE labs (
      mr TEXT PRIMARY KEY, filename TEXT, loaded_at TEXT, max_date TEXT, tests_json TEXT NOT NULL
    );
  `);
}

describe('openDb lab summary migration', () => {
  it('adds summary columns and backfills counts from tests_json', () => {
    const file = path.join(dir, 'legacy.db');
    writeFileSync(file, ''); // force a fresh file each run
    const legacy = new DatabaseSync(file);
    legacySchema(legacy);
    const tests = [
      { nama: 'Hb', hasil: '12', normal: '12 - 16', komentar: '', satuan: 'g/dL', keterangan: '', tanggal: '2026-01-01', jenis: '', abnormal: false, kritis: false },
      { nama: 'PLT', hasil: '30', normal: '150 - 450', komentar: '', satuan: '10^3', keterangan: 'Dilaporkan', tanggal: '2026-01-01', jenis: '', abnormal: true, kritis: true },
      { nama: 'Eritrosit', hasil: '2', normal: '4 - 6', komentar: '', satuan: '10^6', keterangan: '', tanggal: '2026-01-01', jenis: '', abnormal: true, kritis: false },
    ];
    legacy.prepare('INSERT INTO labs (mr, filename, loaded_at, max_date, tests_json) VALUES (?,?,?,?,?)')
      .run('111', 'lab-111.xlsx', '2026-01-01 08:00:00', '2026-01-01', JSON.stringify(tests));
    legacy.close();

    // Re-open through openDb (runs the upgrade + backfill), then apply the
    // CURRENT schema on top (openDb already did via schema.sql exec).
    const db = openDb(file);
    const row = db.prepare('SELECT test_count, abnormal_count, kritis_count FROM labs WHERE mr = ?').get('111') as {
      test_count: number;
      abnormal_count: number;
      kritis_count: number;
    };
    expect(row.test_count).toBe(3);
    expect(row.abnormal_count).toBe(2);
    expect(row.kritis_count).toBe(1);
    // The full report is preserved (not dropped by the migration).
    const json = db.prepare('SELECT tests_json FROM labs WHERE mr = ?').get('111') as { tests_json: string };
    expect(JSON.parse(json.tests_json)).toHaveLength(3);
    db.close();
  });

  it('does not re-backfill on a second open (idempotent)', () => {
    const file = path.join(dir, 'already-upgraded.db');
    writeFileSync(file, '');
    const db = openDb(file);
    // A zero-test row is legitimate; backfill must NOT overwrite 0s on re-open.
    db.prepare(
      'INSERT INTO labs (mr, filename, loaded_at, max_date, tests_json, test_count, abnormal_count, kritis_count) VALUES (?,?,?,?,?,?,0,0)',
    )
      .run('222', 'lab-222.xlsx', '2026-01-02 08:00:00', '2026-01-02', '[]', 0);
    db.close();
    const db2 = openDb(file);
    const row = db2.prepare('SELECT test_count FROM labs WHERE mr = ?').get('222') as { test_count: number };
    expect(row.test_count).toBe(0);
    db2.close();
  });
});
