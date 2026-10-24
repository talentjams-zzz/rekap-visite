// Shared types + constants for the merge core.
// Ports the v1 data model (reference/v1/index.html) into pure TS.

export const FACILITIES = ['nusin', 'melati', 'sakura', 'observasi'] as const;
export type Facility = (typeof FACILITIES)[number];

export const CHECKLIST_ROW_ITEMS = ['telaah_resep', 'catatan_pengobatan', 'pio'] as const;
export type RowChecklistItem = (typeof CHECKLIST_ROW_ITEMS)[number];

// Per-row DAILY tasks: cleared when the patient's day advances.
export const DAILY_RESET_ITEMS: RowChecklistItem[] = ['telaah_resep', 'pio'];
export const DAILY_LOG_FIELD: Record<string, 'telaahLog' | 'catatanLog' | 'pioLog'> = {
  telaah_resep: 'telaahLog',
  catatan_pengobatan: 'catatanLog',
  pio: 'pioLog',
};

export const HISTORY_FIELDS = [
  'tglRegistrasi', 'nama', 'umur', 'kamar', 'bed',
  'dokter', 'diagnosis', 'operan', 'terapi', 'soap',
  // v2-only riwayat fields (v1 format has none of these; the v1 UI ignores
  // them): the pharmacist note and the per-visit patient checklist items,
  // snapshotted on readmission so a cleared episode keeps its history.
  'note', 'visite', 'pto', 'konseling', 'rekonsiliasi_obat', 'penelusuran_obat',
] as const;

// Per-visit (episode) patient-level checklist items, keyed by MR in the DB.
export const PATIENT_ITEM_KEYS = [
  'visite', 'pto', 'konseling', 'rekonsiliasi_obat', 'penelusuran_obat',
] as const;

export interface HistoryEntry {
  date: string;
  tglRegistrasi?: string;
  nama?: string;
  umur?: string;
  kamar?: string;
  bed?: string;
  dokter?: string;
  diagnosis?: string;
  operan?: string;
  terapi?: string;
  soap?: string;
  note?: string;
  visite?: string;
  pto?: string;
  konseling?: string;
  rekonsiliasi_obat?: string;
  penelusuran_obat?: string;
}

/** A confirmed new treatment episode (readmission) detected during a merge.
 *  episodeEnd = the old episode's last report date (where its state was
 *  snapshotted before the current-treatment fields were cleared). */
export interface ReadmissionEvent {
  rowId: string;
  mr: string;
  episodeEnd: string;
}

export interface LogEntry {
  date: string;
  ts: string;
}

/** One patient per facility — mirrors the v1 row shape (latest day's fields). */
/** ASO = "obat yang harus berhenti" (med to stop). v1 row.aso list item. */
export interface AsoMed {
  id: string;
  name: string;
  stopDate: string; // YYYY-MM-DD
  stopped: boolean;
  stoppedAt: string | null;
}

export interface PatientRow {
  id: string; // "{mr}_{facility}"
  mr: string;
  facility: Facility;
  dateAdded: string; // latest report date containing this patient
  lastSeen: string | null; // latest INPUT timestamp (registry files only)
  tglRegistrasi: string;
  nama: string;
  umur: string;
  kamar: string;
  bed: string;
  dokter: string;
  diagnosis: string;
  operan: string;
  terapi: string;
  checklist: Record<RowChecklistItem, string | null>;
  pharmacistNote: string;
  /** Daily free-text SOAP note. Cleared when a new day's file arrives; the
   * previous day's value lives on in that day's history snapshot (riwayat). */
  soap: string;
  aso: AsoMed[];
  rev: number; // optimistic-concurrency revision (DB-bumped on row writes)
  archived: boolean;
  archivedAt: string | null;
  telaahLog: LogEntry[];
  catatanLog: LogEntry[];
  pioLog: LogEntry[];
  history: HistoryEntry[]; // one snapshot per day, newest first
}

/** In-memory world state the merge core mutates. */
export interface WorldState {
  rows: PatientRow[];
  facilityLatestInput: Record<string, string>;
}

export type Sheet = unknown[][];

/** One parsed Excel file, ready for the merge core (no xlsx dependency). */
export interface ParsedFile {
  filename: string;
  facility: Facility;
  reportDate: string; // YYYY-MM-DD (from filename)
  inputTs: string; // YYYY-MM-DD HH:MM:SS (filename date + mtime time)
  kind: 'registry' | 'handover';
  sheets: { name: string; rows: Sheet }[]; // in workbook order
}

export interface MergeResult {
  added: number;
  merged: number;
  warnings: string[];
  readmissions: ReadmissionEvent[];
}

export interface BatchResult extends MergeResult {
  files: number;
  sync: { archived: number; unarchived: number };
}
