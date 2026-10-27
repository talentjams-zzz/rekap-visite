// v1 fallback guarantee (P10): after v2 changes, master_data.json is
// re-serialized in v1's exact format — the frozen v1 server loads it,
// serves it, and preserves legacy fields (telaahLog) and UI state.
//
// Uses its OWN scratch server (seeded before startup, since the fixture
// server migrates an empty default seed) plus the REAL v1 server.js.
import { test, expect } from '@playwright/test';
import { startScratchServer, apiRows, waitWriteback } from '../helpers/server.js';
import { startV1 } from '../helpers/v1.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { uploadFiles, waitRows } from '../helpers/ui.js';
import { readFileSync } from 'node:fs';

const V1_SEED = {
  savedAt: '2026-09-19T05:21:13.000Z',
  version: 7,
  rows: [
    {
      id: '2001_nusin', mr: '2001', facility: 'nusin', dateAdded: '2026-09-19',
      tglRegistrasi: '2026-09-19 08:00:00', nama: 'SEED', umur: '1', kamar: '1', bed: '1',
      dokter: 'dr S', diagnosis: 'SD', operan: 'SO', terapi: 'ST',
      checklist: { telaah_resep: null, catatan_pengobatan: null, pio: null },
      pharmacistNote: '', archived: false, archivedAt: null,
      telaahLog: [{ date: '2026-09-18', ts: '2026-09-18 10:00:00' }],
      catatanLog: [], pioLog: [], history: [], lastSeen: '2026-09-19 08:00:00',
    },
  ],
  patientChecklist: {},
  labResults: {},
  facilityLatestInput: {},
  colWidths: { 0: 111 },
  labColWidths: {},
};

test('v2 changes round-trip through the real v1 server (fallback guarantee)', async ({ page }) => {
  const server = await startScratchServer(V1_SEED);
  try {
    const { base, dir } = server;
    const file = `${dir}/master.json`;

    await page.goto(base, { waitUntil: 'load' });
    // Startup migration ingested the seed.
    await waitRows(base, 'active', (r) => r.length === 1);
    const seed = (await apiRows(base))[0];
    expect(seed.mr).toBe('2001');

    // v2 upload (new day, only 2002) → 2002 active, 2001 auto-archived,
    // file re-serialized.
    const f = buildRegistryFile(dir, 'nusin', '20-09-26', [
      { mr: '2002', nama: 'NEWPAT', tglReg: '2026-09-20 08:00:00' },
    ]);
    await uploadFiles(page, [f]);
    await waitRows(base, 'active', (r) => r.length === 1 && r[0].mr === '2002');
    await waitRows(base, 'archived', (r) => r.length === 1 && r[0].mr === '2001');
    // v2.1: the v1 file export is a coalesced background job — wait for it.
    await waitWriteback(base, 1);

    let out = JSON.parse(readFileSync(file, 'utf8'));
    expect(out.version).toBe(8);
    expect(out.rows.map((r: any) => r.mr).sort()).toEqual(['2001', '2002']);
    // legacy per-day archive + UI state carried through
    expect(out.rows.find((r: any) => r.mr === '2001').telaahLog).toEqual([
      { date: '2026-09-18', ts: '2026-09-18 10:00:00' },
    ]);
    expect(out.colWidths).toEqual({ 0: 111 });

    // v2 checklist change on the (now archived) seed row → file updated,
    // version bumped again.
    const archivedSeed = (await apiRows(base, 'archived'))[0];
    const r = await fetch(`${base}/api/rows/${archivedSeed.id}/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'telaah_resep', value: '2026-09-20 09:00:00', rev: archivedSeed.rev }),
    });
    expect(r.status).toBe(200);
    await waitWriteback(base, 2);
    out = JSON.parse(readFileSync(file, 'utf8'));
    expect(out.version).toBe(9);
    expect(out.rows.find((x: any) => x.mr === '2001').checklist.telaah_resep).toBe('2026-09-20 09:00:00');

    // The REAL v1 server loads and serves the v2-written file.
    const v1 = await startV1(file);
    try {
      const m = (await (await fetch(`http://127.0.0.1:${v1.port}/api/master`)).json()) as any;
      expect(m.version).toBe(9);
      expect(m.data.rows).toHaveLength(2);
      expect(m.data.rows.find((x: any) => x.mr === '2001').telaahLog).toHaveLength(1);
      expect(m.data.rows.find((x: any) => x.mr === '2002').nama).toBe('NEWPAT');
      expect(m.data.colWidths).toEqual({ 0: 111 });
    } finally {
      await v1.close();
    }
  } finally {
    await server.close();
  }
});
