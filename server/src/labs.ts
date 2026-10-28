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
//  - exact (filename, sha256) dedupe via lab_uploads: a re-upload of the
//    same file is a no-op — no re-parse, no rewrite, no write-back, no SSE.
//  - structured error codes (FILE_COUNT_LIMIT / FILE_TOO_LARGE / …) instead
//    of opaque HTTP failures, plus request logging (count/bytes/duration).
//
// v2.1.1 (review F1/F2 fix) — staged commits:
//  The handler used to hold `BEGIN` open across the ENTIRE multipart stream
//  (network awaits inside a transaction on the shared connection):
//   - F2: an overlapping request's BEGIN failed, and its catch rolled back
//     the FIRST request's open transaction — normal overlapping users
//     corrupted each other's uploads.
//   - F1: a per-file DB failure broke the loop and then hit `COMMIT` —
//     committing the earlier writes while returning "nothing was saved".
//  Now the request runs in two phases:
//   1. STREAM + PARSE + DE DUPE — no transaction is open during any network
//      await; each file is reduced to a bounded staged record (or recorded
//      as duplicate/skipped/failed).
//   2. COMMIT — one short SYNCHRONOUS transaction (no awaits inside, so no
//      other code can interleave on the event loop) that writes only what
//      fully staged. Any failure rolls back THIS transaction only: nothing
//      from the batch lands, and the "nothing was saved" message is true.
//  A duplicate that only becomes visible at commit (another request ingested
//  the identical file while this one was streaming) is demoted per-row to a
//  duplicate instead of failing the whole chunk.
import XLSX from 'xlsx';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
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

/** One fully-parsed lab file, ready for the commit transaction. */
interface StagedLab {
  filename: string;
  mr: string;
  sha: string;
  loadedAt: string;
  maxDate: string;
  testsJson: string;
  testCount: number;
  abnormalCount: number;
  kritisCount: number;
}

/**
 * Parse + validate ONE lab file without writing anything (review F2: no DB
 * writes while the multipart stream is still in flight). Dedupe is a
 * read-only check against committed audit rows; duplicates that only
 * materialize at commit time (concurrent identical upload) are demoted
 * there instead of failing the chunk.
 * Returns the staged record, or null when the file was recorded as
 * duplicate/skipped/failed in `results`.
 */
export function stageLabFile(
  db: DatabaseSync,
  filename: string,
  buffer: Buffer,
  results: LabFileResult,
): StagedLab | null {
  const m = filename.toLowerCase().match(/^lab[-_ ]?(\d+)/i);
  if (!m) {
    results.skipped.push(`${filename} (no MR in name)`);
    return null;
  }
  const mr = m[1];
  const sha = createHash('sha256').update(buffer).digest('hex');

  // Dedupe BEFORE parsing: the exact same file was already accepted.
  const seen = db
    .prepare('SELECT 1 FROM lab_uploads WHERE filename = ? AND sha256 = ?')
    .get(filename, sha) as { 1: number } | undefined;
  if (seen) {
    results.duplicates.push(filename);
    return null;
  }

  // Lazy worksheet conversion: inspect one sheet at a time, stop at the
  // first "Nama Pemeriksaan" header. Unrelated cover sheets are never
  // fully converted (bounded memory).
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    results.failed.push({
      filename,
      code: 'INVALID_XLSX',
      message: `${filename} is not a readable Excel file`,
    });
    return null;
  }
  // sheetjs is lenient: some garbage parses into a workbook with zero
  // sheets. That is "not an Excel file", not "no lab sheet".
  if (wb.SheetNames.length === 0) {
    results.failed.push({
      filename,
      code: 'INVALID_XLSX',
      message: `${filename} is not a readable Excel file (no worksheets)`,
    });
    return null;
  }
  if (wb.SheetNames.length > MAX_SHEETS) {
    results.failed.push({
      filename,
      code: 'WORKBOOK_TOO_LARGE',
      message: `${filename} has ${wb.SheetNames.length} worksheets (max ${MAX_SHEETS})`,
    });
    return null;
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
      return null;
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
    return null;
  }
  const tests = report.tests;
  const abnormalCount = tests.filter((t) => t.abnormal).length;
  const kritisCount = tests.filter((t) => t.kritis).length;
  return {
    filename, mr, sha, loadedAt: nowTs(), maxDate: report.maxDate,
    testsJson: JSON.stringify(tests), testCount: tests.length, abnormalCount, kritisCount,
  };
}

