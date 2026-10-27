// Serialized + coalesced write-back queue (v2.1, lab-data loading guide
// Phase 8). Every v2 change used to fire its OWN full legacy export
// (multi-MB JSON rebuild + disk write); two changes in flight meant two
// overlapping exports racing on one fixed temp filename.
//
// Now: a change marks the queue dirty. A write-back only starts after a
// quiet window (no new changes for QUIET_MS), so a burst of changes —
// e.g. several fast uploads — collapses into ONE export that provably
// contains ALL of them (the DB snapshot is taken after the burst ends).
// If more changes land while an export is running, one more pass follows.
// Each write-back also uses a unique temp file (see writeback.ts).
export interface WritebackQueue {
  /** Mark a change; starts or coalesces a write-back. */
  request(): void;
  /** Resolves when no write-back is in flight AND the queue is clean. */
  settle(): Promise<void>;
  /** Graceful shutdown: stop waiting further quiet windows. */
  stop(): void;
  /** Observability: how many actual write-backs ran (tests, /api/health). */
  readonly writes: number;
  readonly running: boolean;
}

export function createWritebackQueue(
  writer: () => Promise<unknown>,
  quietMs = 150,
): WritebackQueue {
  let running = false;
  let dirty = false;
  let writes = 0;
  let settleRes: (() => void) | null = null;
  let settleReject: ((e: unknown) => void) | null = null;
  let stopRequested = false;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Interruptible quiet window: a graceful shutdown (stop()) must not wait
  // out the remaining window — it writes the pending state immediately.
  const quietSleep = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !stopRequested) await sleep(25);
  };
  const finish = () => {
    if (settleRes && !dirty) {
      const r = settleRes;
      settleRes = null;
      settleReject = null;
      r();
    }
  };

  function request(): void {
    dirty = true;
    if (running) return; // coalesced — the running loop picks this up
    running = true;
    void (async () => {
      try {
        while (dirty) {
          await quietSleep(quietMs); // drain window: let overlapping changes land
          dirty = false;
          await writer(); // DB snapshot now includes everything in the burst
          writes++;
          if (stopRequested && !dirty) break;
        }
      } catch (e) {
        if (settleReject) {
          const r = settleReject;
          settleRes = null;
          settleReject = null;
          r(e);
        }
      } finally {
        running = false;
        finish();
      }
    })();
  }

  /** Force-flush for graceful shutdown: settle without waiting the full quiet window. */
  function stop(): void {
    stopRequested = true;
    if (!dirty) {
      // Nothing pending — release any waiters now.
      finish();
    }
  }

  function settle(): Promise<void> {
    if (!running && !dirty) return Promise.resolve();
    if (!settleRes) {
      return new Promise<void>((res, rej) => {
        settleRes = res;
        settleReject = rej;
      });
    }
    return new Promise<void>((res, rej) => {
      const prev = settleRes!;
      const prevRej = settleReject!;
      settleRes = () => {
        prev();
        res();
      };
      settleReject = (e: unknown) => {
        prevRej(e);
        rej(e);
      };
    });
  }

  return { request, settle, stop, get writes() { return writes; }, get running() { return running; } };
}
