// Excel sheet parsers: registry, handover (operan), lab.
// Faithful port of reference/v1/index.html — operate on plain cell arrays
// (output of XLSX.utils.sheet_to_json(ws, { header: 1 })) so the core stays
// free of the xlsx dependency.
import { findRowByMR, recordHistory, rowId, touchRowDate } from './merge.js';
import { cleanVal, normalizeHeader, parseDate } from './text.js';
import type { Facility, MergeResult, PatientRow, Sheet, WorldState } from './types.js';

function findHeaderRow(sheet: Sheet, needles: string[], maxScan = 20): number {
  for (let i = 0; i < Math.min(sheet.length, maxScan); i++) {
    const row = (sheet[i] || []).map((c) => String(c ?? '').toLowerCase());
    if (row.some((c) => needles.some((n) => c.includes(n)))) return i;
  }
  return -1;
}

/** Fresh patient row (v1 row-creation shape). */
export function newPatientRow(
  mr: string,
  facility: Facility,
  reportDate: string,
  lastSeen: string | null,
  extra: Partial<PatientRow> = {},
): PatientRow {
  return {
    id: rowId(mr, facility),
    mr,
    facility,
    dateAdded: reportDate,
    lastSeen,
    tglRegistrasi: '',
    nama: '',
    umur: '',
    kamar: '',
    bed: '',
    dokter: '',
    diagnosis: '',
    operan: '',
    terapi: '',
    checklist: { telaah_resep: null, catatan_pengobatan: null, pio: null },
    pharmacistNote: '',
    aso: [],
    rev: 0,
    archived: false,
    archivedAt: null,
    telaahLog: [],
    catatanLog: [],
    pioLog: [],
    history: [],
    ...extra,
  };
}

/**
 * Registry file ({facility} DD-M-YY.xlsx) — lists ALL active patients.
 * Header row = first row (within 20) containing "rekam". Rows need both MR
 * and Nama. Dokter Tambahan is appended to Dokter.
 */
export function parseRegistry(
  state: WorldState,
  facility: Facility,
  sheet: Sheet,
  reportDate: string,
  inputTs: string,
): MergeResult {
  const result: MergeResult = { added: 0, merged: 0, warnings: [] };
  const headerRow = findHeaderRow(sheet, ['rekam']);
  if (headerRow < 0) return result;

  const headers = (sheet[headerRow] || []).map((h) => normalizeHeader(String(h ?? '')));
  const colMap: Record<string, number> = {};
  headers.forEach((h, i) => {
    if (h.includes('rekam') && h.includes('medis')) colMap.mr = i;
    else if (h.includes('nama') && !h.includes('jenis')) colMap.nama = i;
    else if (h.includes('tgl registrasi')) colMap.tglRegistrasi = i;
    else if (h.includes('umur')) colMap.umur = i;
    else if (h.includes('kamar')) colMap.kamar = i;
    else if (h.includes('bed') && !h.includes('bedah')) colMap.bed = i;
    else if (h.includes('dokter') && !h.includes('tambahan')) colMap.dokter = i;
    else if (h.includes('dokter tambahan')) colMap.dokterTambahan = i;
  });

  for (let i = headerRow + 1; i < sheet.length; i++) {
    const row = sheet[i] || [];
    const mr = cleanVal(row[colMap.mr]);
    if (!mr) continue;
    const nama = cleanVal(row[colMap.nama]);
    if (!nama) continue;
    let dokter = cleanVal(row[colMap.dokter]);
    const dt = cleanVal(row[colMap.dokterTambahan]);
    if (dt) dokter += ', ' + dt;
    const tglReg = parseDate(cleanVal(row[colMap.tglRegistrasi]));
    const umur = cleanVal(row[colMap.umur]);
    const kamar = cleanVal(row[colMap.kamar]);
    const bed = cleanVal(row[colMap.bed]);

    // Tolerant MR match: numeric MR (leading zero dropped by Excel) merges
    // into the existing zero-padded row instead of creating a duplicate.
    const { row: existing, canonicalMr } = findRowByMR(state.rows, mr, facility);
    if (existing) {
      // Latest file wins for every data field; note/archive are untouched.
      // Telaah Resep (daily task) is cleared when the day advances.
      touchRowDate(existing, reportDate, inputTs);
      existing.nama = nama;
      existing.tglRegistrasi = tglReg || existing.tglRegistrasi;
      existing.umur = umur || existing.umur;
      existing.kamar = kamar || existing.kamar;
      existing.bed = bed || existing.bed;
      existing.dokter = dokter || existing.dokter;
      recordHistory(existing, reportDate, { tglRegistrasi: tglReg, nama, umur, kamar, bed, dokter });
      result.merged++;
    } else {
      state.rows.push(
        newPatientRow(canonicalMr, facility, reportDate, inputTs, {
          tglRegistrasi: tglReg,
          nama,
          umur,
          kamar,
          bed,
          dokter,
          history: [
            { date: reportDate, tglRegistrasi: tglReg, nama, umur, kamar, bed, dokter },
          ],
        }),
      );
      result.added++;
    }
  }
  return result;
}

