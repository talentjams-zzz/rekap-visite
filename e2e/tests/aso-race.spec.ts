// ASO guide: reload/write interleaving races around the medicine-name input.
//
// Race A — a reload (SSE/visibility/retry) carrying the pre-typing server
//   snapshot replaced the row while the user was typing, so the controlled
//   input visually regressed ("text deleted"). Fixed with per-row ASO DRAFTS
//   (monotonic generation) that every reload overlays onto the fetched rows;
//   a draft clears only when the save of ITS OWN generation succeeds.
//
// Race B — a late /api/rows response carrying an older row rev regressed the
//   write coordinator's rev cache → the next write self-409'd. Fixed with a
//   MONOTONIC reconcile: max(known, loaded), never a downgrade.
//
// All tests use controlled network delays (page.route) so the interleavings
// are deterministic, per the guide's test matrix.
import { test, expect } from '../helpers/fixture.js';
import type { Page, Route, APIResponse } from '@playwright/test';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { waitRows, rowFor, uploadFiles } from '../helpers/ui.js';
import { apiRows } from '../helpers/server.js';

const NO_CONFLICT = /changed on another device|Check failed|Save failed|ASO save failed|Archive failed/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function seed(page: Page, server: { base: string; dir: string }, day: string, mr: string) {
  const { base, dir } = server;
  await page.goto(base, { waitUntil: 'load' });
  const reg = buildRegistryFile(dir, 'nusin', day, [{ mr, nama: 'ASORACE', tglReg: '2026-10-12 08:00:00' }]);
  await uploadFiles(page, [reg]);
  await waitRows(base, 'active', (r) => r.some((x) => x.mr === mr));
  const row = rowFor(page, mr);
  await expect(row).toBeVisible();
  return row;
}

