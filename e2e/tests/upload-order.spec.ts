// Review: registry chunk-ordering concern. When ONE request carries two files
// for the same MR (same day), the winner must be well-defined and
// reproducible: the LAST file in request order (multipart order = the order
// the client batched them). This pins the established behavior — server
// upload timestamps are shared across a batch, so file order (not mtime) is
// the only ordering signal.
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Two different files, SAME name+day (only content differs) → build in
// separate temp dirs since buildRegistryFile names by facility+date.
function twoFiles() {
  const dA = mkdtempSync(path.join(tmpdir(), 'rekap-ord-a-'));
  const dB = mkdtempSync(path.join(tmpdir(), 'rekap-ord-b-'));
  const a = buildRegistryFile(dA, 'nusin', '05-09-26', [
    { mr: '550100', nama: 'FIRST', tglReg: '2026-09-05 08:00:00' },
  ]);
  const b = buildRegistryFile(dB, 'nusin', '05-09-26', [
    { mr: '550100', nama: 'SECOND', tglReg: '2026-09-05 09:30:00' },
  ]);
  return { a, b, cleanup: () => { rmSync(dA, { recursive: true, force: true }); rmSync(dB, { recursive: true, force: true }); } };
}

async function uploadOrder(base: string, first: string, second: string) {
  const fd = new FormData();
  fd.append('files', new Blob([readFileSync(first)]), 'nusin-05-09-26.xlsx');
  fd.append('files', new Blob([readFileSync(second)]), 'nusin-05-09-26.xlsx');
  const r = await fetch(`${base}/api/uploads`, { method: 'POST', body: fd });
  expect(r.ok).toBe(true);
  const rows = (await fetch(`${base}/api/rows?status=active`).then((x) => x.json())) as any[];
  return rows.find((x) => x.mr === '550100');
}

test('same-MR batch: the LAST file in request order wins', async ({ server }) => {
  const { base } = server;
  const f = twoFiles();
  try {
    const row = await uploadOrder(base, f.a, f.b);
    expect(row.nama).toBe('SECOND');
    expect(row.tglRegistrasi).toBe('2026-09-05 09:30:00');
  } finally {
    f.cleanup();
  }
});

test('same-MR batch: reversed request order wins in reverse (order, not mtime)', async ({
  server,
}) => {
  const { base } = server;
  const f = twoFiles();
  try {
    const row = await uploadOrder(base, f.b, f.a);
    expect(row.nama).toBe('FIRST');
    expect(row.tglRegistrasi).toBe('2026-09-05 08:00:00');
  } finally {
    f.cleanup();
  }
});
