// Handover (operan) file contract — Nusin only:
// ONLY Diagnosis/Operan/Terapi come from the operan file; every other field
// (nama, dokter, kamar, bed, tgl reg) stays as the REGISTRY (facility data)
// wrote it. The operan sheet is hand-typed and carries inconsistent variants
// (the classic bug: "dr Putri SpB" clobbering the registry's "dr. Putri, Sp.B").
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile, buildHandoverFile } from '../helpers/xlsx.js';
import { apiRows } from '../helpers/server.js';
import { uploadFiles, waitRows } from '../helpers/ui.js';

test('operan file only supplies Diagnosis/Operan/Terapi; registry keeps the doctor name', async ({
  server,
  page,
}) => {
  const { base, dir } = server;
  const MR = '300001';

  await page.goto(base, { waitUntil: 'load' });
  const reg = buildRegistryFile(dir, 'nusin', '26-08-26', [
    { mr: MR, nama: 'REG PATIENT', tglReg: '2026-08-26 08:00:00', dokter: 'dr. Putri, Sp.B' },
  ]);
  await uploadFiles(page, [reg]);
  await waitRows(base, 'active', (r) => r.length === 1);

  // Operan sheet: same MR, hand-typed variants + the day's D/O/T.
  const ho = buildHandoverFile(dir, 'nusin', '26-08-26', [
    {
      mr: MR,
      nama: 'REG PATIENT BY NY',
      dokter: 'dr Putri SpB', // variant typing — must NOT win
      diagnosis: 'Pneumonia',
      operan: 'Observasi ketat',
      terapi: 'Ceftriaxone 2x1',
    },
  ]);
  await uploadFiles(page, [ho]);

  const row = (await apiRows(base)).find((r) => r.mr === MR)!;
  // D/O/T from the operan file…
  expect(row.diagnosis).toBe('Pneumonia');
  expect(row.operan).toBe('Observasi ketat');
  expect(row.terapi).toBe('Ceftriaxone 2x1');
  // …identity fields untouched — still the registry's canonical values.
  expect(row.dokter).toBe('dr. Putri, Sp.B');
  expect(row.nama).toBe('REG PATIENT');
  // Row stays active (handover is a subset; registry owns the active list).
  expect(row.archived).toBe(false);
});
