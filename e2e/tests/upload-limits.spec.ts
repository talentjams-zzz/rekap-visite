// v2.1 upload boundaries (lab-data loading guide, Phase 15):
//  - one request with 21 lab files → structured FILE_COUNT_LIMIT + rollback
//  - one request with 10 files → fine
//  - 25 files through the UI → sequential 5+5+5+5+5 chunks, all loaded
//  - exact duplicate re-upload → no-op (no rewrite, no write-back, no SSE)
//  - mixed valid + corrupt file → per-file failed[], valid still loads
//  - /api/rows no longer carries (or parses) tests_json — summary only
import { test, expect } from '../helpers/fixture.js';
import { buildLabFile, buildRegistryFile } from '../helpers/xlsx.js';
import { apiRows } from '../helpers/server.js';
import { uploadFiles, waitRows } from '../helpers/ui.js';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SECTIONS = [
  {
    jenis: 'Darah',
    tests: [
      { nama: 'Hb', hasil: '12', normal: '12 - 16', tanggal: '2026-01-01' },
      { nama: 'PLT', hasil: '30', normal: '150 - 450', tanggal: '2026-01-01', keterangan: 'Dilaporkan' },
    ],
  },
];

async function health(base: string) {
  return (await fetch(`${base}/api/health`).then((r) => r.json())) as {
    db: { labs: number };
    writeback: { writes: number };
  };
}

test('21 lab files in ONE request → structured FILE_COUNT_LIMIT, chunk rolled back', async ({
  server,
}) => {
  const { base, dir } = server;
  const files: string[] = [];
  for (let i = 0; i < 21; i++) files.push(buildLabFile(dir, `9000${i}`, SECTIONS));
  const fd = new FormData();
  for (const f of files) fd.append('files', new Blob([readFileSync(f)]), path.basename(f));
  const r = await fetch(`${base}/api/uploads/lab`, { method: 'POST', body: fd });
  expect([400, 413]).toContain(r.status);
  const body = (await r.json()) as { ok: boolean; code: string; message: string; limit?: number };
  expect(body.ok).toBe(false);
  expect(body.code).toBe('FILE_COUNT_LIMIT');
  expect(body.limit).toBe(20);
  expect(body.message).toMatch(/maximum 20 files/);
  // Atomic chunk: the 20 files processed before the limit hit did NOT land.
  expect((await health(base)).db.labs).toBe(0);
});

test('10 lab files in one request → all loaded', async ({ server }) => {
  const { base, dir } = server;
  const files: string[] = [];
  for (let i = 0; i < 10; i++) files.push(buildLabFile(dir, `9100${i}`, SECTIONS));
  const fd = new FormData();
  for (const f of files) fd.append('files', new Blob([readFileSync(f)]), path.basename(f));
  const r = await fetch(`${base}/api/uploads/lab`, { method: 'POST', body: fd });
  expect(r.ok).toBe(true);
  const body = (await r.json()) as { loaded: number; skipped: string[] };
  expect(body.loaded).toBe(10);
  expect(body.skipped).toEqual([]);
  expect((await health(base)).db.labs).toBe(10);
});

test('25 lab files through the UI → sequential 5-file chunks, all loaded', async ({
  server,
  page,
}) => {
  const { base, dir } = server;
  await page.goto(base, { waitUntil: 'load' });
  const files: string[] = [];
  for (let i = 0; i < 25; i++) files.push(buildLabFile(dir, `9200${i}`, SECTIONS));
  await uploadFiles(page, files, '#lab-input');
  // Final aggregate toast (5 batches of 5).
  await expect(page.getByText(/Lab files: 25 loaded/)).toBeVisible({ timeout: 60000 });
  expect((await health(base)).db.labs).toBe(25);
});