interface HandoverPatient {
  mr: string;
  nama: string;
  kamar: string;
  bed: string;
  dokter: string;
  diagnosis: string;
  operan: string;
  terapi: string;
}

function flushHandoverPatient(
  state: WorldState,
  facility: Facility,
  p: HandoverPatient,
  reportDate: string,
  inputTs: string,
  result: MergeResult,
): void {
  const { row: existing, canonicalMr } = findRowByMR(state.rows, p.mr, facility);
  if (existing) {
    // advanceLastSeen=false: the handover file is a subset of the patients,
    // so it must not move this row onto the facility's "latest input".
    touchRowDate(existing, reportDate, inputTs, false);
    if (p.diagnosis) existing.diagnosis = p.diagnosis;
    if (p.operan) existing.operan = p.operan;
    if (p.terapi) existing.terapi = p.terapi;
    if (p.dokter) existing.dokter = p.dokter;
    if (p.nama) existing.nama = p.nama;
    if (p.kamar) existing.kamar = p.kamar;
    if (p.bed) existing.bed = p.bed;
    recordHistory(existing, reportDate, {
      nama: p.nama, kamar: p.kamar, bed: p.bed, dokter: p.dokter,
      diagnosis: p.diagnosis, operan: p.operan, terapi: p.terapi,
    });
    result.merged++;
  } else {
    // Handover loaded without a registry row yet. lastSeen stays null: the
    // handover file is not the authoritative active list, so this row must
    // not count as "in the latest input" (it stays archived until a registry
    // file actually lists the patient).
    state.rows.push(
      newPatientRow(canonicalMr, facility, reportDate, null, {
        nama: p.nama,
        kamar: p.kamar,
        bed: p.bed,
        dokter: p.dokter,
        diagnosis: p.diagnosis,
        operan: p.operan,
        terapi: p.terapi,
        history: [
          {
            date: reportDate, nama: p.nama, kamar: p.kamar, bed: p.bed,
            dokter: p.dokter, diagnosis: p.diagnosis, operan: p.operan, terapi: p.terapi,
          },
        ],
      }),
    );
    result.added++;
  }
}

/**
 * Handover (operan) file — Nusin only, a SUBSET of patients with
 * diagnosis/operan/terapi notes. Header row contains "medrec". Multi-line
 * cells continue on rows with an empty MR (appended with newlines).
 * Warnings: data in unlabeled columns (silent data-loss guard, v1 toast).
 */
