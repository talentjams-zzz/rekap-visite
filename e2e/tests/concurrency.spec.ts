// Optimistic concurrency (P9): row writes echo the row rev they loaded.
// A stale rev → 409 conflict; the UI toasts and reloads.
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { apiRows } from '../helpers/server.js';
import { uploadFiles, waitRows } from '../helpers/ui.js';

const MR = '400001';
const ID = `${MR}_nusin`;

test('stale rev → 409 conflict; UI handles conflict with toast + reload', async ({
  server,
  page,
}) => {
  const { base, dir } = server;
  const f = buildRegistryFile(dir, 'nusin', '12-10-26', [
    { mr: MR, nama: 'CONC', tglReg: '2026-10-12 08:00:00' },
  ]);
  await page.goto(base, { waitUntil: 'load' });
  await uploadFiles(page, [f]);
  await waitRows(base, 'active', (r) => r.length === 1);

  // Device A loads the row (rev 0).
  const revA = (await apiRows(base))[0].rev;
  expect(revA).toBe(0);

  // Device B writes first (valid rev) → rev becomes 1.
  const rB = await fetch(`${base}/api/rows/${ID}/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'telaah_resep', value: '2026-10-12 10:00:00', rev: revA }),
  });
  expect(rB.status).toBe(200);

  // Device A's stale write (old rev) → 409, row state untouched by it.
  const rA = await fetch(`${base}/api/rows/${ID}/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'catatan_pengobatan', value: '2026-10-12 10:05:00', rev: revA }),
  });
  expect(rA.status).toBe(409);
  const rows = await apiRows(base);
  expect(rows[0].checklist.catatan_pengobatan).toBeNull();
  expect(rows[0].rev).toBe(1);

  // UI path: force the next check POST to 409 (simulates the race where the
  // SSE reload hasn't landed yet) → toast + reload.
  await page.route(`${base}/api/rows/${ID}/check`, (route) =>
    route.fulfill({ status: 409, contentType: 'application/json', body: '{"ok":false,"error":"conflict"}' }),
  );
  await page.locator('table tbody tr').first().locator('button', { hasText: 'TR' }).click();
  await page.waitForSelector('text=Row changed on another device');
});
