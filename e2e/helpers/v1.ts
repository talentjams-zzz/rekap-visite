// Launch the REAL frozen v1 server (single-file node app) against a scratch
// data file — used to prove v1 can load files that v2 wrote (fallback guarantee).
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export const V1_SERVER_JS = '/home/rezza/projects/rekap-visite-nusin/server.js';

let nextV1Port = 8970;

export async function startV1(dataFile: string, portHint?: number): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const port = portHint ?? nextV1Port++;
  const child: ChildProcess = spawn('node', [V1_SERVER_JS], {
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, MONTHLY_CLEANUP: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr += String(d)));
  const deadline = Date.now() + 10000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`v1 server exited early:\n${stderr.slice(0, 800)}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  if (!up) {
    child.kill();
    throw new Error(`v1 server did not open port ${port}:\n${stderr.slice(0, 800)}`);
  }
  return {
    port,
    close: async () => {
      child.kill();
      await sleep(150);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}
