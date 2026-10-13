// Scratch v2 server per spec file: isolated master JSON + DB + port.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface Scratch {
  base: string;
  port: number;
  dir: string;
  close(): Promise<void>;
}

let nextPort = 8810;

export async function startScratchServer(): Promise<Scratch> {
  const port = nextPort++;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rekap-e2e-'));
  writeFileSync(
    path.join(dir, 'master.json'),
    JSON.stringify({
      savedAt: '2026-01-01T00:00:00.000Z',
      rows: [],
      patientChecklist: {},
      labResults: {},
      facilityLatestInput: {},
      version: 1,
    }),
  );
  const child: ChildProcess = spawn('node', [path.join(ROOT, 'server/dist/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      REKAP_MASTER: path.join(dir, 'master.json'),
      REKAP_DB: path.join(dir, 'rekap.db'),
      REKAP_POLL_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr += String(d)));
  const deadline = Date.now() + 15000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${stderr.slice(0, 800)}`);
    try {
      const r = await fetch(`http://localhost:${port}/api/health`);
      if (r.ok) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) {
    child.kill();
    throw new Error(`server did not open port ${port} in time:\n${stderr.slice(0, 800)}`);
  }
  return {
    base: `http://localhost:${port}`,
    port,
    dir,
    close: async () => {
      child.kill();
      await new Promise((r) => setTimeout(r, 200));
      if (child.exitCode === null) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Node-side API helpers (more robust than DOM scraping for assertions). */
export async function apiRows(base: string, status: 'active' | 'archived' = 'active') {
  const r = await fetch(`${base}/api/rows?status=${status}`);
  if (!r.ok) throw new Error(`rows: HTTP ${r.status}`);
  return (await r.json()) as any[];
}

export async function apiHistory(base: string, id: string) {
  const r = await fetch(`${base}/api/rows/${encodeURIComponent(id)}/history`);
  if (!r.ok) throw new Error(`history: HTTP ${r.status}`);
  return (await r.json()) as any[];
}
