// Readmission rule (v2 feature, audit-backed): a NEW registration DATE in
// the registry file means a new treatment episode. The old episode's
// current-state fields are snapshotted into its last riwayat day, then the
// row's treatment fields start fresh. Same reg date (continuing stay or
// missing-facility-file gap) and blank reg date never reset.
import { describe, expect, it } from 'vitest';
import { parseRegistry } from './parsers.js';
import type { Facility, Sheet, WorldState } from './types.js';

const F: Facility = 'nusin';
const emptyState = (): WorldState => ({ rows: [], facilityLatestInput: {} });

const REG_HEADERS = [
  'Tgl Registrasi', 'No Registrasi', 'No. Rekam Medis', 'Nama Pasien',
  'Tgl Lahir', 'Umur', 'Dokter', 'Dokter Tambahan', 'Jenis Kelamin', 'Kelas', 'Kamar', 'Bed',
];
const regSheet = (rows: (string | null)[][]): Sheet => [REG_HEADERS, ...rows];
const P = (tglReg: string) =>
  [tglReg, 'R1', '104640', 'Aysha', '', '26', 'dr. A', '', 'F', 'Vip', 'Mawar', '3'];

describe('readmission detection', () => {
  it('reg-date change: treatment fields cleared, old episode snapshotted to riwayat', () => {
    const state = emptyState();
    parseRegistry(state, F, regSheet([P('2026-09-01 08:00:00')]), '2026-09-01', '2026-09-01 08:00:00');
    const r = state.rows[0];
    // Pharmacist work done during episode 1 (after the file arrived).
    r.diagnosis = 'D old';
    r.operan = 'O old';
    r.terapi = 'T old';
    r.pharmacistNote = 'N old';
    r.soap = 'S old';
    r.aso = [{ id: 'a1', name: 'ketorolac', stopDate: '2026-09-05', stopped: false, stoppedAt: null }];
    r.history[0].diagnosis = 'D old'; // the day-1 file-arrival snapshot

    const res = parseRegistry(state, F, regSheet([P('2026-09-10 09:00:00')]), '2026-09-10', '2026-09-10 08:00:00');
    expect(res.merged).toBe(1);
    expect(res.readmissions).toEqual([{ rowId: r.id, mr: '104640', episodeEnd: '2026-09-01' }]);

    // Current treatment is fresh.
    expect(r.diagnosis).toBe('');
    expect(r.operan).toBe('');
    expect(r.terapi).toBe('');
    expect(r.pharmacistNote).toBe('');
    expect(r.soap).toBe('');
    expect(r.aso).toEqual([]);

    // The old episode is preserved on its last riwayat day (2026-09-01).
    const d1 = r.history.find((h) => h.date === '2026-09-01');
    expect(d1?.diagnosis).toBe('D old');
    expect(d1?.note).toBe('N old');
    expect(d1?.soap).toBe('S old');

    // New registration date is stored; registry fields still update.
    expect(r.tglRegistrasi).toBe('2026-09-10 09:00:00');
    expect(r.kamar).toBe('Mawar');
  });

  it('same reg date after a multi-day gap (missing file artifact): no reset', () => {
    const state = emptyState();
    parseRegistry(state, F, regSheet([P('2026-09-01 08:00:00')]), '2026-09-01', '2026-09-01 08:00:00');
    const r = state.rows[0];
    r.diagnosis = 'D old';
    r.pharmacistNote = 'N old';

    // 4-day gap, same registration date (the real data shows this pattern
    // 32x — facility-wide missing reports, not discharges).
    const res = parseRegistry(state, F, regSheet([P('2026-09-01 08:00:00')]), '2026-09-05', '2026-09-05 08:00:00');
    expect(res.readmissions).toEqual([]);
    expect(r.diagnosis).toBe('D old');
    expect(r.pharmacistNote).toBe('N old');
  });

  it('blank reg date in the file: no signal, no reset', () => {
    const state = emptyState();
    parseRegistry(state, F, regSheet([P('2026-09-01 08:00:00')]), '2026-09-01', '2026-09-01 08:00:00');
    const r = state.rows[0];
    r.diagnosis = 'D old';

    const res = parseRegistry(state, F, regSheet([P('')]), '2026-09-05', '2026-09-05 08:00:00');
    expect(res.readmissions).toEqual([]);
    expect(r.diagnosis).toBe('D old');
    // The stored reg date is kept when the file has none.
    expect(r.tglRegistrasi).toBe('2026-09-01 08:00:00');
  });

  it('first appearance is never a readmission', () => {
    const state = emptyState();
    const res = parseRegistry(state, F, regSheet([P('2026-09-01 08:00:00')]), '2026-09-01', '2026-09-01 08:00:00');
    expect(res.added).toBe(1);
    expect(res.readmissions).toEqual([]);
  });

  it('same-day re-import with a reg-date change resets once, then is stable', () => {
    const state = emptyState();
    parseRegistry(state, F, regSheet([P('2026-09-01 08:00:00')]), '2026-09-01', '2026-09-01 08:00:00');
    const r = state.rows[0];
    r.diagnosis = 'D old';

    // New registration date arrives; the file is then re-uploaded (same day).
    const res1 = parseRegistry(state, F, regSheet([P('2026-09-10 09:00:00')]), '2026-09-10', '2026-09-10 08:00:00');
    expect(res1.readmissions).toHaveLength(1);
    r.diagnosis = 'D new';
    const res2 = parseRegistry(state, F, regSheet([P('2026-09-10 09:00:00')]), '2026-09-10', '2026-09-10 09:00:00');
    expect(res2.readmissions).toEqual([]);
    expect(r.diagnosis).toBe('D new'); // idempotent re-import keeps current work
  });
});
