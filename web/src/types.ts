// UI row DTO — matches GET /api/rows.
export interface RowDto {
  id: string;
  mr: string;
  facility: string;
  dateAdded: string | null;
  tglRegistrasi: string | null;
  nama: string | null;
  umur: string | null;
  kamar: string | null;
  bed: string | null;
  dokter: string | null;
  diagnosis: string | null;
  operan: string | null;
  terapi: string | null;
  pharmacistNote: string | null;
  archived: boolean;
  archivedAt: string | null;
  lastSeen: string | null;
  dayCount: number;
  checklist: Record<string, string | null>;
}

export const FACILITIES = ['nusin', 'melati', 'sakura', 'observasi'] as const;
export type Facility = (typeof FACILITIES)[number];

export type Tab = Facility | 'archived' | 'rekap';

export const CHECKLIST_LABELS: [string, string][] = [
  ['telaah_resep', 'TR'],
  ['catatan_pengobatan', 'CP'],
  ['pio', 'PIO'],
  ['visite', 'V'],
  ['pto', 'PTO'],
  ['konseling', 'K'],
  ['rekonsiliasi_obat', 'RO'],
  ['penelusuran_obat', 'PO'],
];

/** Row-level items (per patient+facility); the rest are patient-level (per MR). */
export const ROW_ITEM_KEYS = new Set(['telaah_resep', 'catatan_pengobatan', 'pio']);

/** Fields editable in place (v1 EDITABLE_KEYS). */
export const EDITABLE_KEYS = ['diagnosis', 'operan', 'terapi', 'pharmacistNote'] as const;
export type EditableKey = (typeof EDITABLE_KEYS)[number];

export interface HistoryEntry {
  date: string;
  tglRegistrasi: string | null;
  nama: string | null;
  umur: string | null;
  kamar: string | null;
  bed: string | null;
  dokter: string | null;
  diagnosis: string | null;
  operan: string | null;
  terapi: string | null;
}

/** Client-side 'YYYY-MM-DD HH:MM:SS' (v1 nowDT()). */
export function nowTs(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
