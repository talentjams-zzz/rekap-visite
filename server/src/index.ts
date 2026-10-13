import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { registerEvents } from './events.js';
import {
  isSourceNewer,
  migrationState,
  runMigration,
  type V1Master,
} from './migrate.js';
import { registerInteractions } from './interactions.js';
import { labSummaryFrom, registerLabs } from './labs.js';
import type { LabSummary } from './labs.js';
import { registerUploads } from './uploads.js';
import type { AsoMed } from './core/types.js';
import type { LabTest } from './core/parsers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const PORT = Number(process.env.PORT || 8787);
const dbFile = process.env.REKAP_DB || path.join(root, 'data', 'rekap.db');
const masterFile = process.env.REKAP_MASTER || path.join(root, 'master_data.json');
const webDist = path.join(root, 'web', 'dist');
const APP_VERSION = '2.0.0';

const db = openDb(dbFile);
const app = Fastify({ logger: true });
const schemaSql = readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');

const events = registerEvents(app);
await app.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024, files: 20 } });
registerUploads(app, db, () => events.broadcast('change', { at: new Date().toISOString() }));
registerLabs(app, db, () => events.broadcast('change', { at: new Date().toISOString() }));
registerInteractions(app, db, () => events.broadcast('change', { at: new Date().toISOString() }));

function loadMaster(): V1Master | null {
  if (!existsSync(masterFile)) return null;
  try {
    return JSON.parse(readFileSync(masterFile, 'utf8')) as V1Master;
  } catch (e) {
    app.log.error({ err: e, masterFile }, 'failed to parse master_data.json');
    return null;
  }
}

/** Re-migrate from v1 when the master file is newer than the last migration. */
function autoMigrate(reason: string): boolean {
  const src = loadMaster();
  if (!src) return false;
  if (!isSourceNewer(db, src)) return false;
  const report = runMigration(db, src, schemaSql);
  if (report.ok) {
    app.log.info({ reason, version: src.version }, 'auto-migrated from v1 master_data.json');
    events.broadcast('change', { at: new Date().toISOString(), reason });
  } else {
    app.log.error({ reason, version: src.version, checks: report.checks },
      'auto-migration verification FAILED');
  }
  return report.ok;
}

// Auto-migration: on startup, then watch the v1 master file while it's still
// the live source (old app running in parallel). After cutover v1 stops
// saving, so this becomes a no-op.
autoMigrate('startup');
const pollMs = Number(process.env.REKAP_POLL_MS || 60_000);
if (pollMs > 0) {
  const timer = setInterval(() => autoMigrate('poll'), pollMs);
  timer.unref();
}

app.get('/api/health', async () => {
  const c = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  const state = migrationState(db);
  const src = loadMaster();
  return {
    ok: true,
    version: APP_VERSION,
    db: {
      patients: c('SELECT COUNT(*) c FROM patients'),
      patientDays: c('SELECT COUNT(*) c FROM patient_days'),
      labs: c('SELECT COUNT(*) c FROM labs'),
    },
    migration: {
      lastMigratedAt: state?.lastMigratedAt ?? null,
      sourceVersion: state?.sourceVersion ?? null,
      masterFile,
      masterExists: existsSync(masterFile),
      upToDate: src ? !isSourceNewer(db, src) : null,
    },
    dbFile,
  };
});

interface RowDto {
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
  aso: AsoMed[];
  lab: LabSummary | null;
  archived: boolean;
  archivedAt: string | null;
  lastSeen: string | null;
  dayCount: number;
  checklist: Record<string, string | null>;
}

function parseAso(raw: unknown): AsoMed[] {
  try {
    const v = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(v) ? (v as AsoMed[]) : [];
  } catch {
    return [];
  }
}

/** tests_json is always written by this server (JSON.stringify), but parse defensively anyway. */
function parseLabTests(raw: unknown): LabTest[] | null {
  try {
    const v = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(v) ? (v as LabTest[]) : null;
  } catch {
    return null;
  }
}

