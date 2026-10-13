import { describe, expect, it } from 'vitest';
import { cleanVal, normalizeHeader, parseDate } from './text.js';

describe('cleanVal', () => {
  it('null/undefined -> empty string', () => {
    expect(cleanVal(null)).toBe('');
    expect(cleanVal(undefined)).toBe('');
  });
  it('trims and stringifies', () => {
    expect(cleanVal('  x ')).toBe('x');
    expect(cleanVal(42)).toBe('42');
  });
});

describe('normalizeHeader', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeHeader('No. Rekam Medis')).toBe('no rekam medis');
    expect(normalizeHeader('DPJP')).toBe('dpjp');
  });
});

describe('parseDate', () => {
  it('keeps ISO date + time (Tgl Reg time sorting)', () => {
    expect(parseDate('2026-09-18 15:31:39')).toBe('2026-09-18 15:31:39');
  });
  it('keeps ISO date only', () => {
    expect(parseDate('2026-09-18')).toBe('2026-09-18');
  });
  it('converts DD/MM/YYYY', () => {
    expect(parseDate('18/09/2026')).toBe('2026-09-18');
  });
  it('converts DD-MM-YYYY', () => {
    expect(parseDate('18-09-2026')).toBe('2026-09-18');
  });
  it('pads short times to HH:MM:SS', () => {
    expect(parseDate('2026/09/18 14:05')).toBe('2026-09-18 14:05:00');
  });
  it('converts 5-digit Excel serials (46283 = 2026-09-18)', () => {
    expect(parseDate(46283)).toBe('2026-09-18');
    expect(parseDate('46261')).toBe('2026-08-27');
  });
  it('empty -> empty', () => {
    expect(parseDate('')).toBe('');
    expect(parseDate(null)).toBe('');
  });
  it('unparseable -> original string', () => {
    expect(parseDate('n/a')).toBe('n/a');
  });
});
