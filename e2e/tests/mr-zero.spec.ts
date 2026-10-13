// Ports v1 test_mr_leading_zero.py:
// "000623" and "623" are the same patient — must merge into ONE row on the
// canonical (existing) MR; a numeric MR must not create a duplicate.
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { waitRows, uploadFiles } from '../helpers/ui.js';

test('leading-zero MR variants merge into one canonical row', async ({ server, page }) => {
  const { base, dir } = server;
  const f1 = buildRegistryFile(dir, 'nusin', '10-09-26', [
    { mr: '000623', nama: 'ZERO', tglReg: '2026-09-10 08:00:00' },
  ]);
  const f2 = buildRegistryFile(dir, 'nusin', '11-09-26', [
    { mr: '623', nama: 'ZERO', tglReg: '2026-09-11 08:00:00' },
  ]);

  await page.goto(base, { waitUntil: 'load' });
  await uploadFiles(page, [f1]);
  await waitRows(base, 'active', (r) => r.length === 1);

  await uploadFiles(page, [f2]);
  await waitRows(base, 'active', (r) => r.length === 1 && r[0].dateAdded === '2026-09-11');

  // Exactly one row total (active or archived), canonical zero-padded MR kept,
  // 2 days of history.
  const rows = await page.evaluate(async () => {
    const a = await (await fetch('/api/rows?status=active')).json();
    const b = await (await fetch('/api/rows?status=archived')).json();
    return [...a, ...b];
  });
  expect(rows.length).toBe(1);
  expect(rows[0].mr).toBe('000623');
  expect(rows[0].dayCount).toBe(2);
});
