import { describe, expect, it } from 'vitest';
import {
  labAbnormal,
  labNum,
  labNormal,
  parseHandover,
  parseLabFile,
  parseRegistry,
} from './parsers.js';
import type { Facility, Sheet, WorldState } from './types.js';

const F: Facility = 'nusin';
const emptyState = (): WorldState => ({ rows: [], facilityLatestInput: {} });

const REG_HEADERS = [
  'Tgl Registrasi', 'No Registrasi', 'No. Rekam Medis', 'Nama Pasien',
  'Tgl Lahir', 'Umur', 'Dokter', 'Dokter Tambahan', 'Jenis Kelamin', 'Kelas', 'Kamar', 'Bed',
];
function regSheet(patients: (string | null)[][]): Sheet {
  return [REG_HEADERS, ...patients];
}

describe('parseRegistry', () => {
  it('creates rows with mapped fields; dokter tambahan appended', () => {
    const state = emptyState();
    const res = parseRegistry(
      state, F,
      regSheet([
        ['2026-08-26 10:00:00', 'R1', '104640', 'Aysha', '2000-01-01', '26', 'dr. A', 'dr. B', 'F', 'Vip', 'Mawar', '3'],
      ]),
      '2026-08-26', '2026-08-26 08:00:00',
    );
    expect(res).toMatchObject({ added: 1, merged: 0 });
    const r = state.rows[0];
    expect(r.mr).toBe('104640');
    expect(r.dokter).toBe('dr. A, dr. B');
    expect(r.tglRegistrasi).toBe('2026-08-26 10:00:00');
    expect(r.nama).toBe('Aysha');
    expect(r.kamar).toBe('Mawar');
    expect(r.lastSeen).toBe('2026-08-26 08:00:00');
    expect(r.dateAdded).toBe('2026-08-26');
    expect(r.history).toHaveLength(1);
  });

  it('skips rows without Nama', () => {
    const state = emptyState();
    const res = parseRegistry(
      state, F,
      regSheet([
        ['2026-08-26 10:00:00', 'R1', '104640', 'Aysha', '', '26', 'dr. A', '', 'F', 'Vip', 'Mawar', '3'],
        ['', '', '300002', null, '', '', '', '', '', '', '', ''],
      ]),
      '2026-08-26', '2026-08-26 08:00:00',
    );
    expect(res.added).toBe(1);
    expect(state.rows).toHaveLength(1);
  });

  it('later-day file merges: fields update, history grows, daily task resets', () => {
    const state = emptyState();
    parseRegistry(state, F, regSheet([['', 'R1', '104640', 'Aysha', '', '26', 'dr. A', '', 'F', 'V', 'Mawar', '3']]), '2026-08-26', '2026-08-26 08:00:00');
    const r = state.rows[0];
    r.checklist.telaah_resep = '2026-08-26 09:00:00';

    const res = parseRegistry(state, F, regSheet([['', 'R1', '104640', 'Aysha', '', '26', 'dr. A', '', 'F', 'V', 'Sakura', '7']]), '2026-08-27', '2026-08-27 08:00:00');
    expect(res).toMatchObject({ added: 0, merged: 1 });
    expect(r.kamar).toBe('Sakura');
    expect(r.dateAdded).toBe('2026-08-27');
    expect(r.checklist.telaah_resep).toBeNull(); // daily task reset
    expect(r.telaahLog).toEqual([{ date: '2026-08-26', ts: '2026-08-26 09:00:00' }]);
    expect(r.history.map((h) => h.date)).toEqual(['2026-08-27', '2026-08-26']);
  });

  it('numeric MR (leading zero dropped) merges into the zero-padded row', () => {
    const state = emptyState();
    parseRegistry(state, F, regSheet([['', 'R1', '067016', 'Zero', '', '26', 'dr. A', '', 'F', 'V', 'K1', '1']]), '2026-08-26', '2026-08-26 08:00:00');
    const res = parseRegistry(state, F, regSheet([['', 'R2', '67016', 'Zero', '', '26', 'dr. B', '', 'F', 'V', 'K2', '2']]), '2026-08-27', '2026-08-27 08:00:00');
    expect(res.merged).toBe(1);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].mr).toBe('067016'); // canonical kept
    expect(state.rows[0].dokter).toBe('dr. B'); // latest wins
  });

  it('returns empty result when no header row found', () => {
    const state = emptyState();
    const res = parseRegistry(state, F, [['foo'], ['bar']], '2026-08-26', '2026-08-26 08:00:00');
    expect(res).toMatchObject({ added: 0, merged: 0 });
  });
});