/** Patient rows for the UI. ?status=active|archived (default active), ?facility=nusin|... */
// SAFETY: all WHERE fragments are fixed literals from this allowlist (no
// user-derived text is ever concatenated into SQL); query values only reach
// the statement through `?` parameters.
const ROWS_SELECT = `SELECT p.id, p.mr, p.facility, p.date_added, p.tgl_registrasi, p.nama, p.umur,
       p.kamar, p.bed, p.dokter, p.diagnosis, p.operan, p.terapi,
       p.pharmacist_note, p.aso_json, p.archived, p.archived_at, p.last_seen,
       l.loaded_at AS lab_loaded_at, l.max_date AS lab_max_date, l.tests_json AS lab_tests_json,
       (SELECT COUNT(*) FROM patient_days d WHERE d.patient_id = p.id) AS day_count
  FROM patients p LEFT JOIN labs l ON l.mr = p.mr WHERE `;
const W_FACILITY = 'p.facility = ? AND ';
const W_ACTIVE = 'p.archived = 0';
const W_ARCHIVED = 'p.archived = 1';
const ROWS_ORDER = ' ORDER BY p.tgl_registrasi DESC';

app.get('/api/rows', async (req) => {
  const q = req.query as { facility?: string; status?: string };
  const facility = typeof q.facility === 'string' && q.facility.length > 0 ? q.facility : null;
  const archived = q.status === 'archived';
  const params: (string | number)[] = facility ? [facility] : [];
  const sql =
    ROWS_SELECT +
    (facility ? W_FACILITY : '') +
    (archived ? W_ARCHIVED : W_ACTIVE) +
    ROWS_ORDER;
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  // Checklist state (row items + per-patient items) — small enough to load fully.
  const rc = db.prepare('SELECT patient_id, item_key, checked_at FROM row_checklist').all() as
    { patient_id: string; item_key: string; checked_at: string | null }[];
  const pc = db.prepare('SELECT mr, item_key, checked_at FROM patient_checklist').all() as
    { mr: string; item_key: string; checked_at: string | null }[];
  const rcBy = new Map<string, Record<string, string | null>>();
  for (const r of rc) {
    const m = rcBy.get(r.patient_id) ?? {};
    m[r.item_key] = r.checked_at;
    rcBy.set(r.patient_id, m);
  }
  const pcBy = new Map<string, Record<string, string | null>>();
  for (const r of pc) {
    const m = pcBy.get(r.mr) ?? {};
    m[r.item_key] = r.checked_at;
    pcBy.set(r.mr, m);
  }

  const out: RowDto[] = rows.map((r) => {
    const mr = String(r.mr);
    const checklist: Record<string, string | null> = {
      ...rcBy.get(String(r.id)),
      ...pcBy.get(mr),
    };
    return {
      id: String(r.id),
      mr,
      facility: String(r.facility),
      dateAdded: (r.date_added as string | null) ?? null,
      tglRegistrasi: (r.tgl_registrasi as string | null) ?? null,
      nama: (r.nama as string | null) ?? null,
      umur: (r.umur as string | null) ?? null,
      kamar: (r.kamar as string | null) ?? null,
      bed: (r.bed as string | null) ?? null,
      dokter: (r.dokter as string | null) ?? null,
      diagnosis: (r.diagnosis as string | null) ?? null,
      operan: (r.operan as string | null) ?? null,
      terapi: (r.terapi as string | null) ?? null,
      pharmacistNote: (r.pharmacist_note as string | null) ?? null,
      aso: parseAso(r.aso_json),
      lab: (() => {
        if (!r.lab_tests_json) return null;
        const tests = parseLabTests(r.lab_tests_json);
        return tests
          ? labSummaryFrom(tests, (r.lab_loaded_at as string | null) ?? null, String(r.lab_max_date ?? ''))
          : null;
      })(),
      archived: Number(r.archived) === 1,
      archivedAt: (r.archived_at as string | null) ?? null,
      lastSeen: (r.last_seen as string | null) ?? null,
      dayCount: Number(r.day_count),
      checklist,
    };
  });
  return out;
});

