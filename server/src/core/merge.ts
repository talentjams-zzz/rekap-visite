// Merge rules: row identity, riwayat history, daily-task reset, auto-archive.
// Faithful port of reference/v1/index.html (comments preserved).
import {
  DAILY_LOG_FIELD,
  DAILY_RESET_ITEMS,
  HISTORY_FIELDS,
  type HistoryEntry,
  type LogEntry,
  type PatientRow,
  type WorldState,
} from './types.js';

export function rowId(mr: string, facility: string): string {
  return mr + '_' + facility;
}

/**
 * Find the row for an MR + facility, tolerating leading-zero differences.
 * Excel sometimes exports MEDREC as a NUMBER (067016 -> 67016); without this,
 * a numeric MR would create a DUPLICATE row. Returns the existing row's
 * CANONICAL MR so new data lands on the right row.
 */
export function findRowByMR(
  rows: PatientRow[],
  mr: string,
  facility: string,
): { row: PatientRow | null; canonicalMr: string } {
  const exact = rows.find((r) => r.id === rowId(mr, facility));
  if (exact) return { row: exact, canonicalMr: exact.mr };
  const digits = String(mr).replace(/^0+/, '') || '0';
  const match = rows.find(
    (r) => r.facility === facility && ((String(r.mr).replace(/^0+/, '')) || '0') === digits,
  );
  if (match) return { row: match, canonicalMr: match.mr };
  return { row: null, canonicalMr: mr };
}

/**
 * Keep one snapshot per day in row.history (newest first). Re-recording the
 * same day updates that day's entry in place (idempotent re-import).
 */
export function recordHistory(row: PatientRow, date: string, fields: Partial<HistoryEntry>): void {
  if (!row.history) row.history = [];
  let e = row.history.find((x) => x.date === date);
  if (!e) {
    e = { date };
    row.history.push(e);
  }
  for (const k of HISTORY_FIELDS) {
    const v = fields[k];
    if (v != null && v !== '') e[k] = v;
  }
  row.history.sort((a, b) => String(b.date).localeCompare(String(a.date))); // newest first
}

/**
 * Daily-task reset + date advancement.
 * - When the patient appears in a NEW (later) day's file (today > dateAdded),
 *   the previous day's DAILY_RESET_ITEMS checks are stale -> cleared and
 *   archived into the per-item log (one entry per date, newest ts wins).
 *   Catatan Pengobatan is NOT reset (one-time per-patient task).
 * - Same-day re-import (today == dateAdded) keeps the checks (idempotent).
 * - An OLDER file loaded out of order clears nothing and never rolls
 *   dateAdded back.
 * - lastSeen (input timestamp) only advances, never rolls back.
 * - advanceLastSeen=false for handover (operan) files: they are a subset of
 *   the patients and must not move a row onto the facility's "latest input".
 */
export function touchRowDate(
  row: PatientRow,
  today: string,
  ts: string,
  advanceLastSeen = true,
): void {
  if (!row.checklist) row.checklist = { telaah_resep: null, catatan_pengobatan: null, pio: null };
  if (today > row.dateAdded) {
    for (const key of DAILY_RESET_ITEMS) {
      const tsv = row.checklist[key];
      if (tsv) {
        const logField = DAILY_LOG_FIELD[key];
        if (!row[logField]) row[logField] = [];
        const d = tsv.slice(0, 10);
        const i = row[logField].findIndex((e: LogEntry) => e.date === d);
        if (i >= 0) row[logField][i] = { date: d, ts: tsv };
        else row[logField].push({ date: d, ts: tsv });
      }
      row.checklist[key] = null;
    }
  }
  if (today > row.dateAdded) row.dateAdded = today;
  if (advanceLastSeen && ts && (!row.lastSeen || ts > row.lastSeen)) row.lastSeen = ts;
}

/**
 * Auto archive / unarchive based on latest input data.
 * A patient is ACTIVE iff they appear in their facility's LATEST INPUT
 * (newest input TIMESTAMP, not just date). After each load:
 *  - a patient missing from the latest input is auto-ARCHIVED
 *  - an archived patient who reappears in the latest input returns to ACTIVE
 * facilityLatestInput is authoritative where present (advances even for an
 * empty daily report). Facilities with no tracked input fall back to the
 * newest row lastSeen.
 */
export function syncArchiveState(state: WorldState, nowTs: string): { archived: number; unarchived: number } {
  const latestByFacility: Record<string, string> = { ...state.facilityLatestInput };
  for (const r of state.rows) {
    if (!r.lastSeen || state.facilityLatestInput[r.facility]) continue;
    if (!latestByFacility[r.facility] || r.lastSeen > latestByFacility[r.facility]) {
      latestByFacility[r.facility] = r.lastSeen;
    }
  }
  let archived = 0;
  let unarchived = 0;
  for (const r of state.rows) {
    const latest = latestByFacility[r.facility];
    if (latest == null) continue; // no input recorded for this facility yet
    const inLatest = r.lastSeen === latest;
    if (inLatest && r.archived) {
      r.archived = false;
      r.archivedAt = null;
      unarchived++;
    } else if (!inLatest && !r.archived) {
      r.archived = true;
      r.archivedAt = nowTs;
      archived++;
    }
  }
  return { archived, unarchived };
}
