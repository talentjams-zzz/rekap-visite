import type { HistoryEntry, RowDto } from './types';

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
