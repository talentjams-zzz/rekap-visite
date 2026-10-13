// Upload dedupe by sha256 (P9): a byte-identical file is skipped instead of
// re-merged (re-merging would bump the upload-time inputTs).
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { uploadFiles, waitRows } from '../helpers/ui.js';

test('byte-identical re-upload is skipped with a duplicate message', async ({ server, page }) => {
  const { base, dir } = server;
  const f = buildRegistryFile(dir, 'nusin', '25-08-26', [
    { mr: '500001', nama: 'DEDUPE', tglReg: '2026-08-25 08:00:00' },
  ]);
  await page.goto(base, { waitUntil: 'load' });
  await uploadFiles(page, [f]);
  await waitRows(base, 'active', (r) => r.length === 1);

  // Re-upload the exact same bytes → skipped as duplicate.
  await uploadFiles(page, [f]);
  await page.waitForSelector('div.fixed div', { timeout: 10000 });
  const toast = await page.locator('div.fixed div').last().innerText();
  expect(toast).toContain('duplicate');

  // State unchanged: still one active row.
  await waitRows(base, 'active', (r) => r.length === 1);
});