describe('parseHandover', () => {
  const HO_HEADERS = ['Kamar', 'Bed', 'NAMA', 'MEDREC', 'DPJP', 'DIAGNOSA', 'OPERAN', 'TERAPI'];

  it('creates a row with lastSeen null when no registry row exists', () => {
    const state = emptyState();
    const res = parseHandover(
      state, F,
      [{ name: 'S1', rows: [HO_HEADERS, ['Mawar', '3', 'Aysha', '104640', 'dr. A', 'Pneumonia', 'Perawatan lanjut', 'Ceftriaxone 2x1']] }],
      '2026-08-26', '2026-08-26 09:00:00', 'operan nusin 26-08-26.xlsx',
    );
    expect(res.added).toBe(1);
    const r = state.rows[0];
    expect(r.lastSeen).toBeNull();
    expect(r.diagnosis).toBe('Pneumonia');
    expect(r.operan).toBe('Perawatan lanjut');
    expect(r.terapi).toBe('Ceftriaxone 2x1');
  });

  it('continues multi-line cells on rows with empty MR (newline-joined)', () => {
    const state = emptyState();
    parseHandover(
      state, F,
      [{
        name: 'S1',
        rows: [
          HO_HEADERS,
          ['Mawar', '3', 'Aysha', '104640', 'dr. A', 'Pneumonia', 'Perawatan lanjut', 'Ceftriaxone 2x1'],
          ['', '', '', '', '', 'Pleuritis eff', 'Tambah observasi', 'Paracetamol 3x1'],
        ],
      }],
      '2026-08-26', '2026-08-26 09:00:00', 'operan nusin 26-08-26.xlsx',
    );
    const r = state.rows[0];
    expect(r.diagnosis).toBe('Pneumonia\nPleuritis eff');
    expect(r.operan).toBe('Perawatan lanjut\nTambah observasi');
    expect(r.terapi).toBe('Ceftriaxone 2x1\nParacetamol 3x1');
  });

  it('merges into existing registry row without touching lastSeen', () => {
    const state = emptyState();
    parseRegistry(state, F, regSheet([['', 'R1', '104640', 'Aysha', '', '26', 'dr. A', '', 'F', 'V', 'Mawar', '3']]), '2026-08-26', '2026-08-26 08:00:00');
    const r = state.rows[0];
    parseHandover(
      state, F,
      [{ name: 'S1', rows: [HO_HEADERS, ['Mawar', '3', 'Aysha', '104640', 'dr. A', 'Pneumonia', 'Op', 'Ter']] }],
      '2026-08-26', '2026-08-26 09:00:00', 'operan nusin 26-08-26.xlsx',
    );
    expect(r.lastSeen).toBe('2026-08-26 08:00:00'); // handover must not advance
    expect(r.diagnosis).toBe('Pneumonia');
    expect(r.operan).toBe('Op');
  });

  it('handover NEVER overwrites registry identity fields (doctor-name variants)', () => {
    const state = emptyState();
    // Registry: canonical spelling, as typed by the facility system.
    parseRegistry(state, F, regSheet([['', 'R1', '104640', 'Aysha', '', '26', 'dr. Putri, Sp.B', '', 'F', 'V', 'Mawar', '3']]), '2026-08-26', '2026-08-26 08:00:00');
    const r = state.rows[0];
    // Operan sheet: hand-typed variants of the same data.
    parseHandover(
      state, F,
      [{ name: 'S1', rows: [HO_HEADERS, ['Mawar', '4', 'AYSHA BINTI', '104640', 'dr Putri SpB', 'Pneumonia', 'Op', 'Ter']] }],
      '2026-08-26', '2026-08-26 09:00:00', 'operan nusin 26-08-26.xlsx',
    );
    // D/O/T from the handover…
    expect(r.diagnosis).toBe('Pneumonia');
    expect(r.operan).toBe('Op');
    expect(r.terapi).toBe('Ter');
    // …but registry identity fields untouched (the old bug: operan's
    // "dr Putri SpB" clobbered the registry's "dr. Putri, Sp.B").
    expect(r.dokter).toBe('dr. Putri, Sp.B');
    expect(r.nama).toBe('Aysha');
    expect(r.kamar).toBe('Mawar');
    expect(r.bed).toBe('3');
  });

  it('day snapshot = registry fields + handover D/O/T, in either load order', () => {
    // Registry first, then handover.
    const a = emptyState();
    parseRegistry(a, F, regSheet([['', 'R1', '104640', 'Aysha', '', '26', 'dr. Putri, Sp.B', '', 'F', 'V', 'Mawar', '3']]), '2026-08-26', '2026-08-26 08:00:00');
    parseHandover(
      a, F,
      [{ name: 'S1', rows: [HO_HEADERS, ['Mawar', '3', 'Aysha', '104640', 'dr Putri SpB', 'Pneumonia', 'Op', 'Ter']] }],
      '2026-08-26', '2026-08-26 09:00:00', 'operan nusin 26-08-26.xlsx',
    );
    const snapA = a.rows[0].history.find((h) => h.date === '2026-08-26')!;
    expect(snapA).toMatchObject({
      nama: 'Aysha', dokter: 'dr. Putri, Sp.B', kamar: 'Mawar',
      diagnosis: 'Pneumonia', operan: 'Op', terapi: 'Ter',
    });

    // Handover first (patient known from an earlier day), then registry.
    const b = emptyState();
    parseRegistry(b, F, regSheet([['', 'R1', '104640', 'Aysha', '', '26', 'dr. Putri, Sp.B', '', 'F', 'V', 'Mawar', '3']]), '2026-08-25', '2026-08-25 08:00:00');
    parseHandover(
      b, F,
      [{ name: 'S1', rows: [HO_HEADERS, ['Mawar', '3', 'Aysha', '104640', 'dr Putri SpB', 'Pneumonia', 'Op', 'Ter']] }],
      '2026-08-26', '2026-08-26 09:00:00', 'operan nusin 26-08-26.xlsx',
    );
    parseRegistry(b, F, regSheet([['', 'R1', '104640', 'Aysha', '', '26', 'dr. Putri, Sp.B', '', 'F', 'V', 'Mawar', '3']]), '2026-08-26', '2026-08-26 08:30:00');
    const snapB = b.rows[0].history.find((h) => h.date === '2026-08-26')!;
    expect(snapB).toMatchObject({
      nama: 'Aysha', dokter: 'dr. Putri, Sp.B', kamar: 'Mawar',
      diagnosis: 'Pneumonia', operan: 'Op', terapi: 'Ter',
    });
  });

  it('falls back to the column after OPERAN when the TERAPI header is blank', () => {
    const state = emptyState();
    parseHandover(
      state, F,
      [{
        name: 'S1',
        rows: [
          ['Kamar', 'Bed', 'NAMA', 'MEDREC', 'DPJP', 'DIAGNOSA', 'OPERAN', ''],
          ['K1', '1', 'X', '900', 'dr. A', 'D', 'Operan text that is long enough', 'Therapy text that is long enough'],
        ],
      }],
      '2026-08-26', '2026-08-26 09:00:00', 'operan nusin 26-08-26.xlsx',
    );
    expect(state.rows[0].terapi).toBe('Therapy text that is long enough');
  });

  it('warns on data in unlabeled columns (silent data-loss guard)', () => {
    const state = emptyState();
    const res = parseHandover(
      state, F,
      [{
        name: 'S1',
        rows: [
          HO_HEADERS,
          ['K1', '1', 'X', '900', 'dr', 'D', 'O', 'T', 'Hidden column data here'],
          ['K1', '2', 'Y', '901', 'dr', 'D', 'O', 'T', 'More hidden column data'],
        ],
      }],
      '2026-08-26', '2026-08-26 09:00:00', 'operan nusin 26-08-26.xlsx',
    );
    expect(res.warnings.some((w) => w.includes('#9'))).toBe(true);
  });
});

