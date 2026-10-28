// Review F3/F4: cross-control revision coordination + refresh interleaving.
//
// F3: checklist chips, field edits, archive toggles and ASO saves all
// advance the SAME server row revision. They used to coordinate separately
// (their own rev caches/chains), so a delayed response from one control
// left another control's rev stale → false 409 + lost action. With the
// shared per-row coordinator, interleaved writes from different controls
// serialize and each uses the newest known rev.
//
// F4: a refresh that lands while writes are in flight / queued must not
// lose the queued write or invent a conflict — the rev source is reconciled
// with the loaded rows, and the fallback is the freshly-loaded row, never
// the click-time snapshot.
//
// All three tests use CONTROLLED RESPONSE DELAYS (page.route) so the
// overlapping operations are deterministic, per the review's test-coverage
// requirement.
import { test, expect } from '../helpers/fixture.js';
import type { Page } from '@playwright/test';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { apiRows } from '../helpers/server.js';
import { uploadFiles, waitRows } from '../helpers/ui.js';

const NO_CONFLICT = /changed on another device|Check failed|Save failed|ASO save failed|Archive failed/;

const MR = '620100';
const ROW = `${MR}_nusin`;

async function seed(page: Page, server: { base: string; dir: string }, day: string, nama: string) {
  const { base, dir } = server;
  await page.goto(base, { waitUntil: 'load' });
  const reg = buildRegistryFile(dir, 'nusin', day, [{ mr: MR, nama, tglReg: '2026-10-06 08:00:00' }]);
  await uploadFiles(page, [reg]);
  await waitRows(base, 'active', (r) => r.some((x) => x.mr === MR));
  const rowLoc = page.locator('table tbody tr').filter({ hasText: MR });
  await expect(rowLoc).toBeVisible();
  return rowLoc;
}

function rowApi(base: string, mr: string) {
  return apiRows(base, 'active').then((rows) => rows.find((x: any) => x.mr === mr));
}

async function until<T>(fn: () => Promise<T | undefined>, pred: (v: T) => boolean, tries = 60): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v !== undefined && pred(v)) return v;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error('convergence timeout');
}

const diagIndex = (page: Page) =>
  page.getByRole('columnheader', { name: 'Diagnosis' }).evaluate((el) => el.cellIndex);

test('F3: delayed checklist → field edit → checklist — all land, no self-conflict', async ({
  server,
  page,
}) => {
  const { base } = server;
  // Delay every WRITE for this row (check POSTs + PATCH) so all three
  // mutations overlap in flight on the client.
  await page.route(`**/api/rows/${ROW}*`, (route) => {
    const m = route.request().method();
    if (m === 'POST' || m === 'PATCH') setTimeout(() => route.continue(), 350);
    else route.continue();
  });
  const rowLoc = await seed(page, server, '06-10-26', 'COORD');

  // 1. Checklist chip (in flight, delayed).
  await rowLoc.locator('button', { hasText: 'TR' }).click();
  // 2. Field edit on the SAME row (Diagnosis), committed via Ctrl+Enter.
  const di = await diagIndex(page);
  const dx = rowLoc.locator('td').nth(di);
  await dx.locator('span').first().click();
  await dx.locator('textarea').fill('TEST-DX');
  await dx.locator('textarea').press('Control+Enter');
  // 3. A second checklist chip.
  await rowLoc.locator('button', { hasText: 'CP' }).click();

  const r = await until(
    () => rowApi(base, MR),
    (x) => !!x.checklist.telaah_resep && !!x.checklist.catatan_pengobatan && x.diagnosis === 'TEST-DX',
  );
  expect(r.rev).toBeGreaterThanOrEqual(3); // three serialized writes, none dropped
  await expect(page.getByText(NO_CONFLICT)).toHaveCount(0);
});

test('F3: delayed checklist → ASO save → checklist — all land, no self-conflict', async ({
  server,
  page,
}) => {
  const { base } = server;
  await page.route(`**/api/rows/${ROW}*`, (route) => {
    const m = route.request().method();
    if (m === 'POST' || m === 'PATCH') setTimeout(() => route.continue(), 350);
    else route.continue();
  });
  const rowLoc = await seed(page, server, '07-10-26', 'COORD2');

  // 1. Checklist chip (in flight, delayed).
  await rowLoc.locator('button', { hasText: 'TR' }).click();
  // 2. ASO: add a med — the debounced save (500 ms) lands while the chip
  // write is still in flight.
  await rowLoc.locator('button', { hasText: 'Add med' }).click();
  await rowLoc.locator('input[placeholder="Med name"]').fill('AMOXICILLIN');
  // 3. Second checklist chip (queued behind both).
  await rowLoc.locator('button', { hasText: 'CP' }).click();

  const r = await until(
    () => rowApi(base, MR),
    (x) => !!x.checklist.telaah_resep && !!x.checklist.catatan_pengobatan && x.aso?.[0]?.name === 'AMOXICILLIN',
  );
  expect(r.rev).toBeGreaterThanOrEqual(3);
  await expect(page.getByText(NO_CONFLICT)).toHaveCount(0);
});

test('F4: refresh landing between queued writes does not lose or conflict the queued write', async ({
  server,
  page,
}) => {
  const { base } = server;
  // Delay only the FIRST checklist response (the TR one) by 300 ms.
  let delayed = false;
  await page.route(`**/api/rows/${ROW}/check`, (route) => {
    const m = route.request().method();
    if (m === 'POST' && !delayed) {
      delayed = true;
      setTimeout(() => route.continue(), 300);
    } else {
      route.continue();
    }
  });
  const rowLoc = await seed(page, server, '08-10-26', 'COORD3');

  // Click 1: TR — its response is held back 300 ms.
  await rowLoc.locator('button', { hasText: 'TR' }).click();
  // Click 2: CP — queued in the row chain, not yet sent.
  await rowLoc.locator('button', { hasText: 'CP' }).click();

  // While both are pending, force a server-side change → SSE → the app's
  // coalesced REFRESH completes while the TR response is still in flight.
  await new Promise((res) => setTimeout(res, 50));
  const trig = await fetch(`${base}/api/patients/${MR}/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'visite', toggle: true }),
  });
  expect(trig.status).toBe(200);

  const r = await until(
    () => rowApi(base, MR),
    (x) => !!x.checklist.telaah_resep && !!x.checklist.catatan_pengobatan,
  );
  // The refresh brought the visite item too (the triggering write landed).
  expect(r.checklist.visite).toBeTruthy();
  expect(r.rev).toBeGreaterThanOrEqual(2);
  await expect(page.getByText(NO_CONFLICT)).toHaveCount(0);
});
