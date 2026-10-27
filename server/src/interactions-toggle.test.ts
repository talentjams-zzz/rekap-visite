// Review fix: rapid-click checklist conflicts. The check endpoints now
// support SERVER-SIDE toggle — the server flips its own current value, so
// fast double-clicks compose correctly even from a stale client render, and
// a second write with a newer rev (from the serialized client chain) does
// not 409 the user.
import Fastify from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerInteractions } from './interactions.js';

const here = path.dirname(new URL(import.meta.url).pathname);

let dir: string;
let db: DatabaseSync;
let app: FastifyInstance;
type FastifyInstance = ReturnType<typeof Fastify>;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'rekap-int-'));
  db = new DatabaseSync(path.join(dir, 't.db'));
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(readFileSync(path.join(here, '..', 'schema.sql'), 'utf8'));
  db.prepare(
    `INSERT INTO patients (id, mr, facility, date_added, nama) VALUES ('100_nusin','100','nusin','2026-10-01','T')`,
  ).run();
  app = Fastify();
  registerInteractions(app, db, () => undefined);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('server-side checklist toggle', () => {
  it('toggles the current DB value, not a client value', async () => {
    let r = await app.inject({ method: 'POST', url: '/api/rows/100_nusin/check', payload: { key: 'telaah_resep', toggle: true } });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { rev: number }).rev).toBe(1);
    let cur = db.prepare("SELECT checked_at FROM row_checklist WHERE patient_id='100_nusin' AND item_key='telaah_resep'").get() as { checked_at: string | null };
    expect(cur.checked_at).toBeTruthy();

    // Second toggle (newer rev, as the serialized client chain sends) UNDOES it.
    r = await app.inject({ method: 'POST', url: '/api/rows/100_nusin/check', payload: { key: 'telaah_resep', toggle: true, rev: 1 } });
    expect(r.statusCode).toBe(200);
    cur = db.prepare("SELECT checked_at FROM row_checklist WHERE patient_id='100_nusin' AND item_key='telaah_resep'").get() as { checked_at: string | null };
    expect(cur.checked_at).toBeNull();
  });

  it('a stale rev still 409s (genuine cross-device conflict is preserved)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/rows/100_nusin/check', payload: { key: 'pio', toggle: true, rev: 0 } });
    expect(r.statusCode).toBe(409);
  });

  it('explicit value writes still work (backward compatible)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/rows/100_nusin/check', payload: { key: 'pio', value: '2026-10-01 09:00:00' } });
    expect(r.statusCode).toBe(200);
    const cur = db.prepare("SELECT checked_at FROM row_checklist WHERE patient_id='100_nusin' AND item_key='pio'").get() as { checked_at: string | null };
    expect(cur.checked_at).toBe('2026-10-01 09:00:00');
  });

  it('patient items toggle too (no rev on that path)', async () => {
    let r = await app.inject({ method: 'POST', url: '/api/patients/100/check', payload: { key: 'visite', toggle: true } });
    expect(r.statusCode).toBe(200);
    let cur = db.prepare("SELECT checked_at FROM patient_checklist WHERE mr='100' AND item_key='visite'").get() as { checked_at: string | null };
    expect(cur.checked_at).toBeTruthy();
    r = await app.inject({ method: 'POST', url: '/api/patients/100/check', payload: { key: 'visite', toggle: true } });
    expect(r.statusCode).toBe(200);
    cur = db.prepare("SELECT checked_at FROM patient_checklist WHERE mr='100' AND item_key='visite'").get() as { checked_at: string | null };
    expect(cur.checked_at).toBeNull();
  });
});
