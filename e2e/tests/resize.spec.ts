// Every column must be freely resizable: table-fixed layout + a visible drag
// grip on every header (including display columns like Hasil Lab/ASO/SOAP).
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { uploadFiles, waitRows } from '../helpers/ui.js';

test('every column header has a resize grip and dragging resizes the column', async ({
  server,
  page,
}) => {
  const { base, dir } = server;
  const f = buildRegistryFile(dir, 'nusin', '26-08-26', [
    { mr: '520001', nama: 'RESIZE', tglReg: '2026-08-26 08:00:00' },
  ]);
  await page.goto(base, { waitUntil: 'load' });
  await uploadFiles(page, [f]);
  await waitRows(base, 'active', (r) => r.length === 1);

  // Every column — including display columns — is resizable.
  const colCount = await page.locator('thead th').count();
  const grips = page.locator('thead span[title="Drag to resize"]');
  expect(await grips.count()).toBe(colCount);
  expect(colCount).toBeGreaterThan(5);

  // Drag the first column's grip ~60px right; the column must follow.
  const th = page.locator('thead th').first();
  const before = (await th.boundingBox())!;
  const grip = grips.first();
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  const after = (await th.boundingBox())!;
  expect(after.width).toBeGreaterThan(before.width + 40);
});

test('header row stays pinned at the top when the table scrolls', async ({
  server,
  page,
}) => {
  const { base, dir } = server;
  // 30 patients → the table is taller than the viewport.
  const patients = Array.from({ length: 30 }, (_, i) => ({
    mr: String(600001 + i),
    nama: `PATIENT ${String(i + 1).padStart(2, '0')}`,
    tglReg: '2026-08-26 08:00:00',
  }));
  const f = buildRegistryFile(dir, 'nusin', '26-08-26', patients);
  await page.goto(base, { waitUntil: 'load' });
  await uploadFiles(page, [f]);
  await waitRows(base, 'active', (r) => r.length === 30);

  const header = page.locator('thead th').first();
  const firstRow = page.locator('table tbody tr').nth(5);
  const headerBefore = (await header.boundingBox())!;
  const rowBefore = (await firstRow.boundingBox())!;

  // Scroll the table's scroll box down.
  await page.evaluate(() => {
    const scroller = document.querySelector('main table')?.parentElement;
    if (scroller) scroller.scrollTop = 600;
  });
  await page.waitForTimeout(150);

  const headerAfter = (await header.boundingBox())!;
  const rowAfter = (await firstRow.boundingBox())!;
  // Header pinned (same position), rows scrolled away.
  expect(Math.abs(headerAfter.y - headerBefore.y)).toBeLessThan(2);
  expect(rowAfter.y).toBeLessThan(rowBefore.y - 300);
});
