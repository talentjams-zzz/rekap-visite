import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import {
  isSourceNewer,
  migrationState,
  runMigration,
  type V1Master,
} from './migrate.js';

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
