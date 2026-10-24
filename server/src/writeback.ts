// Write-back: after every v2 change, re-serialize the DB to v1's
// master_data.json format so the frozen v1 app (still the production
// fallback) can load the exact current state at any time.
//
// Guarantees:
//  - version is bumped (like a v1 save) so v1's baseVersion concurrency and
//    v2's poll gate (isSourceNewer) stay consistent — a write-back never
//    triggers a re-migration of v2's own file.
//  - legacy per-row fields v2 does not model (telaahLog / catatanLog /
//    pioLog — v1's per-day checklist archives) are carried through from the
//    existing file, keyed by row id. Dropping them would erase completed
//    past-day checklist history from v1's point of view.
//  - colWidths / labColWidths (v1 UI state) are carried through unchanged.
//  - atomic write (tmp + rename) so v1 never reads a half-written file.
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export interface WriteBackResult {
  version: number;
  rows: number;
}

type V1Like = {
  savedAt?: string;
  rows?: Record<string, unknown>[];
  patientChecklist?: Record<string, Record<string, string | null>>;
  labResults?: Record<string, unknown>;
  facilityLatestInput?: Record<string, string>;
  colWidths?: unknown;
  labColWidths?: unknown;
  version?: number;
};

const LEGACY_ROW_KEYS = ['telaahLog', 'catatanLog', 'pioLog'] as const;

/** Corrupted JSON in a DB column must not abort the whole write-back. */
function parseJsonArray<T>(raw: string | null | undefined, fallback: T[]): T[] {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : fallback;
  } catch {
    return fallback;
  }
}

