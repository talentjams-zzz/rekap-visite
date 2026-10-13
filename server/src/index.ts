import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const PORT = Number(process.env.PORT || 8787);
const dbFile = process.env.REKAP_DB || path.join(root, 'data', 'rekap.db');
const webDist = path.join(root, 'web', 'dist');
const APP_VERSION = '2.0.0';

const db = openDb(dbFile);
const app = Fastify({ logger: true });

app.get('/api/health', async () => {
  const c = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    ok: true,
    version: APP_VERSION,
    db: {
      patients: c('SELECT COUNT(*) c FROM patients'),
      patientDays: c('SELECT COUNT(*) c FROM patient_days'),
      labs: c('SELECT COUNT(*) c FROM labs'),
    },
    dbFile,
  };
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
  app.log.warn(`web/dist not found — API only (run: pnpm --filter web build)`);
}

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
