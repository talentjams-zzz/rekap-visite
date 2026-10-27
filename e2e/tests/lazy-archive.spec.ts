// v2.1 lazy archived loading: the initial page must NOT transfer the
// (larger) archived list — only active rows + a tiny count. The archived
// list loads once, when the Archived tab is first opened.
import { test, expect, type Page } from '@playwright/test';
import { startScratchServer } from '../helpers/server.js';

const SEED = {
  savedAt: '2026-09-19T05:21:13.000Z',
  version: 3,
  rows: [
    {
      id: '3001_nusin', mr: '3001', facility: 'nusin', dateAdded: '2026-09-19',
      tglRegistrasi: '2026-09-19 08:00:00', nama: 'ACTIVEONE', umur: '1', kamar: '1', bed: '1',
      dokter: 'dr S', diagnosis: '', operan: '', terapi: '',
      checklist: { telaah_resep: null, catatan_pengobatan: null, pio: null },
      pharmacistNote: '', archived: false, archivedAt: null,
      history: [], lastSeen: '2026-09-19 08:00:00',
    },
    {
      id: '3002_melati', mr: '3002', facility: 'melati', dateAdded: '2026-09-15',
      tglRegistrasi: '2026-09-15 08:00:00', nama: 'ARCHIVEONE', umur: '2', kamar: '2', bed: '2',
      dokter: 'dr S', diagnosis: '', operan: '', terapi: '',
      checklist: { telaah_resep: null, catatan_pengobatan: null, pio: null },
      pharmacistNote: '', archived: true, archivedAt: '2026-09-18 09:00:00',
      history: [], lastSeen: '2026-09-18 09:00:00',
    },
  ],
  patientChecklist: {},
  labResults: {},
  facilityLatestInput: {},
  colWidths: {},
  labColWidths: {},
};

test('archived list is lazy: no transfer on load, fetched on tab open', async ({ page }: { page: Page }) => {
  const server = await startScratchServer(SEED);
  try {
    let archivedRequests = 0;
    let countsRequests = 0;
    await page.route('**/api/rows**', async (route) => {
      if (route.request().url().includes('status=archived')) archivedRequests++;
      await route.continue();
    });
    await page.route('**/api/counts', async (route) => {
      countsRequests++;
      await route.continue();
    });

    await page.goto(server.base, { waitUntil: 'load' });

    // Initial load: active rows render, count endpoint used, NO archived
    // list transfer. Give it a beat to catch any late request.
    await expect(page.getByText('ACTIVEONE')).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(700);
    expect(countsRequests).toBeGreaterThanOrEqual(1);
    expect(archivedRequests).toBe(0);
    // The badge shows the server-side archived count without the list.
    await expect(page.getByRole('button', { name: /Archived \(1\)/ })).toBeVisible();

    // Opening the Archived tab triggers exactly the lazy fetch.
    await page.getByRole('button', { name: /Archived/ }).click();
    await expect(page.getByText('ARCHIVEONE')).toBeVisible({ timeout: 15000 });
    expect(archivedRequests).toBe(1);
  } finally {
    await server.close();
  }
});