/**
 * The ONLY transaction of a lab upload (review F1/F2): a short synchronous
 * write of everything staged, with no network await inside, so no other code
 * can interleave mid-transaction on the event loop. A failure rolls back
 * THIS transaction only — earlier data is untouched and nothing from the
 * batch persists. Throws on unexpected errors (the caller returns the
 * structured 500); returns the rows demoted to duplicates (concurrent
 * identical-file race on the audit UNIQUE).
 */
export function commitStagedLabs(db: DatabaseSync, staged: StagedLab[]): { duplicates: StagedLab[] } {
  const dupes: StagedLab[] = [];
  const upsert = db.prepare(
    `INSERT INTO labs (mr, filename, loaded_at, max_date, tests_json,
                       test_count, abnormal_count, kritis_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mr) DO UPDATE SET
       filename = excluded.filename,
       loaded_at = excluded.loaded_at,
       max_date = excluded.max_date,
       tests_json = excluded.tests_json,
       test_count = excluded.test_count,
       abnormal_count = excluded.abnormal_count,
       kritis_count = excluded.kritis_count`,
  );
  const audit = db.prepare('INSERT INTO lab_uploads (filename, sha256, mr, loaded_at) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const s of staged) {
      upsert.run(s.mr, s.filename, s.loadedAt, s.maxDate, s.testsJson, s.testCount, s.abnormalCount, s.kritisCount);
      try {
        audit.run(s.filename, s.sha, s.mr, s.loadedAt);
      } catch (e) {
        const msg = (e as Error).message ?? '';
        if (msg.includes('UNIQUE constraint failed: lab_uploads')) {
          // Another request committed this exact file while we were
          // streaming. The labs row just got the same content — treat this
          // file as a duplicate, keep the rest of the chunk.
          dupes.push(s);
          continue;
        }
        throw e;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw e;
  }
  return { duplicates: dupes };
}

export function registerLabs(app: FastifyInstance, db: DatabaseSync, onChange: () => void): void {
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
    const staged: StagedLab[] = [];
    let fileCount = 0;
    let totalBytes = 0;
    let maxBytes = 0;

    // ── Phase 1: stream + parse + dedupe. NO transaction is open here, so
    // overlapping requests cannot hold/roll back each other's state (F2).
    // Multipart LIMIT violations (file count / size) can surface from the
    // iterator itself or from toBuffer — both land in this one handler.
    try {
      for await (const part of req.files()) {
        const buf = await part.toBuffer();
        fileCount++;
        totalBytes += buf.length;
        maxBytes = Math.max(maxBytes, buf.length);
        const s = stageLabFile(db, part.filename, buf, results);
        if (s) staged.push(s);
      }
    } catch (e) {
      const s = structuredUploadError(e);
      if (s) {
        app.log.warn(
          { reqId: req.id, err: (e as Error).message, filesSoFar: fileCount, bytesSoFar: totalBytes },
          'lab upload: multipart limit hit',
        );
        return reply.code(s.status).send(s.body);
      }
      app.log.error({ err: e, reqId: req.id, filesSoFar: fileCount }, 'lab upload: stream failed');
      return reply.code(500).send({ ok: false, code: 'UPLOAD_ERROR', message: 'The upload could not be read — nothing was saved. Try again.' });
    }

    if (!fileCount) {
      return reply.code(400).send({ ok: false, code: 'NO_FILES', message: 'No files uploaded.' });
    }

    // ── Phase 2: the short synchronous commit (F1: COMMIT is reached only
    // after every file fully staged; a failure rolls back this transaction
    // only, so the "nothing was saved" answer is truthful).
    if (staged.length > 0) {
      try {
        const { duplicates } = commitStagedLabs(db, staged);
        results.loaded = staged.length - duplicates.length;
        for (const d of duplicates) results.duplicates.push(`${d.filename} (concurrent duplicate)`);
      } catch (e) {
        app.log.error(
          { err: e, reqId: req.id, staged: staged.length },
          'lab upload: commit failed — nothing from this batch was saved',
        );
        return reply.code(500).send({ ok: false, code: 'DB_ERROR', message: 'Lab upload failed in the database — nothing from this batch was saved. Try again.' });
      }
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
