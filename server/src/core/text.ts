// Cell/value text helpers. Ported from reference/v1/index.html.

export function cleanVal(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Excel serial date (5-digit integer) -> YYYY-MM-DD. Epoch 1899-12-30 accounts
// for the Lotus 1-2-3 1900 leap-year bug for all serials >= 61 (modern reports).
// 46283 -> 2026-09-18, 46261 -> 2026-08-27.
function excelSerialToDate(serial: number): string {
  const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * Normalize a source date cell to "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS".
 * Keeps the time part when present (Tgl Reg sorts by time). Ported from v1.
 */
export function parseDate(v: unknown): string {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  const sp = s.indexOf(' ');
  const datePart = sp > 0 ? s.slice(0, sp) : s;
  const timePart = sp > 0 ? s.slice(sp + 1) : '';
  let date = '';
  if (/^\d{5}$/.test(datePart)) {
    date = excelSerialToDate(parseInt(datePart, 10));
  } else if (datePart.includes('-')) {
    const parts = datePart.split('-');
    if (parts[0].length === 4) date = parts.join('-');
    else if (parts[2] && parts[2].length === 4) date = `${parts[2]}-${parts[1]}-${parts[0]}`;
  } else if (datePart.includes('/')) {
    const parts = datePart.split('/');
    if (parts[0].length === 4) date = parts.join('-');
    else if (parts[2] && parts[2].length === 4) date = `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  if (!date) return s;
  const tm = timePart.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (tm) {
    const p = (n: string | number) => String(n).padStart(2, '0');
    return `${date} ${p(tm[1])}:${p(tm[2])}:${p(tm[3] || 0)}`;
  }
  return date;
}
