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

// Review scope note: broader ordering sign-off requires tests spanning the
// 5-file client chunk boundary AND mixed report dates.

import { uploadFiles } from '../helpers/ui.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('cross-chunk ordering: the later chunk wins for a same-MR file spanning the 5-file boundary', async ({
  server,
  page,
}) => {
  const { base } = server;
  // Same-day same-name files overwrite each other per directory → one dir
  // per file.
  const dirs = Array.from({ length: 6 }, (_, i) =>
    mkdtempSync(path.join(tmpdir(), `rekap-xc-${i}-`)),
  );
  try {
    // Six same-day files (five unique MRs). MR 550105 appears in file #3
    // (FIRST, chunk 1) and file #6 (SECOND, chunk 2). Same report day for
    // every file → with identical inputTimestamps the only ordering signal
    // is request order, and the client sends chunk 1 fully before chunk 2 —
    // so SECOND must win. (Side effect of the v1 archive sync: the last
    // chunk is a single-file batch, so the other MRs — absent from that
    // report — are ARCHIVED, not lost; asserted below.)
    const f1 = buildRegistryFile(dirs[0], 'nusin', '03-09-26', [{ mr: '550101', nama: 'A1', tglReg: '2026-09-03 08:00:00' }]);
    const f2 = buildRegistryFile(dirs[1], 'nusin', '03-09-26', [{ mr: '550102', nama: 'A2', tglReg: '2026-09-03 08:05:00' }]);
    const f3 = buildRegistryFile(dirs[2], 'nusin', '03-09-26', [{ mr: '550105', nama: 'FIRST', tglReg: '2026-09-03 08:10:00' }]);
    const f4 = buildRegistryFile(dirs[3], 'nusin', '03-09-26', [{ mr: '550106', nama: 'A3', tglReg: '2026-09-03 08:15:00' }]);
    const f5 = buildRegistryFile(dirs[4], 'nusin', '03-09-26', [{ mr: '550107', nama: 'A4', tglReg: '2026-09-03 08:20:00' }]);
    const f6 = buildRegistryFile(dirs[5], 'nusin', '03-09-26', [{ mr: '550105', nama: 'SECOND', tglReg: '2026-09-03 08:10:00' }]);

    await page.goto(base, { waitUntil: 'load' });
    // Two SEPARATE uploads (two input events) with a pause between: batch
    // 1 lands 5 MRs (input timestamp T1); batch 2 — arriving a whole second
    // later (T2 > T1) — is the "latest input" for the facility, so its
    // single MR stays active and the other four are archive-synced out. This
    // also spans the client's 5-file chunk boundary (5 + 1).
    await uploadFiles(page, [f1, f2, f3, f4, f5]);
    await sleep(1500);
    await uploadFiles(page, [f6]);

    // Wait for the second upload to land: 550105 active as SECOND.
    for (let i = 0; i < 80; i++) {
      const rows = (await fetch(`${base}/api/rows?status=active`).then((x) => x.json())) as any[];
      const target = rows.find((x) => x.mr === '550105');
      if (target?.nama === 'SECOND') break;
      await sleep(250);
    }
    const active = (await fetch(`${base}/api/rows?status=active`).then((x) => x.json())) as any[];
    const archived = (await fetch(`${base}/api/rows?status=archived`).then((x) => x.json())) as any[];
    console.log(
      'STATE active=', JSON.stringify(active.map((x) => `${x.mr}:${x.nama}`)),
      'archived=', JSON.stringify(archived.map((x) => `${x.mr}:${x.nama}`)),
    );
    const target = active.find((x) => x.mr === '550105');
    expect(target.nama).toBe('SECOND'); // later upload (request 2) wins
    // The other MRs were moved to Archived by the archive sync of the
    // later (newer input timestamp) upload — present, not destroyed. And
    // there is exactly ONE row per MR (no duplicates).
    expect(active.map((x) => x.mr)).toEqual(['550105']);
    expect(archived.map((x) => x.mr).sort()).toEqual(['550101', '550102', '550106', '550107']);
    expect([...active, ...archived].length).toBe(5);
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});

test('mixed report dates in one request: the LATER day wins, the earlier episode is snapshotted (not lost)', async ({
  server,
}) => {
  const { base } = server;
  const dA = mkdtempSync(path.join(tmpdir(), 'rekap-md-a-'));
  const dB = mkdtempSync(path.join(tmpdir(), 'rekap-md-b-'));
  try {
    const day05 = buildRegistryFile(dA, 'nusin', '05-09-26', [
      { mr: '550200', nama: 'DAY05', tglReg: '2026-09-05 08:00:00' },
    ]);
    const day03 = buildRegistryFile(dB, 'nusin', '03-09-26', [
      { mr: '550200', nama: 'DAY03', tglReg: '2026-09-03 08:00:00' },
    ]);
    // Files are processed in REPORT-DATE order (inputTimestamp), not request
    // order: the later day (09-05) wins the current fields regardless of
    // which file came first in the request. The changed Tgl Reg (09-03 →
    // 09-05) is a new treatment episode → the earlier day is SNAPSHOTTED
    // into riwayat (readmission), not discarded.
    const fd = new FormData();
    fd.append('files', new Blob([readFileSync(day05)]), 'nusin-05-09-26.xlsx');
    fd.append('files', new Blob([readFileSync(day03)]), 'nusin-03-09-26.xlsx');
    const r = await fetch(`${base}/api/uploads`, { method: 'POST', body: fd });
    expect(r.ok).toBe(true);
    const body = (await r.json()) as { readmissions: number };
    expect(body.readmissions).toBe(1); // the earlier day was snapshotted
    const row = (await fetch(`${base}/api/rows?status=active`).then((x) => x.json())) as any[];
    const target = row.find((x) => x.mr === '550200');
    expect(target).toBeTruthy(); // not rolled back, not archived
    expect(target.nama).toBe('DAY05');
    expect(target.dateAdded).toBe('2026-09-05'); // later day wins
    expect(target.tglRegistrasi).toBe('2026-09-05 08:00:00');
  } finally {
    rmSync(dA, { recursive: true, force: true });
    rmSync(dB, { recursive: true, force: true });
  }
});