export function parseHandover(
  state: WorldState,
  facility: Facility,
  sheets: { name: string; rows: Sheet }[],
  reportDate: string,
  inputTs: string,
  filename: string,
): MergeResult {
  const result: MergeResult = { added: 0, merged: 0, warnings: [] };
  for (const { name: sheetName, rows: sheet } of sheets) {
    const headerRow = findHeaderRow(sheet, ['medrec']);
    if (headerRow < 0) continue;

    const headers = (sheet[headerRow] || []).map((h) => normalizeHeader(String(h ?? '')));
    const colMap: Record<string, number> = {};
    headers.forEach((h, i) => {
      if (h.includes('medrec') || (h.includes('rekam') && h.includes('medis'))) colMap.mr = i;
      else if (h.includes('nama')) colMap.nama = i;
      else if (h.includes('kamar')) colMap.kamar = i;
      else if (h.includes('bed') && !h.includes('bedah')) colMap.bed = i;
      else if (h.includes('dpjp') || h.includes('dokter')) colMap.dokter = i;
      else if (h.includes('diagnosa') || h.includes('diagnosis')) colMap.diagnosis = i;
      else if (h.includes('operan')) colMap.operan = i;
      else if (h.includes('terapi')) colMap.terapi = i;
    });

    // Fallback: TERAPI header blank but the column right after OPERAN holds
    // real data (fixed operan layout: ...OPERAN, TERAPI).
    if (colMap.operan != null && colMap.terapi == null) {
      const cand = colMap.operan + 1;
      let hasData = false;
      for (let i = headerRow + 1; i < sheet.length && !hasData; i++) {
        if (cleanVal((sheet[i] || [])[cand]).length >= 10) hasData = true;
      }
      if (hasData) colMap.terapi = cand;
    }

    // Silent data-loss guard: real data (>=10 chars, >=2 rows) in a column
    // beyond the last labeled column -> warn (v1 toast).
    const labeled = Object.values(colMap);
    const maxLabeled = labeled.length ? Math.max(...labeled) : -1;
    const orphanCount: Record<number, number> = {};
    for (let i = headerRow + 1; i < sheet.length; i++) {
      const row = sheet[i] || [];
      for (let ci = maxLabeled + 1; ci < row.length; ci++) {
        if (cleanVal(row[ci]).length >= 10) orphanCount[ci] = (orphanCount[ci] || 0) + 1;
      }
    }
    const orphanCols = Object.keys(orphanCount)
      .map(Number)
      .filter((ci) => orphanCount[ci] >= 2)
      .sort((a, b) => a - b);
    if (orphanCols.length) {
      result.warnings.push(
        `${filename} sheet "${sheetName}": data in unlabeled column(s) ` +
          orphanCols.map((ci) => `#${ci + 1}`).join(', ') +
          ' — those fields were NOT loaded (missing header label).',
      );
    }

    let current: HandoverPatient | null = null;
    const flush = () => {
      if (current) {
        flushHandoverPatient(state, facility, current, reportDate, inputTs, result);
        current = null;
      }
    };
    for (let i = headerRow + 1; i < sheet.length; i++) {
      const row = sheet[i] || [];
      const mrVal = cleanVal(row[colMap.mr]);
      if (mrVal) {
        flush();
        current = {
          mr: mrVal,
          nama: cleanVal(row[colMap.nama]),
          kamar: cleanVal(row[colMap.kamar]),
          bed: cleanVal(row[colMap.bed]),
          dokter: cleanVal(row[colMap.dokter]),
          diagnosis: cleanVal(row[colMap.diagnosis]),
          operan: cleanVal(row[colMap.operan]),
          terapi: cleanVal(row[colMap.terapi]),
        };
      } else if (current) {
        const d = cleanVal(row[colMap.diagnosis]);
        if (d) current.diagnosis += '\n' + d;
        const o = cleanVal(row[colMap.operan]);
        if (o) current.operan += '\n' + o;
        const t = cleanVal(row[colMap.terapi]);
        if (t) current.terapi += '\n' + t;
      }
    }
    flush();
  }
  return result;
}

// ── Lab results (Hasil Lab) ─────────────────────────────────────────────
// One lab report per patient (MR). The LATEST report completely replaces the
// previous one. Header row contains "nama pemeriksaan".
export interface LabTest {
  nama: string;
  hasil: string;
  komentar: string;
  normal: string;
  satuan: string;
  keterangan: string;
  tanggal: string;
  jenis: string;
  abnormal: boolean;
  kritis: boolean;
}

export interface LabReport {
  loadedAt: string | null;
  maxDate: string;
  tests: LabTest[];
}