// ASYNC on purpose: the file write is multi-MB and, on Windows, antivirus
// real-time protection can stall a synchronous write for seconds — which
// would block the event loop and freeze every in-flight HTTP request.
export async function writeBackToV1(
  db: DatabaseSync,
  masterFile: string,
): Promise<WriteBackResult | null> {
  let existing: V1Like;
  try {
    existing = JSON.parse(await readFile(masterFile, 'utf8')) as V1Like;
  } catch {
    return null; // missing/unreadable file — never clobber what we can't parse
  }

  const legacyByRowId = new Map<string, Record<string, unknown>>(
    (existing.rows ?? []).map((r) => [String(r.id), r as Record<string, unknown>]),
  );

  const patients = db
    .prepare(
      `SELECT id, mr, facility, date_added, tgl_registrasi, nama, umur, kamar, bed, dokter,
              diagnosis, operan, terapi, pharmacist_note, soap, aso_json, archived, archived_at, last_seen
       FROM patients`,
    )
    .all() as Record<string, unknown>[];

  const histStmt = db.prepare(
    `SELECT report_date, tgl_registrasi, nama, umur, kamar, bed, dokter, diagnosis, operan, terapi, soap,
            pharmacist_note, visite, pto, konseling, rekonsiliasi_obat, penelusuran_obat
     FROM patient_days WHERE patient_id = ? AND report_date != ? ORDER BY report_date DESC`,
  );
  const chkStmt = db.prepare('SELECT item_key, checked_at FROM row_checklist WHERE patient_id = ?');

  const rows = patients.map((p) => {
    const legacy = legacyByRowId.get(String(p.id)) ?? {};
    const checklist: Record<string, string | null> = {
      telaah_resep: null,
      catatan_pengobatan: null,
      pio: null,
    };
    for (const c of chkStmt.all(p.id as string) as { item_key: string; checked_at: string | null }[]) {
      checklist[c.item_key] = c.checked_at;
    }
    const history = (
      histStmt.all(p.id as string, (p.date_added as string | null) ?? '') as Record<string, unknown>[]
    ).map((h) => ({
      date: String(h.report_date),
      tglRegistrasi: (h.tgl_registrasi as string) ?? null,
      nama: (h.nama as string) ?? null,
      umur: (h.umur as string) ?? null,
      kamar: (h.kamar as string) ?? null,
      bed: (h.bed as string) ?? null,
      dokter: (h.dokter as string) ?? null,
      diagnosis: (h.diagnosis as string) ?? null,
      operan: (h.operan as string) ?? null,
      terapi: (h.terapi as string) ?? null,
      soap: (h.soap as string) ?? null,
      // v2-only riwayat fields (readmission snapshot); v1 ignores unknown keys
      note: (h.pharmacist_note as string) ?? null,
      visite: (h.visite as string) ?? null,
      pto: (h.pto as string) ?? null,
      konseling: (h.konseling as string) ?? null,
      rekonsiliasi_obat: (h.rekonsiliasi_obat as string) ?? null,
      penelusuran_obat: (h.penelusuran_obat as string) ?? null,
    }));

    const aso = parseJsonArray<unknown>(p.aso_json as string | null, []);
    const row: Record<string, unknown> = {
      id: p.id,
      mr: p.mr,
      facility: p.facility,
      dateAdded: p.date_added ?? null,
      tglRegistrasi: p.tgl_registrasi ?? null,
      nama: p.nama ?? null,
      umur: p.umur ?? null,
      kamar: p.kamar ?? null,
      bed: p.bed ?? null,
      dokter: p.dokter ?? null,
      diagnosis: p.diagnosis ?? null,
      operan: p.operan ?? null,
      terapi: p.terapi ?? null,
      checklist,
      // sparse like v1: only present when non-empty
      ...(aso.length > 0 ? { aso } : {}),
      pharmacistNote: (p.pharmacist_note as string) ?? '',
      soap: (p.soap as string) ?? '',
      archived: Number(p.archived) === 1,
      archivedAt: (p.archived_at as string) ?? null,
      // legacy carry-through (v1 per-day checklist archives)
      telaahLog: (legacy.telaahLog as unknown[]) ?? [],
      catatanLog: (legacy.catatanLog as unknown[]) ?? [],
      pioLog: (legacy.pioLog as unknown[]) ?? [],
      history,
      lastSeen: (p.last_seen as string) ?? null,
    };
    // preserve any other row keys v2 does not model (future-proof)
    for (const [k, v] of Object.entries(legacy)) {
      if (!(k in row) && !LEGACY_ROW_KEYS.includes(k as (typeof LEGACY_ROW_KEYS)[number])) {
        row[k] = v;
      }
    }
    return row;
  });

  const pcStmt = db.prepare('SELECT mr, item_key, checked_at FROM patient_checklist');
  const patientChecklist: Record<string, Record<string, string | null>> = {};
  for (const c of pcStmt.all() as { mr: string; item_key: string; checked_at: string | null }[]) {
    (patientChecklist[c.mr] ??= {})[c.item_key] = c.checked_at;
  }

  const labStmt = db.prepare('SELECT mr, loaded_at, max_date, tests_json FROM labs');
  const labResults: Record<string, unknown> = {};
  for (const l of labStmt.all() as { mr: string; loaded_at: string | null; max_date: string | null; tests_json: string }[]) {
    labResults[l.mr] = {
      loadedAt: l.loaded_at ?? null,
      maxDate: l.max_date ?? null,
      tests: parseJsonArray<unknown>(l.tests_json, []),
    };
  }

  const flStmt = db.prepare('SELECT facility, input_ts FROM facility_latest_input');
  const facilityLatestInput: Record<string, string> = {};
  for (const f of flStmt.all() as { facility: string; input_ts: string }[]) {
    facilityLatestInput[f.facility] = f.input_ts;
  }

  const version = (typeof existing.version === 'number' ? existing.version : 0) + 1;
  const savedAt = new Date().toISOString();
  const out = {
    savedAt,
    rows,
    patientChecklist,
    labResults,
    facilityLatestInput,
    colWidths: existing.colWidths ?? {},
    labColWidths: existing.labColWidths ?? {},
    version,
  };

  const tmp = path.join(path.dirname(masterFile), `.${path.basename(masterFile)}.v2tmp`);
  await writeFile(tmp, JSON.stringify(out, null, 2), 'utf8');
  await rename(tmp, masterFile);

  // Keep the poll gate in sync: the file now equals the DB, at this version.
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('source_version', String(version));
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('source_saved_at', savedAt);

  return { version, rows: rows.length };
}
