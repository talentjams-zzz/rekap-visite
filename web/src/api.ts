import type { AsoMed, HistoryEntry, LabReport, RekapData, RowDto } from './types';

const READ_TIMEOUT_MS = 15000;

export async function fetchRows(status: 'active' | 'archived'): Promise<RowDto[]> {
  // A hung connection must fail fast (recoverable error) instead of leaving
  // the page in a pending state forever.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), READ_TIMEOUT_MS);
  try {
    const r = await fetch(`/api/rows?status=${status}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as RowDto[];
  } finally {
    clearTimeout(t);
  }
}

/** Thrown on HTTP 409 — the row changed on another device; caller reloads. */
export class ConflictError extends Error {
  constructor() {
    super('conflict');
  }
}

async function throwIfNotOk(r: Response): Promise<void> {
  if (r.status === 409) throw new ConflictError();
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

/** Result of a successful row write — `rev` is the new row revision. */
export interface RowWriteResult {
  ok: boolean;
  rev?: number;
}

export async function postRowCheck(
  id: string,
  key: string,
  value: string | null,
  rev?: number,
): Promise<RowWriteResult> {
  const r = await fetch(`/api/rows/${encodeURIComponent(id)}/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value, rev }),
  });
  await throwIfNotOk(r);
  return (await r.json()) as RowWriteResult;
}

export async function postPatientCheck(mr: string, key: string, value: string | null): Promise<void> {
  const r = await fetch(`/api/patients/${encodeURIComponent(mr)}/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export interface RowPatch {
  note?: string;
  archived?: boolean;
  diagnosis?: string;
  operan?: string;
  terapi?: string;
  soap?: string;
  rev?: number;
}

export async function patchRow(id: string, patch: RowPatch): Promise<RowWriteResult> {
  const r = await fetch(`/api/rows/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await throwIfNotOk(r);
  return (await r.json()) as RowWriteResult;
}

/** Riwayat: past days only (newest first). */
export async function fetchHistory(id: string): Promise<HistoryEntry[]> {
  const r = await fetch(`/api/rows/${encodeURIComponent(id)}/history`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as HistoryEntry[];
}

/** Full lab report for an MR (fetched when the lab panel expands). */
export async function fetchLab(mr: string): Promise<LabReport | null> {
  const r = await fetch(`/api/patients/${encodeURIComponent(mr)}/lab`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as LabReport;
}

/** Replace a row's ASO (meds-to-stop) list. */
export async function patchAso(
  id: string,
  aso: AsoMed[],
  rev?: number,
): Promise<RowWriteResult> {
  const r = await fetch(`/api/rows/${encodeURIComponent(id)}/aso`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aso, rev }),
  });
  await throwIfNotOk(r);
  return (await r.json()) as RowWriteResult;
}

/** Run the monthly maintenance job now (backup → verify → remove archived). */
export async function runMaintenance(): Promise<{
  ok: boolean;
  error?: string;
  lastMaintenance?: {
    ranAt: string;
    trigger: string;
    backupFile: string;
    rowsBefore: number;
    rowsAfter: number;
    removedRows: number;
    removedChecklist: number;
    removedLab: number;
  };
}> {
  const r = await fetch('/api/maintenance/run', { method: 'POST' });
  const j = (await r.json()) as {
    ok: boolean;
    error?: string;
    lastMaintenance?: {
      ranAt: string;
      trigger: string;
      backupFile: string;
      rowsBefore: number;
      rowsAfter: number;
      removedRows: number;
      removedChecklist: number;
      removedLab: number;
    };
  };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/** Rekap checklist aggregates (v1 buildRekapData). */
export async function fetchRekap(): Promise<RekapData> {
  const r = await fetch('/api/rekap');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as RekapData;
}

/** Lab uploads: one or more lab-{MR}.xlsx files (latest per MR wins). */
export async function uploadLab(
  files: File[],
): Promise<{ ok: boolean; loaded: number; skipped: string[] }> {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const r = await fetch('/api/uploads/lab', { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as { ok: boolean; loaded: number; skipped: string[] };
}
