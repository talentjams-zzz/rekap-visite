// Bridge between SQLite and the in-memory merge core (WorldState).
import type { DatabaseSync } from 'node:sqlite';
import {
  type Facility,
  type HistoryEntry,
  type LogEntry,
  type PatientRow,
  type RowChecklistItem,
  type WorldState,
} from './core/types.js';

type Rec = Record<string, unknown>;

export function loadWorldState(db: DatabaseSync): WorldState {
  const rows = db.prepare('SELECT * FROM patients').all() as Rec[];
  const days = db
    .prepare('SELECT patient_id, report_date, tgl_registrasi, nama, umur, kamar, bed, dokter, diagnosis, operan, terapi FROM patient_days')
    .all() as Rec[];
  const rc = db.prepare('SELECT patient_id, item_key, checked_at FROM row_checklist').all() as Rec[];
  const logs = db.prepare('SELECT patient_id, item_key, date, ts FROM daily_logs').all() as Rec[];
  const fli = db.prepare('SELECT facility, input_ts FROM facility_latest_input').all() as Rec[];

  const daysBy = new Map<string, HistoryEntry[]>();
  for (const d of days) {
    const list = daysBy.get(String(d.patient_id)) ?? [];
    list.push({
      date: String(d.report_date),
      tglRegistrasi: (d.tgl_registrasi as string) ?? undefined,
      nama: (d.nama as string) ?? undefined,
      umur: (d.umur as string) ?? undefined,
      kamar: (d.kamar as string) ?? undefined,
      bed: (d.bed as string) ?? undefined,
      dokter: (d.dokter as string) ?? undefined,
      diagnosis: (d.diagnosis as string) ?? undefined,
      operan: (d.operan as string) ?? undefined,
      terapi: (d.terapi as string) ?? undefined,
    });
    daysBy.set(String(d.patient_id), list);
  }
  for (const list of daysBy.values()) {
    list.sort((a, b) => String(b.date).localeCompare(String(a.date))); // newest first
  }

  const rcBy = new Map<string, Partial<Record<RowChecklistItem, string | null>>>();
  for (const r of rc) {
    const m = rcBy.get(String(r.patient_id)) ?? {};
    (m as Record<string, string | null>)[String(r.item_key)] = (r.checked_at as string) ?? null;
    rcBy.set(String(r.patient_id), m);
  }

  const logsBy = new Map<string, Record<string, LogEntry[]>>();
  for (const l of logs) {
    const m = logsBy.get(String(l.patient_id)) ?? {};
    (m[String(l.item_key)] ??= []).push({ date: String(l.date), ts: String(l.ts) });
    logsBy.set(String(l.patient_id), m);
  }

  const patients: PatientRow[] = rows.map((r) => {
    const id = String(r.id);
    const rl = logsBy.get(id) ?? {};
    return {
      id,
      mr: String(r.mr),
      facility: String(r.facility) as Facility,
      dateAdded: (r.date_added as string) ?? '',
      lastSeen: (r.last_seen as string) ?? null,
      tglRegistrasi: (r.tgl_registrasi as string) ?? '',
      nama: (r.nama as string) ?? '',
      umur: (r.umur as string) ?? '',
      kamar: (r.kamar as string) ?? '',
      bed: (r.bed as string) ?? '',
      dokter: (r.dokter as string) ?? '',
      diagnosis: (r.diagnosis as string) ?? '',
      operan: (r.operan as string) ?? '',
      terapi: (r.terapi as string) ?? '',
      checklist: {
        telaah_resep: null,
        catatan_pengobatan: null,
        pio: null,
        ...rcBy.get(id),
      },
      pharmacistNote: (r.pharmacist_note as string) ?? '',
      aso: parseAsoJson(r.aso_json),
      archived: Number(r.archived) === 1,
      archivedAt: (r.archived_at as string) ?? null,
      telaahLog: rl['telaah_resep'] ?? [],
      catatanLog: rl['catatan_pengobatan'] ?? [],
      pioLog: rl['pio'] ?? [],
      history: daysBy.get(id) ?? [],
    };
  });

  return {
    rows: patients,
    facilityLatestInput: Object.fromEntries(fli.map((f) => [String(f.facility), String(f.input_ts)])),
  };
}

function parseAsoJson(raw: unknown): import('./core/types.js').AsoMed[] {
  try {
    const v = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Full write-back of the world state (idempotent). At this app's scale
 * (hundreds of rows) a full upsert is simpler and safer than diffing.
 */
export function saveWorldState(db: DatabaseSync, state: WorldState): void {
  db.exec('BEGIN');
  try {
    const insP = db.prepare(`
      INSERT INTO patients (id, mr, facility, date_added, tgl_registrasi, nama, umur, kamar, bed,
                            dokter, diagnosis, operan, terapi, pharmacist_note, aso_json, archived, archived_at, last_seen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        date_added = excluded.date_added,
        tgl_registrasi = excluded.tgl_registrasi,
        nama = excluded.nama,
        umur = excluded.umur,
        kamar = excluded.kamar,
        bed = excluded.bed,
        dokter = excluded.dokter,
        diagnosis = excluded.diagnosis,
        operan = excluded.operan,
        terapi = excluded.terapi,
        pharmacist_note = excluded.pharmacist_note,
        archived = excluded.archived,
        archived_at = excluded.archived_at,
        last_seen = excluded.last_seen`);
    for (const r of state.rows) {
      insP.run(
        r.id, r.mr, r.facility, r.dateAdded || null, r.tglRegistrasi || null,
        r.nama || null, r.umur || null, r.kamar || null, r.bed || null,
        r.dokter || null, r.diagnosis || null, r.operan || null, r.terapi || null,
        r.pharmacistNote || null, JSON.stringify(r.aso ?? []), r.archived ? 1 : 0, r.archivedAt, r.lastSeen,
      );
    }

    db.prepare('DELETE FROM patient_days').run();
    const insD = db.prepare(`
      INSERT INTO patient_days (patient_id, report_date, tgl_registrasi, nama, umur, kamar, bed,
                                dokter, diagnosis, operan, terapi)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of state.rows) {
      for (const h of r.history) {
        insD.run(r.id, h.date, h.tglRegistrasi ?? null, h.nama ?? null, h.umur ?? null,
          h.kamar ?? null, h.bed ?? null, h.dokter ?? null, h.diagnosis ?? null,
          h.operan ?? null, h.terapi ?? null);
      }
    }

    db.prepare('DELETE FROM row_checklist').run();
    const insRC = db.prepare('INSERT INTO row_checklist (patient_id, item_key, checked_at) VALUES (?,?,?)');
    for (const r of state.rows) {
      for (const k of ['telaah_resep', 'catatan_pengobatan', 'pio'] as const) {
        insRC.run(r.id, k, r.checklist[k] ?? null);
      }
    }

    db.prepare('DELETE FROM daily_logs').run();
    const insL = db.prepare('INSERT INTO daily_logs (patient_id, item_key, date, ts) VALUES (?,?,?,?)');
    for (const r of state.rows) {
      for (const [key, list] of [
        ['telaah_resep', r.telaahLog],
        ['catatan_pengobatan', r.catatanLog],
        ['pio', r.pioLog],
      ] as const) {
        for (const e of list) insL.run(r.id, key, e.date, e.ts);
      }
    }

    db.prepare('DELETE FROM facility_latest_input').run();
    const insF = db.prepare('INSERT INTO facility_latest_input (facility, input_ts) VALUES (?,?)');
    for (const [f, ts] of Object.entries(state.facilityLatestInput)) insF.run(f, ts);

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
