// Batch orchestration: apply a set of parsed Excel files to the world state.
// Port of reference/v1/index.html handleExcelLoad (minus the DOM parts).
import { syncArchiveState } from './merge.js';
import { parseHandover, parseRegistry } from './parsers.js';
import type { BatchResult, ParsedFile, WorldState } from './types.js';

/**
 * Apply files in chronological order so "latest file wins" is correct even
 * when several days are loaded in one batch: a later day always wins, and
 * within the same day the newest upload (inputTs) wins.
 *
 * - Only REGISTRY files advance facilityLatestInput (the handover file is a
 *   subset and must not become the "latest input").
 * - After all files, syncArchiveState archives/unarchives every row.
 */
export function applyFiles(state: WorldState, files: ParsedFile[], nowTs: string): BatchResult {
  const sorted = files.slice().sort((a, b) => a.inputTs.localeCompare(b.inputTs));
  const batch: BatchResult = {
    files: sorted.length,
    added: 0,
    merged: 0,
    warnings: [],
    sync: { archived: 0, unarchived: 0 },
  };

  for (const f of sorted) {
    if (
      f.kind === 'registry' &&
      (!state.facilityLatestInput[f.facility] || f.inputTs > state.facilityLatestInput[f.facility])
    ) {
      state.facilityLatestInput[f.facility] = f.inputTs;
    }
    const res =
      f.kind === 'registry'
        ? parseRegistry(state, f.facility, f.sheets[0]?.rows ?? [], f.reportDate, f.inputTs)
        : parseHandover(state, f.facility, f.sheets, f.reportDate, f.inputTs, f.filename);
    batch.added += res.added;
    batch.merged += res.merged;
    batch.warnings.push(...res.warnings);
  }

  batch.sync = syncArchiveState(state, nowTs);
  return batch;
}