describe('lab value parsing', () => {
  it('labNum reads the leading number (incl. parens/signs)', () => {
    expect(labNum('33.2')).toBe(33.2);
    expect(labNum('(-2)')).toBe(-2);
    expect(labNum('+2')).toBe(2);
    expect(labNum('Negatif')).toBeNull();
  });
  it('labNormal parses lt / gt / range', () => {
    expect(labNormal('<50')).toEqual({ kind: 'lt', hi: 50 });
    expect(labNormal('<=50')).toEqual({ kind: 'lt', hi: 50 });
    expect(labNormal('>60')).toEqual({ kind: 'gt', lo: 60 });
    expect(labNormal('4.5 - 7.4')).toEqual({ kind: 'range', lo: 4.5, hi: 7.4 });
    expect(labNormal('text')).toBeNull();
  });
  it('labAbnormal flags only numeric out-of-range results', () => {
    expect(labAbnormal('33.2', '4.5 - 7.4')).toBe(true);
    expect(labAbnormal('5', '4.5 - 7.4')).toBe(false);
    expect(labAbnormal('Negatif', '4.5 - 7.4')).toBe(false); // text: never flagged
    expect(labAbnormal('55', '>60')).toBe(true);
    expect(labAbnormal('65', '>60')).toBe(false);
    expect(labAbnormal('80', '<50')).toBe(true);
    expect(labAbnormal('5', '')).toBe(false);
  });
});