export function parseLabFile(sheets: { name: string; rows: Sheet }[]): LabReport | null {
  let json: Sheet | null = null;
  let headerRow = -1;
  for (const { rows } of sheets) {
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const row = (rows[i] || []).map((c) => String(c ?? '').toLowerCase());
      if (row.some((c) => c.includes('nama pemeriksaan'))) {
        json = rows;
        headerRow = i;
        break;
      }
    }
    if (headerRow >= 0) break;
  }
  if (headerRow < 0 || !json) return null;

  const headers = (json[headerRow] || []).map((h) => normalizeHeader(String(h ?? '')));
  const colMap: Record<string, number> = {};
  headers.forEach((h, i) => {
    if (h.includes('nama pemeriksaan')) colMap.nama = i;
    else if (h.includes('hasil pemeriksaan')) colMap.hasil = i;
    else if (h.includes('komentar')) colMap.komentar = i;
    else if (h.includes('nilai normal')) colMap.normal = i;
    else if (h.includes('satuan')) colMap.satuan = i;
    else if (h.includes('keterangan')) colMap.keterangan = i;
    else if (h.includes('tanggal hasil')) colMap.tanggal = i;
  });
  if (colMap.nama == null || colMap.hasil == null) return null;

  const tests: LabTest[] = [];
  let maxDate = '';
  let currentJenis = '';
  for (let i = headerRow + 1; i < json.length; i++) {
    const row = json[i] || [];
    // "Jenis: X" section markers sit in column A; track the current category.
    const a = cleanVal(row[0]);
    if (a.toLowerCase().startsWith('jenis')) {
      currentJenis = a.replace(/^jenis[:\s]*/i, '').trim();
      continue;
    }
    const nama = cleanVal(row[colMap.nama]);
    if (!nama) continue;
    const hasil = cleanVal(row[colMap.hasil]);
    const komentar = colMap.komentar != null ? cleanVal(row[colMap.komentar]) : '';
    const keterangan = colMap.keterangan != null ? cleanVal(row[colMap.keterangan]) : '';
    // A "REPORT" row is normally the trailing footer (skip). But in the
    // Resistensi (antibiotic-resistance) section the finding lives in a
    // REPORT row (result text in Komentar). Keep it only if it carries data.
    const isReport = /^report$/i.test(nama);
    if (isReport && !hasil && !komentar && !keterangan) continue;
    let normal = colMap.normal != null ? cleanVal(row[colMap.normal]) : '';
    // eGFR: always override the normal value to ">60" (abnormal when < 60).
    if (/egfr/i.test(nama)) normal = '>60';
    // GD (POCT) tests: always override the normal value to "70 - 139".
    else if (/^gd\b.*\(poct\)/i.test(nama)) normal = '70 - 139';
    const satuan = colMap.satuan != null ? cleanVal(row[colMap.satuan]) : '';
    const tanggal = colMap.tanggal != null ? cleanVal(row[colMap.tanggal]) : '';
    if (tanggal > maxDate) maxDate = tanggal;
    tests.push({
      nama: isReport ? 'Resistensi' : nama,
      hasil,
      komentar,
      normal,
      satuan,
      keterangan,
      tanggal,
      jenis: currentJenis,
      abnormal: labAbnormal(hasil, normal),
      kritis: keterangan.toLowerCase().includes('dilaporkan'),
    });
  }
  if (!tests.length) return null;
  return { loadedAt: null, maxDate, tests };
}

// A test is abnormal when BOTH the result and the normal value are numeric and
// the result falls outside the normal range/bound. Text values are never
// flagged — no false positives.
export function labAbnormal(hasil: string, normal: string): boolean {
  const v = labNum(hasil);
  if (v == null) return false;
  const n = labNormal(normal);
  if (!n) return false;
  if (n.kind === 'range') return !(n.lo <= v && v <= n.hi);
  if (n.kind === 'lt') return v > n.hi;
  if (n.kind === 'gt') return v < n.lo;
  return false;
}

export type NormalSpec =
  | { kind: 'range'; lo: number; hi: number }
  | { kind: 'lt'; hi: number }
  | { kind: 'gt'; lo: number };

/** Leading number of a value (handles "33.2", "(-2)", "+2", "1.015"). */
export function labNum(s: string | null): number | null {
  if (s == null) return null;
  const m = String(s).trim().match(/^\(?([+-]?\d+(?:\.\d+)?)\)?/);
  return m ? parseFloat(m[1]) : null;
}

/** Parse a "Nilai Normal" into a NormalSpec or null. */
export function labNormal(s: string | null): NormalSpec | null {
  if (s == null) return null;
  s = String(s).trim();
  if (!s) return null;
  let m = s.match(/^<=?\s*\(?([+-]?\d+(?:\.\d+)?)\)?\s*$/);
  if (m) return { kind: 'lt', hi: parseFloat(m[1]) };
  m = s.match(/^>=?\s*\(?([+-]?\d+(?:\.\d+)?)\)?\s*$/);
  if (m) return { kind: 'gt', lo: parseFloat(m[1]) };
  m = s.match(/^\(?([+-]?\d+(?:\.\d+)?)\)?\s*-\s*\(?([+-]?\d+(?:\.\d+)?)\)?\s*$/);
  if (m) return { kind: 'range', lo: parseFloat(m[1]), hi: parseFloat(m[2]) };
  return null;
}
