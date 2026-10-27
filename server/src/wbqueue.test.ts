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
    const q = createWritebackQueue(async () => {
      calls++;
      await sleep(50); // longer than the quiet window
    }, Q);
    q.request();
    await sleep(Q + 10); // the first write is now in flight
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

  it('stop() releases waiters when the queue is clean', async () => {
    const q = createWritebackQueue(async () => undefined, Q);
    q.stop();
    await q.settle(); // must resolve (nothing pending)
  });
});
