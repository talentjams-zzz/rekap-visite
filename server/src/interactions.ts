// Row interactions: checklist toggles, editable fields, archive, riwayat.
// Ports v1 toggleRowCheck / togglePatientCheck / commitEditCell / toggleArchive.
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';

// SAFETY: the only column name interpolated into the ASO update below.
const ASO_SQL = 'UPDATE patients SET aso_json = ? WHERE id = ?';
const ROW_ITEM_KEYS = ['telaah_resep', 'catatan_pengobatan', 'pio'];
const PATIENT_ITEM_KEYS = ['visite', 'pto', 'konseling', 'rekonsiliasi_obat', 'penelusuran_obat'];
// SAFETY: the only column names ever interpolated into UPDATE/INSERT below;
// all values go through `?` parameters.
// soap: daily free text — like the others it is recorded into the CURRENT
// day's snapshot so it shows in Riwayat once the day advances (and the live
// cell is cleared by touchRowDate).
const EDITABLE_FIELDS = ['diagnosis', 'operan', 'terapi', 'soap'] as const;
// Fixed SQL per editable field — no runtime string building (values via `?`).
const FIELD_SQL: Record<
  (typeof EDITABLE_FIELDS)[number],
  { upd: string; dayUpd: string; dayIns: string }
> = {
  diagnosis: {
    upd: 'UPDATE patients SET diagnosis = ? WHERE id = ?',
    dayUpd: 'UPDATE patient_days SET diagnosis = ? WHERE id = ?',
    dayIns: 'INSERT INTO patient_days (patient_id, report_date, diagnosis) VALUES (?,?,?)',
  },
  operan: {
    upd: 'UPDATE patients SET operan = ? WHERE id = ?',
    dayUpd: 'UPDATE patient_days SET operan = ? WHERE id = ?',
    dayIns: 'INSERT INTO patient_days (patient_id, report_date, operan) VALUES (?,?,?)',
  },
  terapi: {
    upd: 'UPDATE patients SET terapi = ? WHERE id = ?',
    dayUpd: 'UPDATE patient_days SET terapi = ? WHERE id = ?',
    dayIns: 'INSERT INTO patient_days (patient_id, report_date, terapi) VALUES (?,?,?)',
  },
  soap: {
    upd: 'UPDATE patients SET soap = ? WHERE id = ?',
    dayUpd: 'UPDATE patient_days SET soap = ? WHERE id = ?',
    dayIns: 'INSERT INTO patient_days (patient_id, report_date, soap) VALUES (?,?,?)',
  },
};

