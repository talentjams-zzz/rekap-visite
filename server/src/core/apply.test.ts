import { describe, expect, it } from 'vitest';
import { applyFiles } from './apply.js';
import type { ParsedFile, Sheet, WorldState } from './types.js';

const NOW = '2026-08-27 10:00:00';
const emptyState = (): WorldState => ({ rows: [], facilityLatestInput: {} });

function regFile(filename: string, day: string, ts: string, patients: [string, string][]): ParsedFile {
  const rows: Sheet = [
    ['Tgl Registrasi', 'No. Rekam Medis', 'Nama Pasien', 'Umur', 'Kamar', 'Bed', 'Dokter'],
    ...patients.map(([mr, nama]) => ['', mr, nama, '30', 'K1', '1', 'dr. A']),
  ];
  return { filename, facility: 'nusin', reportDate: day, inputTs: ts, kind: 'registry', sheets: [{ name: 'S1', rows }] };
}

function hoFile(filename: string, day: string, ts: string, patients: [string, string, string][]): ParsedFile {
  const rows: Sheet = [
    ['Kamar', 'Bed', 'NAMA', 'MEDREC', 'DPJP', 'DIAGNOSA', 'OPERAN', 'TERAPI'],
    ...patients.map(([mr, nama, operan]) => ['K1', '1', nama, mr, 'dr. A', 'D', operan, 'T']),
  ];
  return { filename, facility: 'nusin', reportDate: day, inputTs: ts, kind: 'handover', sheets: [{ name: 'S1', rows }] };
}

describe('applyFiles', () => {
  it('processes in chronological order: later day wins even with older mtime', () => {
    const state = emptyState();
    const day2 = regFile('nusin 27-08-26.xlsx', '2026-08-27', '2026-08-27 08:00:00', [['100', 'NewName']]);
    const day1 = regFile('nusin 26-08-26.xlsx', '2026-08-26', '2026-08-26 09:00:00', [['100', 'OldName']]);
    const res = applyFiles(state, [day2, day1], NOW); // passed out of order
    expect(res).toMatchObject({ files: 2, added: 1, merged: 1 });
    expect(state.rows[0].nama).toBe('NewName'); // day 2 processed last
    expect(state.facilityLatestInput.nusin).toBe('2026-08-27 08:00:00');
  });

  it('same day: newest upload is the latest input; others get archived', () => {
    const state = emptyState();
    const am = regFile('nusin 27-08-26.xlsx', '2026-08-27', '2026-08-27 08:00:00', [['100', 'X']]);
    const pm = regFile('nusin 27-08-26-update.xlsx', '2026-08-27', '2026-08-27 09:00:00', [['200', 'Y']]);
    const res = applyFiles(state, [am, pm], NOW);
    expect(state.facilityLatestInput.nusin).toBe('2026-08-27 09:00:00');
    const x = state.rows.find((r) => r.mr === '100')!;
    const y = state.rows.find((r) => r.mr === '200')!;
    expect(x.archived).toBe(true); // present in AM file, absent from PM file
    expect(y.archived).toBe(false);
    expect(res.sync).toEqual({ archived: 1, unarchived: 0 });
  });

  it('handover files never advance facilityLatestInput', () => {
    const state = emptyState();
    const reg = regFile('nusin 27-08-26.xlsx', '2026-08-27', '2026-08-27 08:00:00', [['100', 'X']]);
    const ho = hoFile('operan nusin 27-08-26.xlsx', '2026-08-27', '2026-08-27 09:00:00', [['100', 'X', 'Op']]);
    applyFiles(state, [reg, ho], NOW);
    expect(state.facilityLatestInput.nusin).toBe('2026-08-27 08:00:00');
    expect(state.rows[0].operan).toBe('Op');
    expect(state.rows[0].archived).toBe(false);
  });

  it('empty registry still advances latest input and archives everyone', () => {
    const state = emptyState();
    const day1 = regFile('nusin 26-08-26.xlsx', '2026-08-26', '2026-08-26 08:00:00', [['100', 'X']]);
    const day2HeaderOnly: ParsedFile = {
      ...regFile('nusin 27-08-26.xlsx', '2026-08-27', '2026-08-27 08:00:00', []),
      sheets: [{ name: 'S1', rows: [['Tgl Registrasi', 'No. Rekam Medis', 'Nama Pasien', 'Umur', 'Kamar', 'Bed', 'Dokter']] }],
    };
    const res = applyFiles(state, [day1, day2HeaderOnly], NOW);
    expect(state.facilityLatestInput.nusin).toBe('2026-08-27 08:00:00');
    expect(state.rows[0].archived).toBe(true);
    expect(res.sync.archived).toBe(1);
  });

  it('a patient who reappears in a newer file returns to active', () => {
    const state = emptyState();
    const day1 = regFile('nusin 26-08-26.xlsx', '2026-08-26', '2026-08-26 08:00:00', [['100', 'X']]);
    const day2 = regFile('nusin 27-08-26.xlsx', '2026-08-27', '2026-08-27 08:00:00', [['100', 'X'], ['200', 'Y']]);
    const res = applyFiles(state, [day1, day2], NOW);
    expect(state.rows[0].archived).toBe(false);
    expect(res.sync.unarchived).toBe(0); // never archived in the first place
    expect(state.rows.filter((r) => !r.archived)).toHaveLength(2);
  });

  it('collects warnings from handover parsing', () => {
    const state = emptyState();
    const ho = hoFile('operan nusin 27-08-26.xlsx', '2026-08-27', '2026-08-27 09:00:00', [['100', 'X', 'Op']]);
    // Guard requires >=2 rows of real data in the SAME unlabeled column.
    ho.sheets[0].rows.push(['K1', '1', 'Z', '999', 'dr', 'D', 'O', 'T', 'Orphan data column here']);
    ho.sheets[0].rows.push(['K1', '2', 'W', '998', 'dr', 'D', 'O', 'T', 'More orphan data here']);
    const res = applyFiles(state, [ho], NOW);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(res.warnings[0]).toContain('#9');
  });
});
