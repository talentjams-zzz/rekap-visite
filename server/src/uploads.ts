// POST /api/uploads — multipart .xlsx upload → parse (core) → merge → persist.
import XLSX from 'xlsx';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { applyFiles } from './core/apply.js';
import { dateFromFilename, detectFacility, inputTimestamp } from './core/filename.js';
import type { ParsedFile, Sheet } from './core/types.js';
import { loadWorldState, saveWorldState } from './state.js';

export function registerUploads(
  app: FastifyInstance,
  db: DatabaseSync,
  onChange: () => void,
): void {
  app.post('/api/uploads', async (req, reply) => {
    const files: { filename: string; buffer: Buffer }[] = [];
    for await (const part of req.files()) {
      const buf = await part.toBuffer();
      files.push({ filename: part.filename, buffer: buf });
    }
    if (!files.length) {
      reply.code(400);
      return { ok: false, error: 'no files uploaded' };
    }

    // Server-side analog of v1's file mtime: the upload time distinguishes
    // several uploads on the same day (the newest upload wins).
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const nowTs = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
    const today = nowTs.slice(0, 10);

    const parsed: ParsedFile[] = [];
    const skipped: string[] = [];
    for (const f of files) {
      const facility = detectFacility(f.filename);
      if (!facility) {
        skipped.push(`${f.filename} (unknown facility)`);
        continue;
      }
      try {
        const wb = XLSX.read(f.buffer, { type: 'buffer' });
        const sheets = wb.SheetNames.map((n) => ({
          name: n,
          // SAFETY: xlsx's loose typing returns unknown[]; with { header: 1 }
          // each element is one row of cells (unknown[]), i.e. a Sheet.
          rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 }) as Sheet,
        }));
        const reportDate = dateFromFilename(f.filename, today);
        parsed.push({
          filename: f.filename,
          facility,
          reportDate,
          inputTs: inputTimestamp(reportDate, now.getTime()),
          kind: f.filename.toLowerCase().includes('operan') ? 'handover' : 'registry',
          sheets,
        });
      } catch (e) {
        skipped.push(`${f.filename} (${(e as Error).message})`);
      }
    }

    if (!parsed.length) {
      reply.code(400);
      return { ok: false, error: 'no usable files', skipped };
    }

    const state = loadWorldState(db);
    const result = applyFiles(state, parsed, nowTs);
    saveWorldState(db, state);

    const insU = db.prepare(
      'INSERT INTO uploads (filename, facility, report_date, sha256, uploaded_at) VALUES (?,?,?,?,?)',
    );
    for (const pf of parsed) {
      const orig = files.find((f) => f.filename === pf.filename);
      if (orig) {
        insU.run(pf.filename, pf.facility, pf.reportDate,
          createHash('sha256').update(orig.buffer).digest('hex'), nowTs);
      }
    }

    onChange();
    return {
      ok: true,
      files: parsed.length,
      added: result.added,
      merged: result.merged,
      skipped,
      warnings: result.warnings,
      sync: result.sync,
    };
  });
}
