import type { AsoMed, HistoryEntry, LabReport, RekapData, RowDto } from './types';

export async function fetchRows(status: 'active' | 'archived'): Promise<RowDto[]> {
  const r = await fetch(`/api/rows?status=${status}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as RowDto[];
}

export async function postRowCheck(id: string, key: string, value: string | null): Promise<void> {
  const r = await fetch(`/api/rows/${encodeURIComponent(id)}/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
}

export async function patchRow(id: string, patch: RowPatch): Promise<void> {
  const r = await fetch(`/api/rows/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
export async function patchAso(id: string, aso: AsoMed[]): Promise<void> {
  const r = await fetch(`/api/rows/${encodeURIComponent(id)}/aso`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aso }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