/** Force a server-side change (→ SSE → the app's coalesced reload). */
function serverChange(base: string, mr: string) {
  return fetch(`${base}/api/patients/${mr}/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'visite', toggle: true }),
  });
}

async function asoName(base: string, mr: string): Promise<string> {
  const rows = await apiRows(base, 'active');
  return (rows.find((x: any) => x.mr === mr)?.aso?.[0]?.name as string) ?? '';
}

async function untilName(base: string, mr: string, want: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if ((await asoName(base, mr)) === want) return;
    await sleep(250);
  }
  throw new Error(`ASO name never became "${want}" (last: "${await asoName(base, mr)}")`);
}

test('A: reload during typing — the input never regresses; focus + DOM survive; full name persists', async ({
  server,
  page,
}) => {
  const { base } = server;
  const MR = '780001';
  const row = await seed(page, server, '12-10-26', MR);

  const nameInput = row.locator("input[placeholder='Med name']");
  await row.locator('button', { hasText: '+ Add med' }).click();
  await nameInput.click();
  await page.keyboard.type('amoxi', { delay: 40 });
  // Mark the focused input so we can assert DOM continuity after the reload.
  await nameInput.evaluate((el) => {
    (el as HTMLElement & { __asoMarker?: string }).__asoMarker = 'yes';
  });

  // Before the 500 ms debounce saves anything, force a server change → SSE →
  // the app's reload returns a snapshot with NO med yet.
  const trig = await serverChange(base, MR);
  expect(trig.status).toBe(200);
  await page.waitForResponse((r) => r.url().includes('/api/rows') && r.request().method() === 'GET');

  // The core regression check: the med input is STILL THERE with the full
  // typed text (no fix: the row would render aso=[] → the input vanishes).
  await expect(nameInput).toHaveValue('amoxi');
  const focusOk = await nameInput.evaluate((el) => {
    const a = document.activeElement as HTMLElement | null;
    return a === el && (el as HTMLElement & { __asoMarker?: string }).__asoMarker === 'yes';
  });
  expect(focusOk).toBe(true); // same DOM node, focus never left the input

  // Continue typing the rest of the name.
  await page.keyboard.type('cillin', { delay: 40 });
  await untilName(base, MR, 'amoxicillin');
  await expect(nameInput).toHaveValue('amoxicillin');
  await expect(page.getByText(NO_CONFLICT)).toHaveCount(0);
});

test('B: delayed stale GET cannot regress the cached rev — the next write still succeeds', async ({
  server,
  page,
}) => {
  const { base } = server;
  const MR = '780002';
  const row = await seed(page, server, '13-10-26', MR);

  // One saved name first: the write coordinator's cached rev is > 0.
  await row.locator('button', { hasText: '+ Add med' }).click();
  await row.locator("input[placeholder='Med name']").fill('AMOX');
  await untilName(base, MR, 'AMOX');

  // Hold every /api/rows GET (fetch the response NOW, deliver it later).
  const held: { route: Route; res: APIResponse }[] = [];
  let holding = false;
  await page.route('**/api/rows*', async (route) => {
    if (route.request().method() !== 'GET' || !holding) return route.continue();
    const res = await route.fetch(); // server snapshot taken NOW
    held.push({ route, res });
  });
  const release = async (n: number) => {
    for (let i = 0; i < n && held.length > 0; i++) {
      const { route, res } = held.shift()!;
      await route.fulfill({ status: res.status(), headers: res.headers(), body: (await res.body()) as Buffer });
    }
  };

  try {
    // Start the app's reload while the row is still at the saved rev; its
    // GET (the stale snapshot) gets held.
    holding = true;
    const trig = await serverChange(base, MR);
    expect(trig.status).toBe(200);
    // Wait until the stale GET is actually captured.
    for (let i = 0; i < 60 && held.length < 1; i++) await sleep(50);
    expect(held.length).toBeGreaterThanOrEqual(1);

    // A new ASO edit completes (server + client rev advance past the held
    // snapshot).
    await row.locator("input[placeholder='Med name']").fill('AMOXIL');
    await untilName(base, MR, 'AMOXIL');

    // Release the STALE response now: it installs rows with the OLD rev.
    // (Monotonic reconcile keeps the higher cached rev; the old code
    // regressed it — and the next write would self-409.)
    await release(1);

    // The NEXT write must go out with the non-regressed rev and succeed.
    await row.locator("input[placeholder='Med name']").fill('AMOXILLIN');
    const patch = page.waitForResponse(
      (r) => r.url().includes(`/api/rows/${MR}_nusin`) && r.request().method() === 'PATCH',
    );
    await row.locator("input[placeholder='Med name']").press('Control+Enter');
    const pr = await patch;
    expect(pr.status()).toBe(200); // not a self-inflicted 409
    await untilName(base, MR, 'AMOXILLIN');
    await expect(page.getByText(NO_CONFLICT)).toHaveCount(0);
  } finally {
    holding = false;
    await release(10); // drain anything still held so the page is unblocked
  }
});

test('C: edit while the first save is in flight — the newer draft survives the older save\'s acknowledgement', async ({
  server,
  page,
}) => {
  const { base } = server;
  const MR = '780003';
  const row = await seed(page, server, '14-10-26', MR);

  // Hold the FIRST ASO PATCH (server commits it; the client learns
  // "success" only when we fulfill) and hold the SSE reload GETs so the
  // stale server snapshot installs at exactly the moment we choose.
  const heldPatch: { route: Route; res: APIResponse }[] = [];
  const heldGet: { route: Route; res: APIResponse }[] = [];
  let holdFirstPatch = true;
  let holdGets = false;
  // Note: glob `*` does not cross `/` — use exact endpoint paths.
  await page.route(`**/api/rows/${MR}_nusin/aso`, async (route) => {
    if (route.request().method() === 'PATCH' && holdFirstPatch) {
      const res = await route.fetch();
      heldPatch.push({ route, res });
      return;
    }
    route.continue();
  });
  await page.route('**/api/rows*', async (route) => {
    if (route.request().method() === 'GET' && holdGets) {
      const res = await route.fetch();
      heldGet.push({ route, res });
      return;
    }
    route.continue();
  });
  const fulfill = async (h: { route: Route; res: APIResponse }) => {
    await h.route.fulfill({ status: h.res.status(), headers: h.res.headers(), body: (await h.res.body()) as Buffer });
  };

  try {
    const nameInput = row.locator("input[placeholder='Med name']");
    await row.locator('button', { hasText: '+ Add med' }).click();
    await nameInput.click();
    await page.keyboard.type('amoxi', { delay: 40 });
    // From now on, reload GETs are held, so the SSE reload triggered by
    // PATCH #1's server commit installs its (stale) snapshot on demand.
    holdGets = true;

    // Let the debounce fire: PATCH #1 is held client-side, the server has
    // committed 'amoxi', and the SSE reload GET is captured (stale).
    for (let i = 0; i < 80 && (heldPatch.length < 1 || heldGet.length < 1); i++) await sleep(50);
    expect(heldPatch.length).toBe(1);
    expect(heldGet.length).toBeGreaterThanOrEqual(1);

    // Type the rest while PATCH #1's success is still withheld.
    await page.keyboard.type('cillin', { delay: 40 });

    // Acknowledge the OLDER save (gen-1 ack while a gen-3 draft is live) —
    // the draft must survive. Un-holding lets the newer save proceed.
    await fulfill(heldPatch.shift()!);
    holdFirstPatch = false;

    // Now install the stale snapshot: the input must keep the FULLER local
    // text (draft overlay), not regress to the older 'amoxi'.
    holdGets = false;
    while (heldGet.length > 0) await fulfill(heldGet.shift()!);
    await expect(nameInput).toHaveValue('amoxicillin'); // NOT 'amoxi'

    // The newer draft saves on its own and is the final value.
    await untilName(base, MR, 'amoxicillin');
    await expect(nameInput).toHaveValue('amoxicillin');
    await expect(page.getByText(NO_CONFLICT)).toHaveCount(0);
  } finally {
    holdFirstPatch = false;
    holdGets = false;
    for (const h of heldPatch.splice(0)) await fulfill(h);
    for (const h of heldGet.splice(0)) await fulfill(h);
  }
});

// Real external conflict (guide Test 4): a change landing OUTSIDE this
// client between load and write must still produce the conflict behavior —
// the stale write is rejected and must not silently overwrite the newer
// value. (Equivalent to the two-page scenario: the direct API call plays
// "the other device".)
test('D: genuine cross-device change still 409s and does not overwrite the newer value', async ({
  server,
  page,
}) => {
  const { base } = server;
  const MR = '780004';
  const row = await seed(page, server, '15-10-26', MR);

  // "The other device" writes first (this page's cached rev is now stale).
  const other = await fetch(`${base}/api/rows/${MR}_nusin/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'telaah_resep', toggle: true }),
  });
  expect(other.status).toBe(200);

  // The page — still showing the pre-change row — clicks the same chip
  // immediately (before its SSE reload settles). Its write carries the
  // stale rev → genuine 409.
  await row.locator('button', { hasText: 'TR' }).click();
  await expect(page.getByText(/changed on another device/)).toHaveCount(1);

  // The newer value was NOT overwritten: the chip stays set (the page's
  // rejected toggle must not have un-set it), and the page reloaded to the
  // server truth.
  const rows = await apiRows(base, 'active');
  const r = rows.find((x: any) => x.mr === MR);
  expect(r.checklist.telaah_resep).toBeTruthy();
});
