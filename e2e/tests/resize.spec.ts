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
