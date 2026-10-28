# ASO Medicine-Name Input Deletion: Analysis and Fix Guide

## Scope

This guide analyzes the intermittent problem where typing into the ASO **Med name** field appears to stop, jump backward, or delete text before the medicine name is complete. No application behavior has been changed as part of this analysis.

The current implementation was inspected in:

- `web/src/components/AsoCell.tsx`
- `web/src/App.tsx`
- `web/src/components/PatientTable.tsx`
- `web/src/api.ts`
- `server/src/interactions.ts`
- `e2e/tests/aso.spec.ts`

The existing ASO end-to-end tests pass, including the rapid-typing test. That test does not cover a reload arriving while the input still contains an unsaved draft, which is the important missing case.

## Executive Summary

The input is controlled directly by the server-backed row object:

```tsx
value={med.name}
onChange={(e) => set(idx, { name: e.target.value })}
```

Each keystroke updates local React state and schedules a debounced ASO save. However, an SSE change event, visibility refresh, retry, or another reload can replace the entire `active` row list with an older server snapshot while the user is still typing.

That replacement changes `row.aso`, which changes `med.name`, so the controlled input immediately displays the older value. The browser did not lose the keystrokes; React was told to render a different value. The delayed save may still contain the newer value, which explains why the symptom can be temporary or why the database can eventually contain the correct name even though the field visually appeared to erase it.

There is a second, related race in revision handling: a late reload can write an older revision into `rowRev.current` after a newer write has already completed. A subsequent queued write then sends the stale revision, receives a self-inflicted `409`, and triggers another reload/conflict path.

## Detailed Failure Sequence

### Race A: reload overwrites the draft

1. The user clicks `+ Add med`.
2. A new ASO item is added with `name: ''`.
3. The user types `amoxicillin`.
4. `handleAsoChange` optimistically updates the row and starts or resets the 500 ms timer in `web/src/App.tsx` around lines 309-342.
5. A server change event arrives. This can be caused by the ASO save itself, another browser, an upload, a visibility change, or a retry.
6. `reload()` fetches rows and applies `setActive(a)` in `web/src/App.tsx` around lines 119-153.
7. If that response contains the previous ASO value, the row's `aso` is replaced with the previous list.
8. `AsoCell` receives the replacement row. Its controlled name input renders the old `med.name`, making the user's unfinished text appear deleted.
9. The debounce callback may later send the latest captured array. The server can therefore contain `amoxicillin` while the visible input remains stale until another reload.

### Race B: a late load regresses the cached revision

1. A reload starts while the server row is at revision `N`.
2. A write completes and advances the server to `N+1`; the write coordinator stores `N+1` in `rowRev.current`.
3. The earlier reload returns with a snapshot containing revision `N`.
4. The current code unconditionally executes `rowRev.current.set(r.id, r.rev)` during reload reconciliation.
5. The cached revision regresses from `N+1` to `N`.
6. The next queued ASO/check/edit write sends `N`, receives a `409`, marks the row dead, and reloads.
7. That error/reload cycle can overwrite optimistic UI state and presents as a lost edit or an "another device" conflict even though the only competing operation was this browser's own late response.

The comment near the revision map says completed writes should remain authoritative, but the current assignment does not enforce that invariant.

## Why the Existing Fix Is Incomplete

The current code already improved one failure mode:

- ASO writes are debounced for 500 ms.
- Writes are serialized per row.
- The newest known revision is used by the row coordinator.
- The existing rapid-typing test verifies one clean save.

This prevents overlapping same-revision PATCH requests from fast typing. It does **not** protect the controlled input from a whole-list reload during the debounce or write round-trip. Debouncing reduces request frequency; it does not establish draft ownership.

The existing test in `e2e/tests/aso.spec.ts` types quickly and then waits. It does not force an SSE/reload between two keystrokes, delay a GET response, or assert that the visible input never regresses.

## Recommended Fix Design

Use two separate concepts in the client:

1. **Server state**: the last row snapshot received from the server.
2. **Local ASO draft**: the newest ASO array edited by the user and not yet acknowledged by the server.

Do not use the server row object as the only source for an actively edited controlled input.

### 1. Track pending drafts by row ID

Add a ref or state map keyed by row ID, for example conceptually:

```ts
Map<string, {
  aso: AsoMed[];
  generation: number;
  saveQueued: boolean;
}>
```

On every `handleAsoChange`:

- update the local draft immediately;
- increment its generation/token;
- update the optimistic row for immediate rendering;
- reset the debounce timer;
- ensure the eventual save captures the latest generation.

Avoid relying only on a closure-captured array. A generation/token makes it possible to distinguish an old save completion from a newer edit.

### 2. Overlay drafts after every reload

When a reload returns rows, merge each pending draft over the fetched row before calling `setActive` or `setArchived`:

```ts
const visible = fetched.map((serverRow) => {
  const draft = asoDrafts.current.get(serverRow.id);
  return draft ? { ...serverRow, aso: draft.aso } : serverRow;
});
```

