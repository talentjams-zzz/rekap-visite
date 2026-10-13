import { describe, expect, it } from 'vitest';
import { dateFromFilename, detectFacility, inputTimestamp } from './filename.js';

const TODAY = '2026-09-20';

describe('detectFacility', () => {
  it('detects each facility keyword', () => {
    expect(detectFacility('nusin 25-8-26.xlsx')).toBe('nusin');
    expect(detectFacility('melati-26-08-26.xlsx')).toBe('melati');
    expect(detectFacility('operan sakura 25-08-26.xlsx')).toBe('sakura');
    expect(detectFacility('OBSERVASI 20-09-26.xlsx')).toBe('observasi');
  });
  it('returns null for unknown filenames', () => {
    expect(detectFacility('random-report.xlsx')).toBeNull();
  });
});

describe('dateFromFilename', () => {
  it('parses DD-M-YY', () => {
    expect(dateFromFilename('nusin 27-08-26.xlsx', TODAY)).toBe('2026-08-27');
  });
  it('parses DD-MM-YY', () => {
    expect(dateFromFilename('melati-20-09-26.xlsx', TODAY)).toBe('2026-09-20');
  });
  it('parses 4-digit years', () => {
    expect(dateFromFilename('x 1-1-2026.xlsx', TODAY)).toBe('2026-01-01');
  });
  it('falls back to today when no date present', () => {
    expect(dateFromFilename('no-date.xlsx', TODAY)).toBe(TODAY);
  });
  it('falls back to today for invalid dates', () => {
    expect(dateFromFilename('bad 99-99-26.xlsx', TODAY)).toBe(TODAY);
  });
});

describe('inputTimestamp', () => {
  it('uses 00:00:00 when mtime unknown', () => {
    expect(inputTimestamp('2026-08-27', null)).toBe('2026-08-27 00:00:00');
  });
  it('combines filename date with mtime time', () => {
    const ms = new Date(2026, 7, 27, 7, 5, 9).getTime();
    expect(inputTimestamp('2026-08-27', ms)).toBe('2026-08-27 07:05:09');
  });
});
