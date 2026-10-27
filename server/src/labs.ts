// POST /api/uploads/lab — multipart lab .xlsx uploads (lab-{MR}.xlsx).
// Port of v1 handleLabLoad: the LATEST report per MR completely replaces the
// previous one (v1 labResults[mr] semantics).
//
// v2.1 (per the lab-data loading guide):
//  - ONE file buffered at a time (streamed from the multipart body and
//    processed immediately) instead of collecting every buffer first — the
//    old code held up to 20 × 50 MiB raw + every XLSX workbook at once.
//  - worksheets are converted lazily (one at a time, first match wins) with
//    row/sheet limits, so compressed workbooks can't expand unbounded.
//  - one transaction per request (atomic chunk): a DB failure rolls the
//    whole chunk back and returns a structured error.
//  - exact (filename, sha256) dedupe via lab_uploads: a re-upload of the
//    same file is a no-op — no re-parse, no rewrite, no write-back, no SSE.
//  - structured error codes (FILE_COUNT_LIMIT / FILE_TOO_LARGE / …) instead
//    of opaque HTTP failures, plus request logging (count/bytes/duration).
import XLSX from 'xlsx';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { locateLabSheet, parseLabFile, type LabTest } from './core/parsers.js';
import type { Sheet } from './core/types.js';
import { structuredUploadError } from './uploadErrors.js';

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

// Limits: a pathological compressed workbook must not be able to expand
// without bound in memory (v1-style hospital exports stay far below this).
const MAX_SHEETS = 50;
const MAX_ROWS_PER_SHEET = 20000;

interface LabFileResult {
  loaded: number;
  duplicates: string[];
  skipped: string[];
  failed: { filename: string; code: string; message: string }[];
}

