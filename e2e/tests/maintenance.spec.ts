// Port of v1 test_monthly_cleanup.py for the v2 SQLite world:
// backup first (timestamped .db copy), verify the backup (open + count),
// only then remove archived rows + orphaned per-MR data, record the run.
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { apiRows } from '../helpers/server.js';
import { uploadFiles, waitRows } from '../helpers/ui.js';
import { existsSync } from 'node:fs';
import path from 'node:path';

const A = { mr: '600001', nama: 'ALPHA', tglReg: '2026-08-25 08:00:00' };
const B = { mr: '600002', nama: 'BRAVO', tglReg: '2026-08-25 09:00:00' };

test('monthly maintenance: backup, verify, remove archived, record lastMaintenance', async ({
  server,
  page,
}) => {
  const { base, dir } = server;
  const f1 = buildRegistryFile(dir, 'nusin', '25-08-26', [A, B]);
  const f2 = buildRegistryFile(dir, 'nusin', '26-08-26', [A]); // B absent → archived

  await page.goto(base, { waitUntil: 'load' });
  await uploadFiles(page, [f1]);
  await waitRows(base, 'active', (r) => r.length === 2);
  await uploadFiles(page, [f2]);
  await waitRows(base, 'archived', (r) => r.length === 1);

  // Run the job (same endpoint the 🧹 button calls).
  const res = (await (
    await fetch(`${base}/api/maintenance/run`, { method: 'POST' })
  ).json()) as any;
  expect(res.ok).toBe(true);
  expect(res.lastMaintenance.removedRows).toBe(1);
  expect(res.lastMaintenance.rowsBefore).toBe(2);
  expect(res.lastMaintenance.rowsAfter).toBe(1);
  expect(res.lastMaintenance.backupFile).toMatch(/rekap-visite-backup-.*\.db$/);

  // Backup file exists next to the DB; archived row is gone.
  expect(existsSync(path.join(dir, res.lastMaintenance.backupFile))).toBe(true);
  expect((await apiRows(base, 'active')).length).toBe(1);
  expect((await apiRows(base, 'archived')).length).toBe(0);

  // GET reports the run; the UI button is present.
  const m = (await (await fetch(`${base}/api/maintenance`)).json()) as any;
  expect(m.lastMaintenance.removedRows).toBe(1);
  expect(m.enabled).toBe(true);
  expect(await page.locator('button', { hasText: '🧹 Monthly Cleanup' }).count()).toBe(1);
});