describe('parseLabFile', () => {
  const LAB_HEADERS = ['No', 'Nama Pemeriksaan', 'Hasil Pemeriksaan', 'Komentar', 'Nilai Normal', 'Satuan', 'Keterangan', 'Tanggal Hasil'];

  it('tracks Jenis sections, skips empty REPORT footer, keeps data-carrying REPORT (Resistensi)', () => {
    const rep = parseLabFile([{
      name: 'S1',
      rows: [
        LAB_HEADERS,
        ['Jenis: Darah', '', '', '', '', '', '', ''],
        ['1', 'Hemoglobin', '12.5', '', '12 - 16', 'g/dL', '', '2026-08-20'],
        ['2', 'WBC', '11.2', '', '4.5 - 10.5', '10^3/uL', 'Dilaporkan', '2026-08-21'],
        ['3', 'REPORT', '', '', '', '', '', ''],
        ['4', 'REPORT', '', 'Extended Spectrum Beta Lactamase(ESBL)', '', '', '', '2026-08-21'],
      ],
    }]);
    expect(rep).not.toBeNull();
    const tests = rep!.tests;
    expect(tests.map((t) => t.nama)).toEqual(['Hemoglobin', 'WBC', 'Resistensi']);
    expect(tests[0].jenis).toBe('Darah');
    expect(tests[1].abnormal).toBe(true);
    expect(tests[1].kritis).toBe(true);
    expect(tests[2].komentar).toBe('Extended Spectrum Beta Lactamase(ESBL)');
    expect(rep!.maxDate).toBe('2026-08-21');
  });

  it('overrides normal values for eGFR (>60) and GD POCT (70 - 139)', () => {
    const rep = parseLabFile([{
      name: 'S1',
      rows: [
        LAB_HEADERS,
        ['1', 'eGFR', '55', '', '90', 'mL/min', '', ''],
        ['2', 'GD Sewaktu (POCT)', '150', '', '100 - 200', 'mg/dL', '', ''],
      ],
    }]);
    const egfr = rep!.tests.find((t) => t.nama === 'eGFR')!;
    const gd = rep!.tests.find((t) => t.nama.startsWith('GD'))!;
    expect(egfr.normal).toBe('>60');
    expect(egfr.abnormal).toBe(true); // 55 < 60
    expect(gd.normal).toBe('70 - 139');
    expect(gd.abnormal).toBe(true); // 150 > 139
  });

  it('returns null without a recognizable header', () => {
    expect(parseLabFile([{ name: 'S1', rows: [['a'], ['b']] }])).toBeNull();
  });
});
