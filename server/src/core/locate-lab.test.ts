// v2.1: the upload path converts worksheets lazily via locateLabSheet —
// lock in its behavior (first-20-rows header scan, case-insensitive).
import { describe, expect, it } from 'vitest';
import { locateLabSheet } from './parsers.js';
import type { Sheet } from './types.js';

describe('locateLabSheet', () => {
  it('finds the header row in the first 20 rows', () => {
    const rows: Sheet = [
      ['Laporan Hasil Pemeriksaan'],
      [],
      ['Nama Pemeriksaan', 'Hasil Pemeriksaan', 'Nilai Normal'],
      ['Hb', '12', '12-16'],
    ];
    expect(locateLabSheet(rows)).toBe(2);
  });

  it('is case-insensitive and matches partial cell text', () => {
    const rows: Sheet = [['xx', 'NAMA PEMERIKSAAN yy', 'zz']];
    expect(locateLabSheet(rows)).toBe(0);
  });

  it('returns -1 when no header is found in the first 20 rows', () => {
    const rows: Sheet = Array.from({ length: 25 }, (_, i) => [`row ${i}`]);
    expect(locateLabSheet(rows)).toBe(-1);
  });

  it('returns -1 for an empty sheet', () => {
    expect(locateLabSheet([])).toBe(-1);
  });
});
