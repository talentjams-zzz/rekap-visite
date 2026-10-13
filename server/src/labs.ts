// POST /api/uploads/lab — multipart lab .xlsx uploads (lab-{MR}.xlsx).
// Port of v1 handleLabLoad: the LATEST report per MR completely replaces the
// previous one (v1 labResults[mr] semantics).
import XLSX from 'xlsx';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { parseLabFile } from './core/parsers.js';
import type { LabTest } from './core/parsers.js';
import type { Sheet } from './core/types.js';

export interface LabSummary {
  loadedAt: string | null;
  maxDate: string;
  testCount: number;
  abnormal: number;
  kritis: number;
}

export function labSummaryFrom(tests: LabTest[], loadedAt: string | null, maxDate: string): LabSummary {
  return {
    loadedAt,
    maxDate,
    testCount: tests.length,
    abnormal: tests.filter((t) => t.abnormal).length,
    kritis: tests.filter((t) => t.kritis).length,
  };
}

function nowTs(): string {
  const n = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
}

export function registerLabs(
  app: FastifyInstance,
  db: DatabaseSync,
  onChange: () => void,
): void {
  /** Full lab report for one MR (fetched when the UI panel expands). */
  app.get('/api/patients/:mr/lab', async (req, reply) => {
    const { mr } = req.params as { mr: string };
    const row = db
      .prepare('SELECT loaded_at, max_date, tests_json FROM labs WHERE mr = ?')
      .get(mr) as { loaded_at: string | null; max_date: string; tests_json: string } | undefined;
    if (!row) {
      reply.code(404);
      return { error: 'no lab for this MR' };
    }
    let tests: LabTest[];
    try {
      tests = JSON.parse(row.tests_json) as LabTest[];
    } catch {
      reply.code(500);
      return { error: 'corrupt lab data' };
    }
    return { loadedAt: row.loaded_at, maxDate: String(row.max_date ?? ''), tests };
  });

  app.post('/api/uploads/lab', async (req, reply) => {
    const files: { filename: string; buffer: Buffer }[] = [];
    for await (const part of req.files()) {
      const buf = await part.toBuffer();
      files.push({ filename: part.filename, buffer: buf });
    }
    if (!files.length) {
      reply.code(400);
      return { ok: false, error: 'no files uploaded' };
    }

    // v1: filename must start with "lab" followed by the MR digits.
    const re = /^lab[-_ ]?(\d+)/i;
    let loaded = 0;
    const skipped: string[] = [];
    const ins = db.prepare(
      `INSERT INTO labs (mr, filename, loaded_at, max_date, tests_json)
       VALUES (?,?,?,?,?)
       ON CONFLICT(mr) DO UPDATE SET
         filename = excluded.filename,
         loaded_at = excluded.loaded_at,
         max_date = excluded.max_date,
         tests_json = excluded.tests_json`,
    );
    for (const f of files) {
      const m = f.filename.toLowerCase().match(re);
      if (!m) {
        skipped.push(`${f.filename} (no MR in name)`);
        continue;
      }
      try {
        const wb = XLSX.read(f.buffer, { type: 'buffer' });
        const sheets = wb.SheetNames.map((n) => ({
          name: n,
          rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 }) as Sheet,
        }));
        const report = parseLabFile(sheets);
        if (!report) {
          skipped.push(`${f.filename} (no tests parsed)`);
          continue;
        }
        const loadedAt = nowTs();
        ins.run(m[1], f.filename, loadedAt, report.maxDate, JSON.stringify(report.tests));
        loaded++;
      } catch (e) {
        skipped.push(`${f.filename} (${e instanceof Error ? e.message : 'parse error'})`);
      }
    }
    if (loaded > 0) onChange();
    return { ok: true, loaded, skipped };
  });
}