test('exact duplicate lab re-upload → no-op: no rewrite, no write-back', async ({
  server,
}) => {
  const { base, dir } = server;
  const f = buildLabFile(dir, '9300', SECTIONS);
  const fd = new FormData();
  fd.append('files', new Blob([readFileSync(f)]), path.basename(f));

  const r1 = await fetch(`${base}/api/uploads/lab`, { method: 'POST', body: fd });
  const j1 = (await r1.json()) as { loaded: number };
  expect(j1.loaded).toBe(1);

  const before = await health(base);
  const labBefore = (await fetch(`${base}/api/patients/9300/lab`).then((r) => r.json())) as {
    loadedAt: string;
  };

  const fd2 = new FormData();
  fd2.append('files', new Blob([readFileSync(f)]), path.basename(f));
  const r2 = await fetch(`${base}/api/uploads/lab`, { method: 'POST', body: fd2 });
  const j2 = (await r2.json()) as { loaded: number; duplicates: string[] };
  expect(j2.loaded).toBe(0);
  expect(j2.duplicates).toEqual(['lab-9300.xlsx']);

  // No write-back ran (writeback counter unchanged) and the report is untouched.
  const after = await health(base);
  expect(after.writeback.writes).toBe(before.writeback.writes);
  const labAfter = (await fetch(`${base}/api/patients/9300/lab`).then((r) => r.json())) as {
    loadedAt: string;
  };
  expect(labAfter.loadedAt).toBe(labBefore.loadedAt);
});

test('mixed valid + corrupt lab files → per-file failed[], valid still loads', async ({
  server,
}) => {
  const { base, dir } = server;
  const good = buildLabFile(dir, '9400', SECTIONS);
  const bad = path.join(os.tmpdir(), 'lab-9401.xlsx');
  // Truncated ZIP bytes (an xlsx IS a zip): sheetjs THROWS on these →
  // INVALID_XLSX for that file only. (Plain text would parse as a CSV-ish
  // workbook and be a "no lab sheet" skip, which is the other test path.)
  writeFileSync(
    bad,
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('truncatedzipgarbage')]),
  );
  const fd = new FormData();
  fd.append('files', new Blob([readFileSync(good)]), 'lab-9400.xlsx');
  fd.append('files', new Blob([readFileSync(bad)]), 'lab-9401.xlsx');
  const r = await fetch(`${base}/api/uploads/lab`, { method: 'POST', body: fd });
  const j = (await r.json()) as {
    loaded: number;
    failed: { filename: string; code: string }[];
  };
  expect(j.loaded).toBe(1);
  expect(j.failed).toHaveLength(1);
  expect(j.failed[0].code).toBe('INVALID_XLSX');
  expect(j.failed[0].filename).toBe('lab-9401.xlsx');
});

test('/api/rows serves lab summaries without the tests_json blob', async ({
  server,
  page,
}) => {
  const { base, dir } = server;
  await page.goto(base, { waitUntil: 'load' });
  // An ACTIVE patient whose lab contains a distinctive test name.
  const reg = buildRegistryFile(dir, 'nusin', '01-01-26', [{ mr: '9500', nama: 'SUMMAR', tglReg: '2026-01-01 08:00:00' }]);
  await uploadFiles(page, [reg]);
  await waitRows(base, 'active', (r) => r.some((x) => x.mr === '9500'));
  const lab = buildLabFile(dir, '9500', [
    {
      jenis: 'Zebra',
      tests: [
        { nama: 'ZEBRA_TEST_A', hasil: '1', normal: '2 - 3', tanggal: '2026-01-02' },
        { nama: 'ZEBRA_TEST_B', hasil: '9', normal: '1 - 5', tanggal: '2026-01-02', keterangan: 'Dilaporkan' },
      ],
    },
  ]);
  const fd = new FormData();
  fd.append('files', new Blob([readFileSync(lab)]), 'lab-9500.xlsx');
  const r = await fetch(`${base}/api/uploads/lab`, { method: 'POST', body: fd });
  const jLab = (await r.json()) as { loaded: number };
  expect(jLab.loaded).toBe(1);

  const rows = await apiRows(base, 'active');
  const row = rows.find((x: any) => x.mr === '9500');
  expect(row.lab.testCount).toBe(2);
  // '1' vs '2 - 3' → abnormal; '9' vs '1 - 5' + Dilaporkan → abnormal + critical
  expect(row.lab.abnormal).toBe(2);
  expect(row.lab.kritis).toBe(1);
  // The list payload must NOT contain the raw report (no tests_json parse).
  expect(JSON.stringify(row)).not.toContain('ZEBRA_TEST');
  // The full report is still available on the dedicated endpoint.
  const full = (await fetch(`${base}/api/patients/9500/lab`).then((x) => x.json())) as {
    tests: { nama: string }[];
  };
  expect(full.tests.map((t) => t.nama)).toContain('ZEBRA_TEST_A');
});
