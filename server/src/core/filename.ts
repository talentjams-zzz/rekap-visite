// Filename -> facility / report date / input timestamp.
// Ported from reference/v1/index.html.
import { FACILITIES, type Facility } from './types.js';

export function detectFacility(filename: string): Facility | null {
  const lower = filename.toLowerCase();
  for (const f of FACILITIES) {
    if (lower.includes(f)) return f;
  }
  return null;
}

/**
 * Extract the report date from the filename (e.g. "nusin 27-08-26.xlsx" -> "2026-08-27").
 * Supports DD-M-YY, DD-MM-YY, DD-M-YYYY, DD-MM-YYYY (also with dots).
 * Falls back to `today` when no (valid) date is found. `today` is injected for
 * determinism (v1 used todayStr()).
 * CRITICAL for riwayat: each file in a batch must keep its OWN date.
 */
export function dateFromFilename(filename: string, today: string): string {
  const m = filename.toLowerCase().match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})/);
  if (!m) return today;
  const day = parseInt(m[1], 10);
  const mon = parseInt(m[2], 10);
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  if (day < 1 || day > 31 || mon < 1 || mon > 12) return today;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${year}-${p(mon)}-${p(day)}`;
}

/**
 * INPUT TIMESTAMP = filename date + file last-modified TIME. A later day always
 * wins (filename date dominates); within the same day the newest upload wins
 * (mtime time breaks the tie). This is what drives auto-archive.
 */
export function inputTimestamp(fileDate: string, lastModifiedMs: number | null): string {
  if (lastModifiedMs == null) return `${fileDate} 00:00:00`;
  const d = new Date(lastModifiedMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${fileDate} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
