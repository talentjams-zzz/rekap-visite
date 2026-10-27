// Ports v1 test_telaah.py, test_pio.py, test_catatan.py:
// daily-task reset semantics + patient-level items never touched by merges.
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { apiRows } from '../helpers/server.js';


const MR = '884240';
const P = { mr: MR, nama: 'AYSHA', tglReg: '2026-08-25 08:00:00' };

async function waitCheck(
  base: string,
  pred: (r: any) => boolean,
): Promise<any> {
  for (let i = 0; i < 60; i++) {
    const rows = await apiRows(base);
    const r = rows.find((x: any) => x.mr === MR);
    if (r && pred(r)) return r;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error('timeout waiting for row state');
}

test.describe('checklist daily-reset semantics', () => {
  test('telaah resets on new day, kept on same-day reload, kept on older file; patient item preserved', async ({
    server,
    page,
  }) => {
    const { base, dir } = server;
    const f25 = buildRegistryFile(dir, 'nusin', '25-08-26', [P]);
    const f26 = buildRegistryFile(dir, 'nusin', '26-08-26', [P]);

    await page.goto(base, { waitUntil: 'load' });
    await page.locator('#file-input').setInputFiles([f25]);
    await waitCheck(base, (r) => r.tglRegistrasi != null);

    const row = page.locator('table tbody tr').first();
    await row.locator('button', { hasText: 'TR' }).click();
    await row.locator('button', { hasText: 'V' }).click();
    await waitCheck(base, (r) => r.checklist.telaah_resep && r.checklist.visite);

    // New day → daily item cleared, patient item kept, dateAdded advances.
    await page.locator('#file-input').setInputFiles([f26]);
    let r = await waitCheck(base, (x) => x.dateAdded === '2026-08-26');
    expect(r.checklist.telaah_resep).toBeNull();
    expect(r.checklist.visite).toBeTruthy();

    // The upload's reload is coalesced (150 ms): wait until the UI shows the
    // new day BEFORE re-clicking. A toggle click uses the SHOWN row state —
    // clicking a not-yet-reloaded row would toggle from the stale (pre-upload)
    // checklist and erase the check.
    await expect(page.locator('table tbody tr td:nth-child(2)').first()).toContainText('2026-08-26');

    // Re-check, reload SAME day → must be kept (idempotent).
    await page.locator('table tbody tr').first().locator('button', { hasText: 'TR' }).click();
    await waitCheck(base, (x) => x.checklist.telaah_resep);
    await page.locator('#file-input').setInputFiles([f26]);
    r = await waitCheck(base, (x) => x.checklist.telaah_resep);
    expect(r.dateAdded).toBe('2026-08-26');

    // OLDER file out of order → clears nothing, never rolls dateAdded back.
    await page.locator('#file-input').setInputFiles([f25]);
    r = await waitCheck(base, (x) => x.checklist.telaah_resep && x.dateAdded === '2026-08-26');
    expect(r.checklist.telaah_resep).toBeTruthy();
  });

  test('catatan_pengobatan is a one-time task: never reset by a new day', async ({ server, page }) => {
    const { base, dir } = server;
    const f25 = buildRegistryFile(dir, 'nusin', '25-08-26', [P]);
    const f26 = buildRegistryFile(dir, 'nusin', '26-08-26', [P]);
    await page.goto(base, { waitUntil: 'load' });
    await page.locator('#file-input').setInputFiles([f25]);
    await waitCheck(base, (r) => r.tglRegistrasi != null);
    await page.locator('table tbody tr').first().locator('button', { hasText: 'CP' }).click();
    await waitCheck(base, (r) => r.checklist.catatan_pengobatan);

    await page.locator('#file-input').setInputFiles([f26]);
    const r = await waitCheck(base, (x) => x.dateAdded === '2026-08-26');
    expect(r.checklist.catatan_pengobatan).toBeTruthy(); // NOT reset
  });

  test('pio resets like telaah_resep', async ({ server, page }) => {
    const { base, dir } = server;
    const f25 = buildRegistryFile(dir, 'melati', '25-08-26', [P]);
    const f26 = buildRegistryFile(dir, 'melati', '26-08-26', [P]);
    await page.goto(base, { waitUntil: 'load' });
    await page.locator('#file-input').setInputFiles([f25]);
    await waitCheck(base, (r) => r.tglRegistrasi != null);
    await page.locator('nav button', { hasText: 'Melati' }).click();
    await page.locator('table tbody tr').first().locator('button', { hasText: 'PIO' }).click();
    await waitCheck(base, (r) => r.checklist.pio);

    await page.locator('#file-input').setInputFiles([f26]);
    const r = await waitCheck(base, (x) => x.dateAdded === '2026-08-26');
    expect(r.checklist.pio).toBeNull();
  });
});
