// Review regression: rapid-click checklist conflicts. Two fast clicks on the
// same row used to reuse the same render (stale value + stale rev) → the
// second write 409'd and the UI flashed "Row changed on another device".
// With server-side toggle + per-row serialization, fast clicks compose:
// same chip twice = net no-op; different chips = both applied; no conflict
// banner in any case.
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { apiRows } from '../helpers/server.js';
import { uploadFiles, waitRows } from '../helpers/ui.js';

const MR = '610200';

async function getRow(base: string) {
  const rows = await apiRows(base, 'active');
  return rows.find((x: any) => x.mr === MR);
}

test('rapid double-click on the same chip: composes, no self-conflict', async ({
  server,
  page,
}) => {
  const { base, dir } = server;
  await page.goto(base, { waitUntil: 'load' });
  const reg = buildRegistryFile(dir, 'nusin', '02-10-26', [
    { mr: MR, nama: 'RAPID', tglReg: '2026-10-02 08:00:00' },
  ]);
  await uploadFiles(page, [reg]);
  await waitRows(base, 'active', (r) => r.some((x) => x.mr === MR));
  await expect(page.locator('table tbody tr').filter({ hasText: MR })).toBeVisible();

  const tr = page.locator('table tbody tr').filter({ hasText: MR }).locator('button', { hasText: 'TR' });
  await tr.click();
  await tr.click(); // back-to-back, before the first write settles

  // Net effect of two toggles: unchecked. And no self-inflicted conflict.
  for (let i = 0; i < 40; i++) {
    const r = await getRow(base);
    if (r.checklist.telaah_resep === null && r.rev >= 2) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  const row = await getRow(base);
  expect(row.checklist.telaah_resep).toBeNull();
  expect(row.rev).toBeGreaterThanOrEqual(2); // both writes landed (no 409 drop)
  await expect(page.getByText(/another device/)).toHaveCount(0);
  await expect(page.getByText(/Check failed/)).toHaveCount(0);
});

test('rapid clicks on two different chips: both applied, no self-conflict', async ({
  server,
  page,
}) => {
  const { base, dir } = server;
  await page.goto(base, { waitUntil: 'load' });
  const reg = buildRegistryFile(dir, 'nusin', '03-10-26', [
    { mr: MR, nama: 'RAPID2', tglReg: '2026-10-03 08:00:00' },
  ]);
  await uploadFiles(page, [reg]);
  await waitRows(base, 'active', (r) => r.some((x) => x.mr === MR));
  await expect(page.locator('table tbody tr').filter({ hasText: MR })).toBeVisible();

  const rowLoc = page.locator('table tbody tr').filter({ hasText: MR });
  await rowLoc.locator('button', { hasText: 'TR' }).click();
  await rowLoc.locator('button', { hasText: 'CP' }).click();

  for (let i = 0; i < 40; i++) {
    const r = await getRow(base);
    if (r.checklist.telaah_resep && r.checklist.catatan_pengobatan) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  const row = await getRow(base);
  expect(row.checklist.telaah_resep).toBeTruthy();
  expect(row.checklist.catatan_pengobatan).toBeTruthy();
  await expect(page.getByText(/another device/)).toHaveCount(0);
});

test('rapid double-click on a patient-level chip: composes, no conflict', async ({
  server,
  page,
}) => {
  const { base, dir } = server;
  await page.goto(base, { waitUntil: 'load' });
  const reg = buildRegistryFile(dir, 'nusin', '04-10-26', [
    { mr: MR, nama: 'RAPID3', tglReg: '2026-10-04 08:00:00' },
  ]);
  await uploadFiles(page, [reg]);
  await waitRows(base, 'active', (r) => r.some((x) => x.mr === MR));
  await expect(page.locator('table tbody tr').filter({ hasText: MR })).toBeVisible();

  const v = page.locator('table tbody tr').filter({ hasText: MR }).locator('button', { hasText: 'V' });
  await v.click();
  await v.click();

  for (let i = 0; i < 40; i++) {
    const r = await getRow(base);
    if (r.checklist.visite === null) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  const row = await getRow(base);
  expect(row.checklist.visite).toBeNull();
  await expect(page.getByText(/another device/)).toHaveCount(0);
});
