import { describe, it, expect, beforeAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync as readFile } from 'node:fs';
import { runMigration, isSourceNewer } from './migrate.js';
import { writeBackToV1 } from './writeback.js';
import schemaSqlRaw from '../schema.sql?raw';

function freshDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-'));
  const db = new DatabaseSync(path.join(dir, 't.db'));
  db.exec(schemaSqlRaw);
  return { db, dir };
}

const V1 = {
  savedAt: '2026-09-19T05:21:13.000Z',
  version: 61,
  rows: [
    {
      id: '1001_nusin', mr: '1001', facility: 'nusin', dateAdded: '2026-09-19',
      tglRegistrasi: '2026-09-19 08:00:00', nama: 'ALFA', umur: '2', kamar: '1', bed: '1',
      dokter: 'dr A', diagnosis: 'D', operan: 'O', terapi: 'T',
      checklist: { telaah_resep: '2026-09-19 09:00:00', catatan_pengobatan: null, pio: null },
      pharmacistNote: '', archived: false, archivedAt: null,
      telaahLog: [{ date: '2026-09-18', ts: '2026-09-18 10:00:00' }],
      catatanLog: [], pioLog: [], history: [], lastSeen: '2026-09-19 08:00:00',
    },
  ],
  patientChecklist: { '1001': { visite: '2026-09-08 20:23:07' } },
  labResults: {
    '1001': {
      loadedAt: '2026-09-03 12:00:00', maxDate: '2026-09-03',
      tests: [{ nama: 'Albumin', hasil: '3.6', normal: '2.8 - 4.4', satuan: 'g/dL', keterangan: '', tanggal: '2026-09-03 12:01:35' }],
    },
  },
  facilityLatestInput: { nusin: '2026-09-19 05:20:00' },
  colWidths: { 0: 90, 3: 160 },
  labColWidths: { 0: 120 },
};

describe('writeBackToV1', () => {
  let db: DatabaseSync;
  let dir: string;
  let file: string;

  beforeAll(() => {
    ({ db, dir } = freshDb());
    file = path.join(dir, 'master_data.json');
    writeFileSync(file, JSON.stringify(V1, null, 2));
    const rep = runMigration(db, V1 as never, schemaSqlRaw);
    expect(rep.ok).toBe(true);
  });

  it('round-trips a v1 file: version bumps, legacy + UI state preserved', () => {
    // A v2-side change: a patient-level check not present before.
    db.prepare('INSERT OR REPLACE INTO patient_checklist (mr, item_key, checked_at) VALUES (?, ?, ?)')
      .run('1001', 'pto', '2026-09-19 10:00:00');

    const res = writeBackToV1(db, file);
    expect(res?.version).toBe(62);

    const out = JSON.parse(readFile(file, 'utf8'));
    expect(out.version).toBe(62);
    expect(out.rows).toHaveLength(1);
    const row = out.rows[0];
    // legacy per-day archives carried through
    expect(row.telaahLog).toEqual([{ date: '2026-09-18', ts: '2026-09-18 10:00:00' }]);
    expect(row.catatanLog).toEqual([]);
    expect(row.pioLog).toEqual([]);
    expect(row.checklist.telaah_resep).toBe('2026-09-19 09:00:00');
    // new v2 change present
    expect(out.patientChecklist['1001'].pto).toBe('2026-09-19 10:00:00');
    expect(out.patientChecklist['1001'].visite).toBe('2026-09-08 20:23:07');
    // labs + facility input preserved
    expect(out.labResults['1001'].tests[0].nama).toBe('Albumin');
    expect(out.facilityLatestInput.nusin).toBe('2026-09-19 05:20:00');
    // v1 UI state preserved
    expect(out.colWidths).toEqual({ 0: 90, 3: 160 });
    expect(out.labColWidths).toEqual({ 0: 120 });
    // sparse aso omitted when empty
    expect('aso' in row).toBe(false);
    // top-level shape matches v1 exactly
    expect(Object.keys(out).sort()).toEqual(
      ['colWidths', 'facilityLatestInput', 'labColWidths', 'labResults', 'patientChecklist', 'rows', 'savedAt', 'version'],
    );
  });

  it('never triggers a re-migration of its own output', () => {
    const out = JSON.parse(readFile(file, 'utf8'));
    expect(isSourceNewer(db, out as never)).toBe(false);
  });

  it('detects a v1 save (version bump) as newer', () => {
    const out = JSON.parse(readFile(file, 'utf8'));
    out.version = 63;
    out.savedAt = '2026-09-20T00:00:00.000Z';
    expect(isSourceNewer(db, out as never)).toBe(true);
  });

  it('returns null for a missing file (never creates one)', () => {
    const missing = path.join(dir, 'nope.json');
    expect(existsSync(missing)).toBe(false);
    expect(writeBackToV1(db, missing)).toBeNull();
    expect(existsSync(missing)).toBe(false);
  });
});
