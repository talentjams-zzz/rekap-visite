import type { AsoMed, HistoryEntry, LabReport, RekapData, RowDto } from './types';

// Generous on purpose: the archived list is a ~1 MB payload and on a slow
// LAN/Tailscale link (or a briefly stalled Windows box) that can take real
// time. 30 s still fails a truly dead connection; instant failure would
// just flash the banner on slow-but-working links.
const READ_TIMEOUT_MS = 30000;

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

/**
 * Structured upload failure (v2.1). The server maps known failure modes to
 * stable codes + actionable messages (FILE_COUNT_LIMIT, FILE_TOO_LARGE,
 * UPLOAD_TIMEOUT, …); the UI displays `message` verbatim.
 */
export class UploadError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Uploads can be slow on a busy Windows box (antivirus scanning) — be
// generous, but never hang the UI forever.
const UPLOAD_TIMEOUT_MS = 180000;

interface UploadErrorBody {
  ok?: boolean;
  code?: string;
  message?: string;
  limit?: number;
}

async function parseUploadResponse(r: Response): Promise<unknown> {
  let body: UploadErrorBody = {};
  try {
    body = (await r.json()) as UploadErrorBody;
  } catch {
    /* non-JSON body */
  }
  if (!r.ok) {
    throw new UploadError(
      body.code || (r.status === 413 ? 'FILE_TOO_LARGE' : `HTTP_${r.status}`),
      body.message || `Upload failed (HTTP ${r.status}). Try smaller batches of 5–10 files.`,
    );
  }
  return body;
}

/**
 * Upload one BATCH of files (the caller chunks — 5 per request keeps memory
 * and write-backs bounded on the server). Resolves with the parsed response
 * typed by T (the body is always the server's JSON for that endpoint).
 */
async function uploadBatch<T>(url: string, files: File[]): Promise<T> {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(url, { method: 'POST', body: fd, signal: ctrl.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new UploadError('UPLOAD_TIMEOUT', 'Upload timed out. Try smaller batches of 5–10 files.');
    }
    throw new UploadError('NETWORK', 'Could not reach the server. Check the connection and retry.');
  } finally {
    clearTimeout(t);
  }
  const body = (await parseUploadResponse(r)) as Record<string, unknown>;
  if (body.ok === false) {
    throw new UploadError(String(body.code || 'UNKNOWN'), String(body.message || 'Upload failed.'));
  }
  return body as T;
}

export interface RegistryUploadResult {
  ok: boolean;
  files: number;
  added: number;
  merged: number;
  readmissions: number;
  skipped: string[];
  failed: { filename: string; code: string; message: string }[];
  warnings: string[];
  sync: { archived: number; unarchived: number };
}

export interface LabUploadResult {
  ok: boolean;
  loaded: number;
  duplicates: string[];
  skipped: string[];
  failed: { filename: string; code: string; message: string }[];
}

/** Registry/handover upload for ONE batch. */
export function uploadRegistry(files: File[]): Promise<RegistryUploadResult> {
  return uploadBatch<RegistryUploadResult>('/api/uploads', files);
}

/** Lab upload for ONE batch (latest per MR wins; exact-file dupes are no-ops). */
export function uploadLab(files: File[]): Promise<LabUploadResult> {
  return uploadBatch<LabUploadResult>('/api/uploads/lab', files);
}
