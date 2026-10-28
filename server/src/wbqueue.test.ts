import { describe, expect, it } from 'vitest';
import { createWritebackQueue } from './wbqueue.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const Q = 40; // short quiet window for tests

describe('createWritebackQueue', () => {
  it('coalesces overlapping requests into a single write', async () => {
    let calls = 0;
    const q = createWritebackQueue(async () => {
      calls++;
      await sleep(20);
    }, Q);
    // Two changes within the quiet window (before any write starts).
    q.request();
    await sleep(5);
    q.request();
    await q.settle();
    expect(calls).toBe(1);
    expect(q.writes).toBe(1);
    expect(q.running).toBe(false);
  });

  it('runs a second pass when a change lands WHILE a write is running', async () => {
    let calls = 0;
    let inWrite = false;
    const q = createWritebackQueue(async () => {
      calls++;
      inWrite = true;
      await sleep(80); // longer than the quiet window
      inWrite = false;
    }, Q);
    q.request();
    // Wait until the first write is verifiably in flight (timing-blind: a
    // plain sleep can land before the quiet window ends under load).
    for (let i = 0; i < 400 && !inWrite; i++) await sleep(5);
    expect(inWrite).toBe(true);
    q.request(); // arrives mid-write → must not be lost
    await q.settle();
    expect(calls).toBe(2);
  });

  it('runs again when a new change arrives AFTER the previous settled', async () => {
    let calls = 0;
    const q = createWritebackQueue(async () => {
      calls++;
    }, Q);
    q.request();
    await q.settle();
    q.request();
    await q.settle();
    expect(calls).toBe(2);
  });

  it('settles instantly when nothing is dirty', async () => {
    const q = createWritebackQueue(async () => undefined, Q);
    await q.settle(); // must not hang
    expect(q.writes).toBe(0);
  });

  it('a writer failure does not wedge the queue', async () => {
    let calls = 0;
    const q = createWritebackQueue(async () => {
      calls++;
      throw new Error('disk full');
    }, Q);
    q.request();
    await expect(q.settle()).rejects.toThrow('disk full');
    expect(q.running).toBe(false);

    // A separate healthy queue still works.
    let ok = 0;
    const q2 = createWritebackQueue(async () => {
      ok++;
    }, Q);
    q2.request();
    await q2.settle();
    expect(ok).toBe(1);
    expect(calls).toBe(1);
  });

  // Review F5: a failure that completes with NO settle waiter must not be
  // forgotten — the work stays pending, the error is exposed, and a LATER
  // settle() must reject (the old code resolved as if clean).
  it('F5: failure without a waiter stays pending; later settle() rejects', async () => {
    const q = createWritebackQueue(async () => {
      throw new Error('disk full');
    }, Q);
    q.request();
    // Let the write fail WITHOUT a settle waiter in place.
    for (let i = 0; i < 400 && q.running; i++) await sleep(5);
    expect(q.running).toBe(false);
    expect(q.pending).toBe(true); // the failed generation is still owed
    expect(String(q.lastError)).toContain('disk full');
    await expect(q.settle()).rejects.toThrow('disk full');
  });

  // Review F5: a change arriving after a failure restarts the queue and the
  // next export succeeds — recovery on the SAME queue instance.
  it('F5: a change after a failure retries on the same instance and recovers', async () => {
    let calls = 0;
    const q = createWritebackQueue(async () => {
      calls++;
      if (calls === 1) throw new Error('transient');
    }, Q);
    q.request();
    for (let i = 0; i < 400 && q.running; i++) await sleep(5);
    expect(q.pending).toBe(true);

    q.request(); // the next change retriggers the export
    await q.settle(); // resolves only because the retry succeeded
    expect(calls).toBe(2);
    expect(q.pending).toBe(false);
    expect(q.lastError).toBeNull();
    expect(q.writes).toBe(1);
  });

  // Review F5: a change landing DURING a failing (long) write must not be
  // stranded in a queue that has stopped running — the next request retries
  // and the work completes.
  it('F5: change during a failing write is not stranded', async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    const q = createWritebackQueue(async () => {
      calls++;
      if (calls === 1) {
        await gate; // long failing write
        throw new Error('disk full');
      }
    }, Q);
    q.request();
    for (let i = 0; i < 400 && !q.running; i++) await sleep(5);
    // Wait until the writer is verifiably in flight (calls === 1).
    for (let i = 0; i < 400 && calls < 1; i++) await sleep(5);
    q.request(); // change arrives mid-failing-write → must not be lost
    release!(); // now the first write fails
    for (let i = 0; i < 400 && q.running; i++) await sleep(5);
    expect(q.pending).toBe(true); // owed: first export failed, second queued
    q.request(); // restart after failure
    await q.settle();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(q.pending).toBe(false);
  });

  it('stop() with pending work rejects settle (no false "clean" at shutdown)', async () => {
    const q = createWritebackQueue(async () => undefined, Q);
    q.request();
    q.stop(); // mid-burst, nothing written yet
    await expect(q.settle()).rejects.toThrow(); // unresolved at shutdown
  });

  it('stop() releases waiters when the queue is clean', async () => {
    const q = createWritebackQueue(async () => undefined, Q);
    q.stop();
    await q.settle(); // must resolve (nothing pending)
  });
});