function nowTs(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Optimistic concurrency: the client echoes the row rev it loaded. A
// mismatch means another device changed the row first → 409 (client reloads).
const REV_SELECT = 'SELECT rev FROM patients WHERE id = ?';
const REV_BUMP = 'UPDATE patients SET rev = rev + 1 WHERE id = ?';
function checkRev(db: DatabaseSync, id: string, bodyRev: unknown): 'missing' | 'conflict' | 'ok' {
  const row = db.prepare(REV_SELECT).get(id) as { rev: number } | undefined;
  if (!row) return 'missing';
  if (typeof bodyRev === 'number' && bodyRev !== row.rev) return 'conflict';
  return 'ok';
}

export function registerInteractions(
  app: FastifyInstance,
  db: DatabaseSync,
  broadcast: () => void,
): void {
  // Row-level checklist (3 items).
  // Replace a row's ASO (meds-to-stop) list.
  app.patch('/api/rows/:id/aso', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { aso?: unknown; rev?: number };
    const rev = checkRev(db, id, body.rev);
    if (rev === 'missing') {
      reply.code(404);
      return { ok: false, error: 'row not found' };
    }
    if (rev === 'conflict') {
      reply.code(409);
      return { ok: false, error: 'conflict' };
    }
    if (!Array.isArray(body.aso)) {
      reply.code(400);
      return { ok: false, error: 'aso must be an array' };
    }
    const aso = body.aso.map((m, i) => {
      const x = (m ?? {}) as Record<string, unknown>;
      return {
        id: typeof x.id === 'string' ? x.id : `${Date.now()}_${i}`,
        name: typeof x.name === 'string' ? x.name : '',
        stopDate: typeof x.stopDate === 'string' ? x.stopDate : '',
        stopped: Boolean(x.stopped),
        stoppedAt: typeof x.stoppedAt === 'string' ? x.stoppedAt : null,
      };
    });
    const res = db.prepare(ASO_SQL).run(JSON.stringify(aso), id);
    if (res.changes === 0) {
      reply.code(404);
      return { ok: false, error: 'row not found' };
    }
    db.prepare(REV_BUMP).run(id);
    // Return the new rev so the client can refresh its local copy —
    // back-to-back writes from the same device then never 409.
    const newRev = Number((db.prepare(REV_SELECT).get(id) as { rev: number }).rev);
    return { ok: true, rev: newRev };
  });

  app.post('/api/rows/:id/check', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { key, value, rev, toggle } = req.body as {
      key?: string;
      value?: string | null;
      rev?: number;
      toggle?: boolean;
    };
    if (!key || !ROW_ITEM_KEYS.includes(key)) {
      reply.code(400);
      return { ok: false, error: 'invalid row checklist item' };
    }
    const r = checkRev(db, id, rev);
    if (r === 'missing') {
      reply.code(404);
      return { ok: false, error: 'row not found' };
    }
    if (r === 'conflict') {
      reply.code(409);
      return { ok: false, error: 'conflict' };
    }
    // Toggle semantics (review fix): when toggle is set, the SERVER flips
    // the current DB value instead of trusting a client-computed value.
    // Rapid double-clicks then compose correctly even when the client's
    // rendered state is one click stale — a stale value write could not.
    let finalValue = value ?? null;
    if (toggle) {
      const cur = (db.prepare(
        'SELECT checked_at FROM row_checklist WHERE patient_id = ? AND item_key = ?',
      ).get(id, key) as { checked_at: string | null } | undefined)?.checked_at ?? null;
      finalValue = cur ? null : nowTs();
    }
    db.prepare(
      'INSERT INTO row_checklist (patient_id, item_key, checked_at) VALUES (?,?,?) ' +
        'ON CONFLICT(patient_id, item_key) DO UPDATE SET checked_at = excluded.checked_at',
    ).run(id, key, finalValue);
    db.prepare(REV_BUMP).run(id);
    const newRev = Number((db.prepare(REV_SELECT).get(id) as { rev: number }).rev);
    broadcast();
    return { ok: true, rev: newRev };
  });

  // Patient-level checklist (5 lifetime items, keyed by MR).
  app.post('/api/patients/:mr/check', async (req, reply) => {
    const { mr } = req.params as { mr: string };
    const { key, value, toggle } = req.body as { key?: string; value?: string | null; toggle?: boolean };
    if (!key || !PATIENT_ITEM_KEYS.includes(key)) {
      reply.code(400);
      return { ok: false, error: 'invalid patient checklist item' };
    }
    // Toggle semantics (same as the row check above): server flips the
    // current value; fast double-clicks compose instead of clobbering.
    let finalValue = value ?? null;
    if (toggle) {
      const cur = (db.prepare(
        'SELECT checked_at FROM patient_checklist WHERE mr = ? AND item_key = ?',
      ).get(mr, key) as { checked_at: string | null } | undefined)?.checked_at ?? null;
      finalValue = cur ? null : nowTs();
    }
    db.prepare(
      'INSERT INTO patient_checklist (mr, item_key, checked_at) VALUES (?,?,?) ' +
        'ON CONFLICT(mr, item_key) DO UPDATE SET checked_at = excluded.checked_at',
    ).run(mr, key, finalValue);
    broadcast();
    return { ok: true };
  });

  // Editable fields + note + archive. diagnosis/operan/terapi are also
  // recorded into the CURRENT day's history snapshot (v1 commitEditCell:
  // hand-typed values must show in Riwayat once the day becomes a past day).
  app.patch('/api/rows/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      note?: string;
      archived?: boolean;
      diagnosis?: string;
      operan?: string;
      terapi?: string;
      soap?: string;
      rev?: number;
    };
    const row = db
      .prepare('SELECT id, date_added FROM patients WHERE id = ?')
      .get(id) as { id: string; date_added: string | null } | undefined;
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'row not found' };
    }
    const rev = checkRev(db, id, body.rev);
    if (rev === 'conflict') {
      reply.code(409);
      return { ok: false, error: 'conflict' };
    }

    if (typeof body.note === 'string') {
      db.prepare('UPDATE patients SET pharmacist_note = ? WHERE id = ?').run(body.note, id);
    }
    if (typeof body.archived === 'boolean') {
      db.prepare('UPDATE patients SET archived = ?, archived_at = ? WHERE id = ?').run(
        body.archived ? 1 : 0,
        body.archived ? nowTs() : null,
        id,
      );
    }
    for (const f of EDITABLE_FIELDS) {
      const v = body[f];
      if (typeof v !== 'string') continue;
      const sql = FIELD_SQL[f];
      db.prepare(sql.upd).run(v, id);
      if (row.date_added) {
        const h = db
          .prepare('SELECT id FROM patient_days WHERE patient_id = ? AND report_date = ?')
          .get(id, row.date_added) as { id: number } | undefined;
        if (h) {
          db.prepare(sql.dayUpd).run(v, h.id);
        } else {
          db.prepare(sql.dayIns).run(id, row.date_added, v);
        }
      }
    }
    db.prepare(REV_BUMP).run(id);
    const newRev = Number((db.prepare(REV_SELECT).get(id) as { rev: number }).rev);
    broadcast();
    return { ok: true, rev: newRev };
  });

  // Riwayat: PAST days only (the current day is shown in the main row).
  app.get('/api/rows/:id/history', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db
      .prepare('SELECT id, date_added FROM patients WHERE id = ?')
      .get(id) as { id: string; date_added: string | null } | undefined;
    if (!row) {
      reply.code(404);
      return { error: 'row not found' };
    }
    const days = db
      .prepare(
        `SELECT report_date, tgl_registrasi, nama, umur, kamar, bed, dokter, diagnosis, operan, terapi, soap,
                pharmacist_note, visite, pto, konseling, rekonsiliasi_obat, penelusuran_obat
         FROM patient_days
         WHERE patient_id = ? AND report_date != ?
         ORDER BY report_date DESC`,
      )
      .all(id, row.date_added ?? '') as Record<string, unknown>[];
    return days.map((d) => ({
      date: String(d.report_date),
      tglRegistrasi: (d.tgl_registrasi as string) ?? null,
      nama: (d.nama as string) ?? null,
      umur: (d.umur as string) ?? null,
      kamar: (d.kamar as string) ?? null,
      bed: (d.bed as string) ?? null,
      dokter: (d.dokter as string) ?? null,
      diagnosis: (d.diagnosis as string) ?? null,
      operan: (d.operan as string) ?? null,
      terapi: (d.terapi as string) ?? null,
      soap: (d.soap as string) ?? null,
      note: (d.pharmacist_note as string) ?? null,
      visite: (d.visite as string) ?? null,
      pto: (d.pto as string) ?? null,
      konseling: (d.konseling as string) ?? null,
      rekonsiliasi_obat: (d.rekonsiliasi_obat as string) ?? null,
      penelusuran_obat: (d.penelusuran_obat as string) ?? null,
    }));
  });
}
