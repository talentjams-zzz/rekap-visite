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
