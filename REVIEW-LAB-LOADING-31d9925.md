# Lab Loading and Checklist Fixes — Review Report

## Verdict

**Changes partially verified; correctness sign-off remains blocked.**

The latest patch improves ordinary rapid-click checklist behavior, implements server-side toggles, and fixes reload cancellation on unmount. All reported tests pass. However, the earlier upload transaction defects remain present in the reviewed and deployed code, write-back failure recovery remains defective, and checklist revision coordination still permits false conflicts and lost user actions.

## Reviewed scope

- Reviewed commit: `31d992587ba767e4f581ec40d04b4b685da2b165`.
- Parent commit: `caa3f7c`.
- Production: `http://100.109.68.87:8787`.
- Production checkout: `/home/rezza/projects/rekap-visite-v2`.
- Review checkout: `/home/rezza/orca/workspaces/rekap-visite/thornyhead`.
- Production checkout revision matched the reviewed commit.
- Inspected deployed lab handler, interaction handler, write-back queue, and web entry artifacts matched the local build.

This review made no source changes and performed no production uploads or other production writes. Failure reproductions used isolated SQLite in-memory databases and test harnesses. The test suite used its isolated scratch servers.

## Validation completed

| Check | Result |
|---|---|
| `pnpm test` | **86 unit tests passed** |
| `pnpm test:e2e` | **37 E2E tests passed** |
| Production build | Passed TypeScript and Vite build |
| Production health | Healthy; 369 patients, 1,317 patient-days, 233 labs |
| New server toggle behavior | Verified current-value toggle, explicit-value compatibility, and stale-revision rejection |
| Unmount reload abort | Present and correct in the inspected cleanup |
| Single-request ordering tests | Both directions pass for two same-MR, same-day files |

Passing tests do not exercise the failure-injection, concurrent-upload, or cross-control revision cases below.

## Findings

### F1 — P1: Failed lab uploads still commit partial data

**Status: confirmed on current source by isolated reproduction.**

Locations:

