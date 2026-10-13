// Monthly maintenance — port of v1 server.js runMonthlyMaintenance.
// 1) BACKUP the whole DB to a timestamped file next to the live DB.
// 2) VERIFY the backup (open read-only + patient count) BEFORE touching
//    live data.
// 3) Only then remove archived rows (cascade) + orphaned per-MR
//    checklist/lab data.
// 4) Record the run in maintenance_log (v1 lastMaintenance field).
//
// Scheduling: on the 1st of each month at/after REKAP_CLEANUP_TIME
// (default 00:05 local), once per month. A first-time or mid-month startup
// never triggers it — the manual button / POST still work.
import type { FastifyInstance } from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync } from 'node:fs';
import path from 'node:path';

const ENABLED = (process.env.REKAP_CLEANUP ?? '1') !== '0';
const CLEANUP_TIME = process.env.REKAP_CLEANUP_TIME || '00:05'; // "HH:MM" local
const CLEANUP_DAY = 1;

const pad2 = (n: number) => String(n).padStart(2, '0');
function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function hhmm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

interface MaintenanceResult {
  ok: boolean;
  error?: string;
  lastMaintenance?: {
    ranAt: string;
    trigger: string;
    backupFile: string;
    rowsBefore: number;
    rowsAfter: number;
    removedRows: number;
    removedChecklist: number;
    removedLab: number;
  };
}

let running = false;

export function runMaintenance(
  db: DatabaseSync,
  dbFile: string,
  trigger: string,
  onChange: () => void,
): MaintenanceResult {
  if (running) return { ok: false, error: 'maintenance already running' };
  running = true;
  try {
    const rowsBefore = Number(
      (db.prepare('SELECT COUNT(*) c FROM patients').get() as { c: number }).c,
    );
    const pcBefore = Number(
      (db.prepare('SELECT COUNT(DISTINCT mr) c FROM patient_checklist').get() as { c: number }).c,
    );
    const labBefore = Number(
      (db.prepare('SELECT COUNT(DISTINCT mr) c FROM labs').get() as { c: number }).c,
    );

    // 1) BACKUP FIRST — checkpoint so the main file is complete, then copy.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const now = new Date();
    const backupFile =
      `rekap-visite-backup-${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
      `-${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}.db`;
    const backupPath = path.join(path.dirname(dbFile), backupFile);
    copyFileSync(dbFile, backupPath);

    // 2) VERIFY the backup before touching live data.
    const bak = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const c = Number((bak.prepare('SELECT COUNT(*) c FROM patients').get() as { c: number }).c);
      if (c !== rowsBefore) {
        throw new Error(`backup verification failed (expected ${rowsBefore}, got ${c}) — nothing was removed`);
      }
    } finally {
      bak.close();
    }

    // 3) REMOVE archived rows + orphaned per-MR data (safe: backup verified).
    db.exec('BEGIN');
    try {
      // archived cascades to patient_days / row_checklist / daily_logs.
      db.exec('DELETE FROM patients WHERE archived = 1');
      db.exec('DELETE FROM patient_checklist WHERE mr NOT IN (SELECT mr FROM patients)');
      db.exec('DELETE FROM labs WHERE mr NOT IN (SELECT mr FROM patients)');
      const rowsAfter = Number(
        (db.prepare('SELECT COUNT(*) c FROM patients').get() as { c: number }).c,
      );
      const pcAfter = Number(
        (db.prepare('SELECT COUNT(DISTINCT mr) c FROM patient_checklist').get() as { c: number }).c,
      );
      const labAfter = Number(
        (db.prepare('SELECT COUNT(DISTINCT mr) c FROM labs').get() as { c: number }).c,
      );
      const lastMaintenance = {
        ranAt: localStamp(now),
        trigger,
        backupFile,
        rowsBefore,
        rowsAfter,
        removedRows: rowsBefore - rowsAfter,
        removedChecklist: pcBefore - pcAfter,
        removedLab: labBefore - labAfter,
      };
      db.prepare(
        `INSERT INTO maintenance_log (ran_at, trigger, backup_file, rows_before, rows_after,
                                       removed_rows, removed_checklist, removed_lab)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        lastMaintenance.ranAt,
        lastMaintenance.trigger,
        lastMaintenance.backupFile,
        lastMaintenance.rowsBefore,
        lastMaintenance.rowsAfter,
        lastMaintenance.removedRows,
        lastMaintenance.removedChecklist,
        lastMaintenance.removedLab,
      );
      db.exec('COMMIT');
      onChange();
      return { ok: true, lastMaintenance };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    running = false;
  }
}

/** Due ONLY at the scheduled moment: 1st of month at/after CLEANUP_TIME,
 *  once per month. First-time or mid-month startup never triggers it. */
export function cleanupDue(now: Date, lastRanAt: string | null): boolean {
  if (!ENABLED) return false;
  const mk = monthKey(now);
  if (lastRanAt && lastRanAt.slice(0, 7) === mk) return false;
  if (now.getDate() !== CLEANUP_DAY) return false;
  if (hhmm(now) < CLEANUP_TIME) return false;
  return true;
}

export function registerMaintenance(
  app: FastifyInstance,
  db: DatabaseSync,
  dbFile: string,
  onChange: () => void,
): void {
  const last = () =>
    (db.prepare('SELECT ran_at, trigger, backup_file, rows_before, rows_after, removed_rows, removed_checklist, removed_lab FROM maintenance_log ORDER BY id DESC LIMIT 1').get() as
      | {
          ran_at: string;
          trigger: string;
          backup_file: string;
          rows_before: number;
          rows_after: number;
          removed_rows: number;
          removed_checklist: number;
          removed_lab: number;
        }
      | undefined) ?? undefined;

  app.get('/api/maintenance', async () => {
    const l = last();
    return {
      ok: true,
      enabled: ENABLED,
      day: CLEANUP_DAY,
      time: CLEANUP_TIME,
      lastMaintenance: l
        ? {
            ranAt: l.ran_at,
            trigger: l.trigger,
            backupFile: l.backup_file,
            rowsBefore: l.rows_before,
            rowsAfter: l.rows_after,
            removedRows: l.removed_rows,
            removedChecklist: l.removed_checklist,
            removedLab: l.removed_lab,
          }
        : null,
    };
  });

  app.post('/api/maintenance/run', async (req, reply) => {
    const trigger = req.query && (req.query as { trigger?: string }).trigger === 'scheduled' ? 'scheduled' : 'manual';
    const res = runMaintenance(db, dbFile, trigger, onChange);
    if (!res.ok) {
      reply.code(500);
      return res;
    }
    return res;
  });

  // Minute-granularity scheduler (no cron needed).
  const timer = setInterval(() => {
    const l = last();
    if (cleanupDue(new Date(), l ? l.ran_at : null)) {
      runMaintenance(db, dbFile, 'scheduled', onChange);
    }
  }, 60_000);
  timer.unref?.();
}