/** Parse + insert ONE lab file. Throws only on unexpected DB errors. */
function processOneLabFile(
  db: DatabaseSync,
  filename: string,
  buffer: Buffer,
  results: LabFileResult,
): void {
  const m = filename.toLowerCase().match(/^lab[-_ ]?(\d+)/i);
  if (!m) {
    results.skipped.push(`${filename} (no MR in name)`);
    return;
  }
  const mr = m[1];

  // Dedupe BEFORE parsing: the exact same file was already accepted.
  const sha = createHash('sha256').update(buffer).digest('hex');
  const known = db
    .prepare('SELECT 1 AS x FROM lab_uploads WHERE filename = ? AND sha256 = ?')
    .get(filename, sha);
  if (known) {
    results.duplicates.push(filename);
    return;
  }

  // Lazy worksheet conversion: inspect one sheet at a time, stop at the
  // first "Nama Pemeriksaan" header. Unrelated cover sheets are never
  // fully converted.
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    results.failed.push({
      filename,
      code: 'INVALID_XLSX',
      message: `${filename} is not a readable Excel file`,
    });
    return;
  }
  // sheetjs is lenient: some garbage parses into a workbook with zero
  // sheets. That is "not an Excel file", not "no lab sheet".
  if (wb.SheetNames.length === 0) {
    results.failed.push({
      filename,
      code: 'INVALID_XLSX',
      message: `${filename} is not a readable Excel file (no worksheets)`,
    });
    return;
  }
  if (wb.SheetNames.length > MAX_SHEETS) {
    results.failed.push({
      filename,
      code: 'WORKBOOK_TOO_LARGE',
      message: `${filename} has ${wb.SheetNames.length} worksheets (max ${MAX_SHEETS})`,
    });
    return;
  }

  let sheetRows: Sheet | null = null;
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 }) as Sheet;
    if (rows.length > MAX_ROWS_PER_SHEET) {
      results.failed.push({
        filename,
        code: 'SHEET_TOO_LARGE',
        message: `${filename}: sheet "${name}" has ${rows.length} rows (max ${MAX_ROWS_PER_SHEET})`,
      });
      return;
    }
    if (locateLabSheet(rows) >= 0) {
      sheetRows = rows;
      break;
    }
  }

  const report = sheetRows ? parseLabFile([{ name: 'x', rows: sheetRows }]) : null;
  if (!report) {
    const why = sheetRows
      ? 'matching sheet missing required columns (or no tests)'
      : 'no lab sheet found';
    results.skipped.push(`${filename} (${why})`);
    return;
  }

  const tests = report.tests;
  const loadedAt = nowTs();
  // parseLabFile already flags abnormal/kritis with the v1 rules.
  const abnormal = tests.filter((t) => t.abnormal).length;
  const kritis = tests.filter((t) => t.kritis).length;
  db.prepare(
    `INSERT INTO labs (mr, filename, loaded_at, max_date, tests_json,
                       test_count, abnormal_count, kritis_count)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(mr) DO UPDATE SET
       filename = excluded.filename,
       loaded_at = excluded.loaded_at,
       max_date = excluded.max_date,
       tests_json = excluded.tests_json,
       test_count = excluded.test_count,
       abnormal_count = excluded.abnormal_count,
       kritis_count = excluded.kritis_count`,
  ).run(mr, filename, loadedAt, report.maxDate, JSON.stringify(tests), tests.length, abnormal, kritis);
  db.prepare('INSERT INTO lab_uploads (mr, filename, sha256, loaded_at) VALUES (?,?,?,?)')
    .run(mr, filename, sha, loadedAt);
  results.loaded++;
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
    const t0 = Date.now();
    const results: LabFileResult = { loaded: 0, duplicates: [], skipped: [], failed: [] };
    let fileCount = 0;
    let totalBytes = 0;
    let maxBytes = 0;
    let dbFailed = false;

    try {
      db.exec('BEGIN');
      for await (const part of req.files()) {
        let buf: Buffer;
        try {
          buf = await part.toBuffer();
        } catch (e) {
          // Multipart limit violation (file count / size) — structured.
          const s = structuredUploadError(e);
          db.exec('ROLLBACK');
          if (s) {
            app.log.warn(
              { reqId: req.id, err: (e as Error).message, filesSoFar: fileCount, bytesSoFar: totalBytes },
              'lab upload: multipart limit hit',
            );
            return reply.code(s.status).send(s.body);
          }
          dbFailed = true;
          break;
        }
        fileCount++;
        totalBytes += buf.length;
        maxBytes = Math.max(maxBytes, buf.length);
        try {
          processOneLabFile(db, part.filename, buf, results);
        } catch (e) {
          // Unexpected DB error mid-chunk: roll back the whole chunk so a
          // partial lab batch never half-lands (atomic chunk semantics).
          dbFailed = true;
          app.log.error({ err: e, reqId: req.id, file: part.filename }, 'lab upload: DB error — chunk rolled back');
          break;
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* not in a transaction */
      }
      dbFailed = true;
      const s = structuredUploadError(e);
      if (s) {
        return reply.code(s.status).send(s.body);
      }
      app.log.error({ err: e, reqId: req.id }, 'lab upload failed');
      return reply.code(500).send({ ok: false, code: 'DB_ERROR', message: 'Lab upload failed in the database — nothing was saved. Try again.' });
    }

    if (!fileCount && !dbFailed) {
      return reply.code(400).send({ ok: false, code: 'NO_FILES', message: 'No files uploaded.' });
    }
    if (dbFailed) {
      return reply.code(500).send({ ok: false, code: 'DB_ERROR', message: 'Lab upload failed in the database — nothing was saved. Try again.' });
    }

    app.log.info(
      {
        reqId: req.id,
        files: fileCount,
        bytes: totalBytes,
        maxFileBytes: maxBytes,
        ms: Date.now() - t0,
        loaded: results.loaded,
        duplicates: results.duplicates.length,
        skipped: results.skipped.length,
        failed: results.failed.length,
      },
      'lab upload done',
    );

    // Only a real change triggers the write-back + SSE broadcast; duplicate
    // re-uploads are free (no rewrite, no event, no client reload).
    if (results.loaded > 0) onChange();
    return {
      ok: true,
      loaded: results.loaded,
      duplicates: results.duplicates,
      skipped: results.skipped,
      failed: results.failed,
    };
  });
}
