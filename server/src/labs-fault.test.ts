// Review F1/F2: lab upload transaction integrity.
//
// F1 — a DB failure mid-chunk must roll back the ENTIRE chunk: the
// "nothing was saved" response is true, no partial lab lands, no change
// notification fires. (Old code broke out of the loop and then hit COMMIT —
// committing the earlier writes while claiming nothing saved.)
//
// F2 — overlapping uploads must not corrupt each other. Old code held
// BEGIN open across the entire multipart stream (network awaits inside a
// transaction on the shared connection): a second request's BEGIN failed
// and its catch rolled back the FIRST request's open transaction. New
// design: no transaction is open while the stream is in flight; the commit
// is a short synchronous section. Deterministic repro: pause upload A mid-
// multipart (raw socket), run an overlapping upload B AND an ordinary edit
// while A is paused, then resume A — all three must land.
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import XLSX from 'xlsx';
import { registerLabs } from './labs.js';
import { registerInteractions } from './interactions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.join(here, '..', 'schema.sql');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A minimal valid lab workbook (recognized header + one row). */
function labXlsx(testName: string): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Nama Pemeriksaan', 'Hasil Pemeriksaan', 'Keterangan', 'Satuan', 'Tanggal Hasil'],
    [testName, '13', 'Normal', 'g/dL', '2026-10-01'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

interface TestServer {
  base: string;
  db: DatabaseSync;
  app: FastifyInstance;
  dir: string;
  changes: () => number;
  close: () => Promise<void>;
}
type FastifyInstance = ReturnType<typeof Fastify>;

async function makeServer(triggers: string[]): Promise<TestServer> {
  const dir = mkdtempSync(path.join(tmpdir(), 'rekap-labfault-'));
  const db = new DatabaseSync(path.join(dir, 't.db'));
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(readFileSync(SCHEMA, 'utf8'));
  for (const t of triggers) db.exec(t);
  const app = Fastify();
  await app.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024, files: 20 } });
  let n = 0;
  const onChange = () => {
    n++;
  };
  registerLabs(app, db, onChange);
  registerInteractions(app, db, onChange);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });
  return {
    base,
    db,
    app,
    dir,
    changes: () => n,
    close: async () => {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function uploadViaFetch(base: string, files: [name: string, buf: Buffer][]) {
  const fd = new FormData();
  for (const [name, buf] of files) fd.append('files', new Blob([buf]), name);
  return fetch(`${base}/api/uploads/lab`, { method: 'POST', body: fd });
}

describe('F1: a DB failure mid-chunk rolls back the whole chunk', () => {
  it('audit-insert rejected → 500, no lab persisted, no change event', async () => {
    const srv = await makeServer([
      'CREATE TRIGGER no_audit BEFORE INSERT ON lab_uploads BEGIN SELECT RAISE(ABORT, \'audit denied\'); END',
    ]);
    try {
      const r = await uploadViaFetch(srv.base, [['lab-123.xlsx', labXlsx('Hemoglobin')]]);
      expect(r.status).toBe(500);
      const body = (await r.json()) as { code: string };
      expect(body.code).toBe('DB_ERROR');
      const row = srv.db.prepare("SELECT COUNT(*) c FROM labs WHERE mr='123'").get() as { c: number };
      expect(row.c).toBe(0); // the false "nothing was saved" is now true
      const audit = srv.db.prepare('SELECT COUNT(*) c FROM lab_uploads').get() as { c: number };
      expect(audit.c).toBe(0);
      expect(srv.changes()).toBe(0); // no SSE broadcast, no write-back requested
    } finally {
      await srv.close();
    }
  });

  it('second file\'s write rejected → the FIRST file is also absent (atomic)', async () => {
    const srv = await makeServer([
      "CREATE TRIGGER no_222 BEFORE INSERT ON labs WHEN NEW.mr = '222' BEGIN SELECT RAISE(ABORT, 'denied'); END",
    ]);
    try {
      const r = await uploadViaFetch(srv.base, [
        ['lab-111.xlsx', labXlsx('Hemoglobin')],
        ['lab-222.xlsx', labXlsx('Leukosit')],
      ]);
      expect(r.status).toBe(500);
      const body = (await r.json()) as { code: string };
      expect(body.code).toBe('DB_ERROR');
      const total = srv.db.prepare('SELECT COUNT(*) c FROM labs').get() as { c: number };
      expect(total.c).toBe(0); // file 1 must NOT survive file 2's failure
      expect(srv.changes()).toBe(0);
    } finally {
      await srv.close();
    }
  });
});

describe('F2: overlapping uploads and edits do not corrupt each other', () => {
  // Paused multipart: write A's first part completely, then A's second
  // part HEADER only, and hold the body back. A's handler is parked in the
  // stream phase — exactly the window where the old code held BEGIN open.
  function startPausedUpload(base: string, b111: Buffer, b222: Buffer) {
    const { port } = new URL(base);
    const B = 'rekap-fault-boundary';
    const headA = `--${B}\r\nContent-Disposition: form-data; name="files"; filename="lab-111.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const head2 = `--${B}\r\nContent-Disposition: form-data; name="files"; filename="lab-222.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const tail = `\r\n--${B}--\r\n`;
    const chunk1 = Buffer.concat([Buffer.from(headA), b111, Buffer.from('\r\n' + head2)]);
    const chunk2 = Buffer.concat([b222, Buffer.from(tail)]);
    const socket = net.connect(Number(port), '127.0.0.1');
    let data = Buffer.alloc(0);
    let resolveDone: (v: { status: number; body: string }) => void;
    const done = new Promise<{ status: number; body: string }>((r) => (resolveDone = r));
    socket.on('data', (d) => {
      data = Buffer.concat([data, d]);
    });
    socket.on('close', () => {
      const s = data.toString('utf8');
      const sep = s.indexOf('\r\n\r\n');
      const status = Number(s.split('\r\n')[0].split(' ')[1]);
      resolveDone({ status, body: sep >= 0 ? s.slice(sep + 4) : s });
    });
    socket.on('connect', () => {
      const total = chunk1.length + chunk2.length;
      socket.write(
        `POST /api/uploads/lab HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `Content-Type: multipart/form-data; boundary=${B}\r\n` +
          `Content-Length: ${total}\r\nConnection: close\r\n\r\n`,
      );
      socket.write(chunk1);
    });
    return {
      resume: () => socket.write(chunk2),
      close: () => socket.destroy(),
      done,
    };
  }

  it('paused upload A + overlapping upload B + overlapping edit → all three land', async () => {
    const srv = await makeServer([]);
    const a = startPausedUpload(srv.base, labXlsx('Hemoglobin'), labXlsx('Leukosit'));
    let failed = false;
    try {
      // An ordinary patient for the overlapping edit.
      srv.db
        .prepare("INSERT INTO patients (id, mr, facility, date_added, nama) VALUES ('999_nusin','999','nusin','2026-10-01','P')")
        .run();

      // Let A park in the stream phase (first part consumed, second pending).
      await sleep(250);

      // B: a fully-formed overlapping upload — must succeed while A is paused.
      const rb = await uploadViaFetch(srv.base, [['lab-333.xlsx', labXlsx('Trombosit')]]);
      expect(rb.status).toBe(200);
      expect(((await rb.json()) as { loaded: number }).loaded).toBe(1);

      // An overlapping ordinary edit — must succeed while A is paused.
      const re = await fetch(`${srv.base}/api/rows/999_nusin/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'telaah_resep', toggle: true }),
      });
      expect(re.status).toBe(200);

      // Resume A: the second workbook body + closing boundary.
      a.resume();
      const resA = await a.done;
      expect(resA.status).toBe(200);
      const bodyA = JSON.parse(resA.body) as { loaded: number };
      expect(bodyA.loaded).toBe(2);

      // ALL three lab MRs persisted (pre-fix: MR 111 vanished under B's
      // rollback of A's still-open transaction).
      for (const mr of ['111', '222', '333']) {
        const row = srv.db.prepare('SELECT COUNT(*) c FROM labs WHERE mr = ?').get(mr) as { c: number };
        expect(row.c, `lab MR ${mr} missing`).toBe(1);
      }
      // The edit landed.
      const ck = srv.db.prepare("SELECT checked_at FROM row_checklist WHERE patient_id='999_nusin' AND item_key='telaah_resep'").get() as
        | { checked_at: string | null }
        | undefined;
      expect(ck?.checked_at).toBeTruthy();
      // Every change announced exactly once (3 mutations, 3 broadcasts).
      expect(srv.changes()).toBe(3);
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      if (failed) a.close();
      await srv.close();
    }
  }, 20000);
});