- [Lab upsert and audit insertion](server/src/labs.ts#L149-L163)
- [Processing exception followed by unconditional COMMIT](server/src/labs.ts#L223-L246)

The per-file exception handler sets `dbFailed` and breaks the processing loop. Execution then reaches `db.exec('COMMIT')`. The response subsequently claims that nothing was saved, despite preceding writes being committed.

#### Reproduction

1. Create an in-memory database from the current schema.
2. Register the current lab route with Fastify and multipart support.
3. Add a SQLite trigger rejecting insertion into `lab_uploads`.
4. Upload a valid generated `lab-123.xlsx`.

Observed:

- HTTP 500 with `DB_ERROR` and a message stating “nothing was saved.”
- `labs` contains MR 123 and its parsed report.
- `lab_uploads` contains no corresponding audit row.
- The change callback runs zero times.

#### Impact

A failed upload can persist an unaudited lab replacement without notifying clients or requesting legacy write-back. Atomic-chunk guarantees and the error message are false for this path.

#### Required remediation

- Propagate unexpected processing/database errors to a rollback path.
- Execute COMMIT only when the chunk has completed successfully.
- Keep expected per-file parse/validation failures distinct from transaction failures.
- Add tests rejecting both an audit insert and a later file's database write; verify that all chunk writes are absent afterward and no change notification fires.

### F2 — P1: Overlapping uploads interfere with each other's transactions

**Status: confirmed on current source by deterministic streamed reproduction.**

Locations:

- [BEGIN before multipart awaits](server/src/labs.ts#L200-L205)
- [Unconditional rollback in catch](server/src/labs.ts#L234-L239)

The handler opens a transaction on the shared database connection before awaiting network input. While it waits, another request can enter on the same connection. A second BEGIN fails, and the second request's catch rolls back the first request's transaction.

#### Reproduction

1. Stream upload A with complete `lab-111.xlsx`, followed by the header for a second file; pause before sending the second workbook.
2. Confirm A's first insertion exists on the connection.
3. Submit upload B containing `lab-333.xlsx`.
4. B's nested BEGIN fails; B rolls back A's transaction.
5. Resume A with `lab-222.xlsx` and finish the multipart body.

Observed:

- Both requests return HTTP 500.
- MR 111 disappears after B's rollback.
- MR 222 persists because A resumes writing outside a transaction.
- No change callback fires.

#### Impact

Normal overlapping users or requests can produce partial, unannounced writes. This is not limited to an injected database fault.

#### Required remediation

- Receive and parse into bounded staging outside the database transaction.
- Validate multipart completion and request-level limits before committing staged results.
- Execute a short synchronous transaction with no network await inside it.
- Roll back only a transaction owned by that operation.
- If another connection or write coordinator is used, ensure all writers and exports observe the intended committed-state boundary.
- Add deterministic tests using a paused multipart stream plus an overlapping upload and an overlapping ordinary edit.

### F3 — P2: Checklist revision cache becomes stale after other successful row writes

**Status: confirmed in an isolated harness executing the current checklist handler.**

Locations:

- [Checklist revision selection and response update](web/src/App.tsx#L240-L250)
- [Field edit revision update](web/src/App.tsx#L269-L276)
- [Archive revision update](web/src/App.tsx#L290-L298)
- [ASO revision selection and update](web/src/App.tsx#L331-L343)

Checklist, ASO, field edits, and archive changes advance the same server row revision. The client coordinates them separately. `checkRev` takes precedence over the newer revision in the rendered row, but successful writes from other controls do not update that cache.

#### Reproduction

1. Checklist toggle succeeds at server revision 1; `checkRev` becomes 1.
2. An own field edit succeeds at revision 2; rendered row revision becomes 2.
3. Before the coalesced reload finishes, click another checklist item.
4. The checklist handler sends cached revision 1 against server revision 2.

Observed: HTTP 409, false “another device” conflict, and the optimistic checklist action is discarded on reload.

#### Required remediation

- Use a common per-row mutation coordinator and revision source for checklist, ASO, field edits, and archive changes.
- Update authoritative revision bookkeeping after every successful row mutation.
- Serialize operations that share the server revision, not only operations from the same control type.
- Add delayed-response tests for checklist → field edit → checklist and checklist → ASO → checklist.

### F4 — P2: Reload cache clearing can invalidate queued checklist actions

**Status: confirmed in an isolated harness with controlled microtask ordering.**

Locations:

- [Successful reload clears revision maps](web/src/App.tsx#L129-L138)
- [Queued checklist action falls back to captured row revision](web/src/App.tsx#L240-L246)

A successful reload clears `checkRev` while the checklist promise chain may still contain pending operations. The next queued operation falls back to `row.rev` captured at click time rather than the newly loaded row's revision.

#### Reproduction

1. Queue two checklist clicks from a row at revision 0.
2. First write succeeds at revision 1.
3. A load completion clears `checkRev` before the next queued chain step.
4. Second operation sends captured revision 0 against server revision 1.

Observed: HTTP 409 and a lost queued action.

#### Required remediation

- Reconcile loaded revisions with pending operations instead of blindly clearing revision state.
- Never fall back to a stale click-time row after invalidating its cache.
- Preserve genuine cross-device conflict detection; do not blindly substitute another client's newer revision into an old pending intent.
- Test refresh completion between queued writes and responses arriving in controlled orders.

### F5 — P2: Write-back failures are swallowed or strand pending work

**Status: reconfirmed; unchanged by this patch.**

Locations:

- [Dirty state, writer invocation, and failure handling](server/src/wbqueue.ts#L51-L74)
- [Production writer and queue request](server/src/index.ts#L49-L59)

The queue clears `dirty` before running the writer. Failure handling does not reliably retain failed work or restart pending work. Normal callers request a write-back without awaiting `settle()`, allowing errors to disappear silently.

Reproduced cases:

1. Writer fails with no current settle waiter: zero successful exports, but a later `settle()` resolves as if clean.
2. Another change arrives during a failing writer: queue ends with `running=false` and pending dirty work; a subsequent `settle()` remains pending until another request restarts the queue.

#### Required remediation

- Retain the failed generation as pending.
- Log errors and expose pending/failure status through health reporting.
- Retry with bounded backoff or provide an explicit recoverable failed state.
- Ensure settle/shutdown semantics accurately report unresolved failures.
- Test recovery using the same failed queue instance, including a change arriving during failure.

## Accepted changes and scope limits

### Server-side toggles

The row and patient checklist endpoints now flip the current stored value when `toggle` is requested. Explicit-value writes remain supported. Row-level stale revisions still return 409.

The new [server toggle sections](server/src/interactions.ts#L105-L169) execute synchronous database operations without an intervening await, so no separate same-process read/flip/write interleaving defect was found in those sections. This does not resolve the shared transaction issue in F2.

### Unmount abort

[The cleanup](web/src/App.tsx#L168-L175) now aborts the active reload controller as well as clearing the pending debounce timer. This review item is accepted.

### Registry ordering tests

[The new tests](e2e/tests/upload-order.spec.ts#L28-L62) establish that the last file in one request wins for the tested two-file, same-MR, same-day case. They correctly avoid assuming file modification times determine order.

They do not test cross-chunk equivalence or mixed report-date ordering. No new cross-chunk defect is asserted solely from these tests, but broader ordering sign-off requires tests spanning the five-file boundary and different report dates. The fixture uses registration times on the same date; it does not demonstrate readmission-date transitions.

### Test coverage limitation

[The rapid-click E2E tests](e2e/tests/rapid-check.spec.ts) pass, but sequential awaited browser clicks do not guarantee the first HTTP response is still pending when the second click occurs. Controlled response delays are needed to deterministically test overlapping operations, refresh/cache interleavings, and writes from multiple control types.

## Required next steps

1. Fix F1 and F2 before claiming atomic uploads or closing the earlier correctness blocker.
2. Add database-failure and concurrent-upload tests reproducing both failures.
3. Implement common per-row write/revision coordination and address F3/F4.
4. Add deterministic delayed-response tests across controls and reloads.
5. Fix F5 and verify retry/recovery on the same queue instance.
6. Rerun unit and E2E suites, then rebuild and verify the deployed artifacts.

## Final assessment

The performance improvements remain valuable and the latest toggle/unmount patch is a useful step. **The reported test counts and deployment are verified, but “all issues fixed at the root” and “correctness sign-off blocker resolved” are not supported by the current implementation.**

The upload transaction defects are still reproducible in the deployed code, checklist revision coordination still produces self-conflicts, and write-back failure recovery remains incomplete.