The overlay must apply consistently to every path that installs rows, including active rows and archived rows if an archived row can still have a pending transition.

A reload must not clear a draft merely because the server response is older than the local edit.

### 3. Clear a draft only after matching acknowledgement

When `patchAso` succeeds, the response currently returns a new revision but not the saved ASO payload. The client should retain the generation sent with the request.

On success:

- update the cached revision;
- clear the draft only if the draft generation is still the generation sent by that request;
- if the user typed again while the request was in flight, keep the newer draft and let its timer save it;
- update the visible row revision without replacing its ASO array.

This prevents an old request completion from clearing a newer unfinished name.

A stronger server contract is to return the normalized saved ASO list along with the new revision. If the server normalizes fields, the client can then compare the acknowledged payload exactly. A generation token is still needed to avoid clearing newer local input.

### 4. Make revision reconciliation monotonic

When applying a fetched row revision, never reduce a known revision:

```ts
const known = rowRev.current.get(r.id);
if (known === undefined || r.rev > known) {
  rowRev.current.set(r.id, r.rev);
}
```

Do not blindly trust response arrival order. A late response is allowed to update ordinary server fields only under the normal reload policy, but it must not regress the write coordinator's revision cache.

For maximum rigor, associate reloads and writes with request generations or use a server response that includes a consistent snapshot boundary. The monotonic `max` rule is the minimum required protection for the current architecture.

### 5. Treat a real conflict differently from a self-conflict

A genuine `409` from another device should still reload and notify the user. A stale local revision caused by a late response should be prevented before it reaches the API. Do not solve this by silently retrying every `409` with potentially destructive data; that can overwrite another user's edit.

## Recommended Test Matrix

Add focused end-to-end tests before implementing the fix.

### Test 1: reload during typing

1. Create a row and add an ASO medicine.
2. Type the first part of the name.
3. Trigger a server change event or a controlled reload while the input is focused.
4. Continue typing.
5. Assert immediately that the input value still contains the complete local text.
6. Wait for the debounce/save.
7. Assert API rows contain the complete name and no conflict banner appears.

This directly reproduces the reported symptom.

### Test 2: delayed reload response versus completed ASO write

1. Hold an active `/api/rows` response at revision `N`.
2. Perform an ASO PATCH that completes at revision `N+1`.
3. Release the older GET response.
4. Queue a second ASO change.
5. Assert the second write succeeds and no `409` or conflict banner appears.

This verifies that `rowRev` cannot regress.

### Test 3: edit while first save is in flight

1. Type `amoxi` and let the debounce start the request.
2. Immediately type `cillin`.
3. Resolve the first request.
4. Assert the newer draft remains visible and is saved by the second request.

This verifies generation-aware draft clearing.

### Test 4: real external conflict

1. Load the same row in two pages.
2. Change it in page A.
3. Change it in page B using the stale revision.
4. Assert page B receives the intended conflict behavior and does not silently overwrite page A.

This protects the distinction between a real concurrent edit and an internal client race.

### Test 5: focus and DOM continuity

During the reload test, assert:

- the medicine input remains present;
- its value never regresses;
- focus is not lost unless the row is intentionally removed;
- the `med.id` key remains stable.

## Implementation Checklist

- [ ] Add a per-row pending ASO draft map.
- [ ] Add a monotonically increasing draft generation/token.
- [ ] Overlay pending drafts onto rows returned by reload.
- [ ] Keep the draft while any newer local edit exists.
- [ ] Clear only the acknowledged generation after successful save.
- [ ] Preserve the ASO array when applying a save response that only updates `rev`.
- [ ] Change reload revision reconciliation to monotonic update.
- [ ] Clear pending drafts and timers on row removal/unmount where appropriate.
- [ ] Add reload-during-typing E2E coverage.
- [ ] Add delayed-GET/revision-order E2E coverage.
- [ ] Run the full E2E suite and server tests.

## Verification Commands

From the repository root:

```bash
pnpm --filter rekap-e2e exec playwright test tests/aso.spec.ts
pnpm test
pnpm test:e2e
```

The ASO-specific suite currently passes. That result confirms the existing debounce/serialization behavior, but it does not prove the reload-interleaving cases described above until the new tests are added.

## Operational Workaround Until the Fix Is Implemented

For users experiencing the issue, type the medicine name, wait for the save to finish, and verify the value remains after the row refresh. Avoid editing the same row simultaneously from multiple browser tabs or devices. This is only a workaround; it does not remove the client-side race.

## Acceptance Criteria

The fix is complete when all of the following hold:

- Text never visibly regresses during a reload or SSE event while the user is typing.
- The final medicine name is persisted exactly as entered after the debounce settles.
- A late reload cannot reduce a row's cached revision.
- A newer local edit cannot be cleared by an older save completion.
- Genuine cross-device conflicts still produce the existing conflict behavior.
- Existing ASO, checklist, archive, and full regression tests remain green.