// ── Rekap (v1 buildRekapData) ──────────────────────────────────────────────
// Row items: current check + archived log timestamps (a daily reset never
// erases completed work from the rekap). Patient items: per-MR checks.
// Grouped by date; MRs deduped per date+item.
app.get('/api/rekap', async () => {
  const patients = db.prepare('SELECT id, mr, nama, facility, archived FROM patients').all() as {
    id: string;
    mr: string;
    nama: string | null;
    facility: string;
    archived: number;
  }[];
  const rowChecks = db.prepare('SELECT patient_id, item_key, checked_at FROM row_checklist').all() as {
    patient_id: string;
    item_key: string;
    checked_at: string | null;
  }[];
  const logs = db.prepare('SELECT patient_id, item_key, ts FROM daily_logs').all() as {
    patient_id: string;
    item_key: string;
    ts: string;
  }[];
  const patChecks = db.prepare('SELECT mr, item_key, checked_at FROM patient_checklist').all() as {
    mr: string;
    item_key: string;
    checked_at: string | null;
  }[];

  const byId = new Map(patients.map((p) => [p.id, p]));
  const byDate: Record<string, Record<string, { mrs: string[]; names: Record<string, string> }>> = {};
  const addStamp = (mr: string, name: string, key: string, ts: string) => {
    const date = ts.split(' ')[0];
    const day = (byDate[date] ??= {});
    const entry = (day[key] ??= { mrs: [], names: {} });
    if (!entry.mrs.includes(mr)) {
      entry.mrs.push(mr);
      entry.names[mr] = name;
    }
  };

  for (const c of rowChecks) {
    if (!c.checked_at) continue;
    const p = byId.get(c.patient_id);
    if (p) addStamp(p.mr, String(p.nama ?? ''), c.item_key, c.checked_at);
  }
  for (const l of logs) {
    const p = byId.get(l.patient_id);
    if (p) addStamp(p.mr, String(p.nama ?? ''), l.item_key, l.ts);
  }
  for (const c of patChecks) {
    if (!c.checked_at) continue;
    const p = patients.find((x) => x.mr === c.mr);
    addStamp(c.mr, p ? String(p.nama ?? '') : c.mr, c.item_key, c.checked_at);
  }

  const ROW_KEYS = ['telaah_resep', 'catatan_pengobatan', 'pio'];
  const ALL_KEYS = [
    ...ROW_KEYS,
    'visite',
    'pto',
    'konseling',
    'rekonsiliasi_obat',
    'penelusuran_obat',
  ];
  const totals: Record<string, number> = {};
  const uniqueMRS = new Set<string>();
  for (const day of Object.values(byDate)) {
    for (const [key, entry] of Object.entries(day)) {
      totals[key] = (totals[key] ?? 0) + entry.mrs.length;
      if (ROW_KEYS.includes(key)) entry.mrs.forEach((m) => uniqueMRS.add(m));
    }
  }

  return {
    totalPatients: uniqueMRS.size,
    totals,
    allKeys: ALL_KEYS,
    byDate,
    rowsByMR: Object.fromEntries(
      patients.map((p) => [
        p.mr,
        { facility: p.facility, archived: Number(p.archived) === 1 },
      ]),
    ),
  };
});

/** Force re-migration from the current v1 master file (ops endpoint). */
app.post('/api/migrate', async () => {
  const src = loadMaster();
  if (!src) return { ok: false, error: `master file not found: ${masterFile}` };
  const report = runMigration(db, src, schemaSql);
  return { ok: report.ok, version: src.version, checks: report.checks };
});

if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.code(404);
      return reply.send({ error: 'not found' });
    }
    // SPA fallback
    return reply.type('text/html').send(readFileSync(path.join(webDist, 'index.html')));
  });
  app.log.info(`serving web dist from ${webDist}`);
} else {
  app.log.warn('web/dist not found — API only (run: pnpm --filter web build)');
}

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
