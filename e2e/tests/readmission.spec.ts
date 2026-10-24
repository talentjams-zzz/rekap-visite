// Readmission (v2 feature): a patient who returns with a NEW registration
// date starts a fresh treatment episode — current D/O/T, note, ASO and the
// patient-level checklist are cleared, while the old episode's final state
// is preserved in riwayat. A return with the SAME reg date (missing-file
// artifact) must NOT reset anything.
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { apiRows } from '../helpers/server.js';
import { waitRows, uploadFiles } from '../helpers/ui.js';

const MR = '660101';
const TS = '2026-09-01 10:00:00';

async function patch(base: string, id: string, body: Record<string, unknown>) {
  const r = await fetch(`${base}/api/rows/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${id}: HTTP ${r.status}`);
  return (await r.json()) as { rev?: number };
}

test('readmission: new reg date clears current treatment; same reg date does not', async ({
  server,
  page,
}) => {
  const { base, dir } = server;
  await page.goto(base, { waitUntil: 'load' });

  // Episode 1, day 1 (reg date 2026-09-01).
  await uploadFiles(page, [
    buildRegistryFile(dir, 'nusin', '01-09-26', [{ mr: MR, nama: 'RICO', tglReg: '2026-09-01 08:00:00' }]),
  ]);
  await waitRows(base, 'active', (r) => r.some((x) => x.mr === MR));
  let row = (await apiRows(base, 'active')).find((x) => x.mr === MR);

  // Pharmacist work during episode 1: D/O/T, note, ASO med, patient item.
  let rev = (await patch(base, row.id, { diagnosis: 'D old', operan: 'O old', terapi: 'T old', note: 'N old', rev: row.rev })).rev;
  {
    const r = await fetch(`${base}/api/rows/${encodeURIComponent(row.id)}/aso`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aso: [{ id: 'm1', name: 'ketorolac', stopDate: '2026-09-05', stopped: false, stoppedAt: null }], rev }),
    });
    expect(r.ok).toBe(true);
    rev = (await r.json()).rev;
  }
  {
    const r = await fetch(`${base}/api/patients/${encodeURIComponent(MR)}/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'visite', value: TS }),
    });
    expect(r.ok).toBe(true);
  }

  // Episode 1, day 2 — same reg date. Ordinary next-day update.
  await uploadFiles(page, [
    buildRegistryFile(dir, 'nusin', '02-09-26', [{ mr: MR, nama: 'RICO', tglReg: '2026-09-01 08:00:00' }]),
  ]);
  await waitRows(base, 'active', (r) => r.some((x) => x.mr === MR && x.dateAdded === '2026-09-02'));
  row = (await apiRows(base, 'active')).find((x) => x.mr === MR);
  expect(row.diagnosis).toBe('D old'); // continuing stay keeps current treatment
  expect(row.pharmacistNote).toBe('N old');

  // READMISSION, day 3 — NEW reg date (2026-09-10).
  await uploadFiles(page, [
    buildRegistryFile(dir, 'nusin', '10-09-26', [{ mr: MR, nama: 'RICO', tglReg: '2026-09-10 09:00:00' }]),
  ]);
  await waitRows(base, 'active', (r) => r.some((x) => x.mr === MR && x.dateAdded === '2026-09-10'));
  row = (await apiRows(base, 'active')).find((x) => x.mr === MR);

  // Current treatment is fresh.
  expect(row.diagnosis ?? '').toBe('');
  expect(row.operan ?? '').toBe('');
  expect(row.terapi ?? '').toBe('');
  expect(row.pharmacistNote ?? '').toBe('');
  expect(row.aso ?? []).toEqual([]);
  expect(row.tglRegistrasi?.slice(0, 10)).toBe('2026-09-10');

  // The patient-level checklist is cleared for the new episode.
  expect(row.checklist?.visite).toBeNull();

  // The old episode's final state (day 2 = episode end) is preserved in
  // riwayat: treatment + note + the patient item tick.
  const h = await fetch(`${base}/api/rows/${encodeURIComponent(row.id)}/history`).then((r) => r.json());
  const day2 = h.find((d: any) => d.date === '2026-09-02');
  expect(day2).toBeTruthy();
  expect(day2.diagnosis).toBe('D old');
  expect(day2.operan).toBe('O old');
  expect(day2.note).toBe('N old');
  expect(day2.visite).toBe(TS);
});
