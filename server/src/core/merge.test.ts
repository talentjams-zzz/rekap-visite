import { describe, expect, it } from 'vitest';
import { findRowByMR, recordHistory, rowId, syncArchiveState, touchRowDate } from './merge.js';
import { newPatientRow } from './parsers.js';
import type { PatientRow, WorldState } from './types.js';

function mkRow(over: Partial<PatientRow> = {}): PatientRow {
  return newPatientRow('100', 'nusin', '2026-08-26', '2026-08-26 08:00:00', over);
}

const CHECKED = {
  telaah_resep: '2026-08-26 09:00:00',
  catatan_pengobatan: '2026-08-26 09:01:00',
  pio: '2026-08-26 09:02:00',
};

describe('rowId', () => {
  it('is "{mr}_{facility}"', () => {
    expect(rowId('656218', 'nusin')).toBe('656218_nusin');
  });
});

describe('findRowByMR', () => {
  it('matches exact id', () => {
    const rows = [mkRow()];
    expect(findRowByMR(rows, '100', 'nusin').row).toBe(rows[0]);
  });
  it('tolerates leading zeros in either direction (Excel numeric MR)', () => {
    const rows = [newPatientRow('067016', 'nusin', '2026-08-26', null)];
    const r = findRowByMR(rows, '67016', 'nusin');
    expect(r.row).toBe(rows[0]);
    expect(r.canonicalMr).toBe('067016');
  });
  it('does not match across facilities', () => {
    const rows = [mkRow()];
    expect(findRowByMR(rows, '100', 'melati').row).toBeNull();
  });
  it('returns input MR as canonical when no match', () => {
    expect(findRowByMR([], '999', 'nusin').canonicalMr).toBe('999');
  });
});

describe('recordHistory', () => {
  it('keeps one snapshot per day, newest first', () => {
    const r = mkRow();
    recordHistory(r, '2026-08-26', { nama: 'A' });
    recordHistory(r, '2026-08-27', { nama: 'B' });
    recordHistory(r, '2026-08-25', { nama: 'C' });
    expect(r.history.map((h) => h.date)).toEqual(['2026-08-27', '2026-08-26', '2026-08-25']);
  });
  it('re-recording the same day updates in place (idempotent re-import)', () => {
    const r = mkRow();
    recordHistory(r, '2026-08-26', { nama: 'A', kamar: 'K1' });
    recordHistory(r, '2026-08-26', { nama: 'A2' });
    expect(r.history.filter((h) => h.date === '2026-08-26')).toHaveLength(1);
    expect(r.history[0].nama).toBe('A2');
    expect(r.history[0].kamar).toBe('K1'); // untouched fields kept
  });
});

describe('touchRowDate', () => {
  it('advancing the day clears daily-reset items and logs them', () => {
    const r = mkRow({ checklist: { ...CHECKED } });
    touchRowDate(r, '2026-08-27', '2026-08-27 08:00:00');
    expect(r.checklist.telaah_resep).toBeNull();
    expect(r.checklist.pio).toBeNull();
    expect(r.checklist.catatan_pengobatan).toBe('2026-08-26 09:01:00'); // NOT a daily task
    expect(r.telaahLog).toEqual([{ date: '2026-08-26', ts: '2026-08-26 09:00:00' }]);
    expect(r.pioLog).toEqual([{ date: '2026-08-26', ts: '2026-08-26 09:02:00' }]);
    expect(r.dateAdded).toBe('2026-08-27');
    expect(r.lastSeen).toBe('2026-08-27 08:00:00');
  });
  it('same-day re-import keeps the checks (idempotent)', () => {
    const r = mkRow({ checklist: { ...CHECKED } });
    touchRowDate(r, '2026-08-26', '2026-08-26 10:00:00');
    expect(r.checklist.telaah_resep).toBe('2026-08-26 09:00:00');
    expect(r.telaahLog).toHaveLength(0);
    expect(r.lastSeen).toBe('2026-08-26 10:00:00'); // advances on re-upload
  });
  it('older file loaded out of order clears nothing and never rolls back', () => {
    const r = mkRow({ checklist: { ...CHECKED }, dateAdded: '2026-08-27', lastSeen: '2026-08-27 08:00:00' });
    touchRowDate(r, '2026-08-25', '2026-08-25 08:00:00');
    expect(r.checklist.telaah_resep).toBe('2026-08-26 09:00:00');
    expect(r.dateAdded).toBe('2026-08-27');
    expect(r.lastSeen).toBe('2026-08-27 08:00:00');
  });
  it('log entries for the same date are replaced, not duplicated', () => {
    const r = mkRow({ checklist: { ...CHECKED } });
    r.checklist.telaah_resep = '2026-08-26 12:00:00'; // re-checked same day
    touchRowDate(r, '2026-08-27', '2026-08-27 08:00:00');
    expect(r.telaahLog).toEqual([{ date: '2026-08-26', ts: '2026-08-26 12:00:00' }]);
  });
  it('handover (advanceLastSeen=false) never moves lastSeen', () => {
    const r = mkRow({ lastSeen: null });
    touchRowDate(r, '2026-08-27', '2026-08-27 09:00:00', false);
    expect(r.lastSeen).toBeNull();

    const r2 = mkRow({ lastSeen: '2026-08-26 08:00:00' });
    touchRowDate(r2, '2026-08-27', '2026-08-27 09:00:00', false);
    expect(r2.lastSeen).toBe('2026-08-26 08:00:00');
  });
});

describe('syncArchiveState', () => {
  it('active iff lastSeen equals the facility latest input (tracked)', () => {
    const state: WorldState = {
      facilityLatestInput: { nusin: '2026-08-27 09:00:00' },
      rows: [
        mkRow({ mr: '1', lastSeen: '2026-08-27 09:00:00', archived: true, archivedAt: 'x' }),
        mkRow({ mr: '2', lastSeen: '2026-08-26 09:00:00', archived: false }),
        mkRow({ mr: '3', lastSeen: null, archived: false }), // handover-only row
      ],
    };
    const res = syncArchiveState(state, '2026-08-27 10:00:00');
    expect(res).toEqual({ archived: 2, unarchived: 1 });
    expect(state.rows[0].archived).toBe(false);
    expect(state.rows[0].archivedAt).toBeNull();
    expect(state.rows[1].archived).toBe(true);
    expect(state.rows[1].archivedAt).toBe('2026-08-27 10:00:00');
    expect(state.rows[2].archived).toBe(true);
  });
  it('falls back to newest row lastSeen when facility has no tracked input', () => {
    const state: WorldState = {
      facilityLatestInput: {},
      rows: [
        mkRow({ mr: '1', lastSeen: '2026-08-27 09:00:00' }),
        mkRow({ mr: '2', lastSeen: '2026-08-26 09:00:00' }),
      ],
    };
    const res = syncArchiveState(state, 'now');
    expect(res).toEqual({ archived: 1, unarchived: 0 });
    expect(state.rows[0].archived).toBe(false);
    expect(state.rows[1].archived).toBe(true);
  });
  it('leaves rows untouched when the facility has no input at all', () => {
    const state: WorldState = { facilityLatestInput: {}, rows: [mkRow({ lastSeen: null })] };
    const res = syncArchiveState(state, 'now');
    expect(res).toEqual({ archived: 0, unarchived: 0 });
    expect(state.rows[0].archived).toBe(false);
  });
});
