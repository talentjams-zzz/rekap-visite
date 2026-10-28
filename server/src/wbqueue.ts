// Serialized + coalesced write-back queue (v2.1, lab-data loading guide
// Phase 8). Every v2 change used to fire its OWN full legacy export
// (multi-MB JSON rebuild + disk write); two changes in flight meant two
// overlapping exports racing on one fixed temp filename.
//
// A change marks the queue dirty. A write-back only starts after a quiet
// window (no new changes for QUIET_MS), so a burst of changes — e.g. several
// fast uploads — collapses into ONE export that provably contains ALL of
// them (the DB snapshot is taken after the burst ends). If more changes land
// while an export is running, one more pass follows.
//
// Failure semantics (review F5 fix): a failed export does NOT count as
// clean. The dirty flag is RETAINED (the failed generation stays pending),
// the error is recorded and exposed (health reporting), and the loop exits
// instead of hot-spinning a failing writer. The next change (request())
// restarts the loop and retries after one quiet window — bounded, no tight
// retry. settle() REJECTS if it can only end with unresolved pending work,
// so shutdown can't declare success over a stale legacy file.
export interface WritebackQueue {
  /** Mark a change; starts or coalesces a write-back (retries after failure). */
  request(): void;
  /**
   * Resolves when no write-back is in flight AND the queue is clean.
   * REJECTS with the pending failure if the queue ended dirty — an
   * unresolved write-back is not "settled".
   */
  settle(): Promise<void>;
  /** Graceful shutdown: stop waiting further quiet windows. */
  stop(): void;
  /** Observability: how many actual write-backs ran (tests, /api/health). */
  readonly writes: number;
  readonly running: boolean;
  /** True while a change is still owed an export (including failed ones). */
  readonly pending: boolean;
  /** The last write-back error, if the queue is currently pending on one. */
  readonly lastError: unknown;
}

export function createWritebackQueue(
  writer: () => Promise<unknown>,
  quietMs = 150,
): WritebackQueue {
  let running = false;
  let dirty = false;
  let writes = 0;
  let lastError: unknown = null;
  let settleRes: (() => void) | null = null;
  let settleReject: ((e: unknown) => void) | null = null;
  let stopRequested = false;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Interruptible quiet window: a graceful shutdown (stop()) must not wait
  // out the remaining window — it exits immediately.
  const quietSleep = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !stopRequested) await sleep(25);
  };

  // Release settle waiters. Clean → resolve; ended with pending work
  // (failure or stopped-mid-burst) → REJECT so nobody declares success
  // over unresolved state (F5: "ensure settle/shutdown semantics accurately
  // report unresolved failures").
  const finish = () => {
    if (!settleRes || !settleReject) return; // set & cleared as a pair
    const res = settleRes;
    const rej = settleReject;
    settleRes = null;
    settleReject = null;
    if (dirty) rej(lastError ?? new Error('write-back pending'));
    else res();
  };

  function request(): void {
    dirty = true;
    if (running) return; // coalesced — the running loop picks this up
    running = true;
    void (async () => {
      try {
        while (dirty && !stopRequested) {
          await quietSleep(quietMs); // drain window: let overlapping changes land
          if (stopRequested) break;
          dirty = false;
          try {
            await writer(); // DB snapshot now includes everything in the burst
            writes++;
            lastError = null;
          } catch (e) {
            lastError = e;
            dirty = true; // F5: the failed generation stays pending
            break; // don't hot-spin a failing writer; next request() retries
          }
        }
      } finally {
        running = false;
        finish();
      }
    })();
  }

  /** Force-flush for graceful shutdown: stop waiting further quiet windows. */
  function stop(): void {
    stopRequested = true;
    if (!running) {
      // Nothing in flight: release waiters now (clean resolves, dirty rejects).
      finish();
    }
  }

  function settle(): Promise<void> {
    if (!running && !dirty) return Promise.resolve();
    // Stopped with dirty work (a failure or a stopped mid-burst): nothing
    // will run until a new change arrives — report the unresolved state
    // immediately instead of waiting for a loop that already exited (F5).
    if (!running && dirty) {
      return Promise.reject(lastError ?? new Error('write-back pending'));
    }
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

  return {
    request,
    settle,
    stop,
    get writes() { return writes; },
    get running() { return running; },
    get pending() { return dirty; },
    get lastError() { return lastError; },
  };
}
