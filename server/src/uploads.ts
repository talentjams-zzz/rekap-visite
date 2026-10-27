// POST /api/uploads — multipart .xlsx upload → parse (core) → merge → persist.
import XLSX from 'xlsx';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { applyFiles } from './core/apply.js';
import { dateFromFilename, detectFacility, inputTimestamp } from './core/filename.js';
import type { ParsedFile, Sheet } from './core/types.js';
import { loadWorldState, saveWorldState } from './state.js';
import { structuredUploadError } from './uploadErrors.js';

export function registerUploads(
  app: FastifyInstance,
  db: DatabaseSync,
  onChange: () => void,
): void {
  app.post('/api/uploads', async (req, reply) => {
    const t0 = Date.now();
    // The registry path MUST buffer all files before merging (one world
    // state merge across the batch) — client-side batching (5 per request)
    // bounds the memory, unlike the lab path which streams per file.
    const files: { filename: string; buffer: Buffer }[] = [];
    try {
      for await (const part of req.files()) {
        const buf = await part.toBuffer();
        files.push({ filename: part.filename, buffer: buf });
      }
    } catch (e) {
      const s = structuredUploadError(e);
      if (s) {
        app.log.warn({ reqId: req.id, filesSoFar: files.length }, 'upload: multipart limit hit');
        return reply.code(s.status).send(s.body);
      }
      app.log.error({ err: e, reqId: req.id }, 'upload: multipart receive failed');
      return reply.code(500).send({ ok: false, code: 'RECEIVE_ERROR', message: 'The upload could not be received. Try again with smaller batches.' });
    }
    if (!files.length) {
      reply.code(400);
      return { ok: false, code: 'NO_FILES', message: 'No files uploaded.' };
    }

    // Server-side analog of v1's file mtime: the upload time distinguishes
    // several uploads on the same day (the newest upload wins).
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const nowTs = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
    const today = nowTs.slice(0, 10);

    const parsed: ParsedFile[] = [];
    const skipped: string[] = [];
    const failed: { filename: string; code: string; message: string }[] = [];
    // Dedupe key = filename + content hash. Same name + same bytes → the
    // exact same report re-uploaded (skip: re-merging would bump the
    // upload-time inputTs). Same bytes under a DIFFERENT day's filename is
    // a legitimate new report (e.g. identical patient list on day N+1).
    const seen = db
      .prepare("SELECT filename || ':' || sha256 AS k FROM uploads")
      .all() as { k: string }[];
    const known = new Set(seen.map((r) => r.k));
    for (const f of files) {
      const facility = detectFacility(f.filename);
      if (!facility) {
        skipped.push(`${f.filename} (unknown facility)`);
        continue;
      }
      const dupKey = `${f.filename}:${createHash('sha256').update(f.buffer).digest('hex')}`;
      if (known.has(dupKey)) {
        skipped.push(`${f.filename} (duplicate — already uploaded)`);
        continue;
      }
      known.add(dupKey);
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
      } catch {
        // A readable upload that XLSX cannot parse is a per-file FAILURE
        // (distinct from business skips like duplicates/unknown facility).
        failed.push({ filename: f.filename, code: 'INVALID_XLSX', message: `${f.filename} is not a readable Excel file` });
      }
    }

    if (!parsed.length) {
      // Every file was skipped (duplicate / unknown facility / unparseable).
      // Report success with the skip reasons (v1 showed them in the same
      // toast) and do NOT re-run the archive sync on an empty batch.
      return {
        ok: true,
        files: 0,
        added: 0,
        merged: 0,
        skipped,
        failed,
        warnings: [],
        sync: { archived: 0, unarchived: 0 },
      };
    }

    const state = loadWorldState(db);
    const result = applyFiles(state, parsed, nowTs);
    saveWorldState(db, state);

    // Readmission follow-up (see core/parsers.ts): the core already
    // snapshotted + cleared the ROW-level episode fields (D/O/T, note,
    // SOAP, ASO) into the old episode's last riwayat day. The patient-level
    // checklist is keyed by MR OUTSIDE WorldState (direct-write lifecycle,
    // see patient_checklist), so its per-episode snapshot + reset happens
    // here: copy the current ticks into the old episode's last day (v2-only
    // riwayat columns), then clear them for the new episode. COALESCE so a
    // missing patient_checklist row never clobbers an existing snapshot.
    for (const ev of result.readmissions) {
      db.prepare(
        `UPDATE patient_days SET
           visite            = COALESCE((SELECT checked_at FROM patient_checklist WHERE mr = ? AND item_key = 'visite'), visite),
           pto               = COALESCE((SELECT checked_at FROM patient_checklist WHERE mr = ? AND item_key = 'pto'), pto),
           konseling         = COALESCE((SELECT checked_at FROM patient_checklist WHERE mr = ? AND item_key = 'konseling'), konseling),
           rekonsiliasi_obat = COALESCE((SELECT checked_at FROM patient_checklist WHERE mr = ? AND item_key = 'rekonsiliasi_obat'), rekonsiliasi_obat),
           penelusuran_obat  = COALESCE((SELECT checked_at FROM patient_checklist WHERE mr = ? AND item_key = 'penelusuran_obat'), penelusuran_obat)
         WHERE patient_id = ? AND report_date = ?`,
      ).run(ev.mr, ev.mr, ev.mr, ev.mr, ev.mr, ev.rowId, ev.episodeEnd);
      db.prepare('UPDATE patient_checklist SET checked_at = NULL WHERE mr = ?').run(ev.mr);
    }

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
    app.log.info(
      {
        reqId: req.id,
        files: files.length,
        bytes: files.reduce((a, f) => a + f.buffer.length, 0),
        maxFileBytes: files.reduce((a, f) => Math.max(a, f.buffer.length), 0),
        ms: Date.now() - t0,
        parsed: parsed.length,
        skipped: skipped.length,
        failed: failed.length,
        readmissions: result.readmissions.length,
      },
      'upload done',
    );
    return {
      ok: true,
      files: parsed.length,
      added: result.added,
      merged: result.merged,
      readmissions: result.readmissions.length,
      skipped,
      failed,
      warnings: result.warnings,
      sync: result.sync,
    };
  });
}
