import type { RowDto } from './types';

export async function fetchRows(status: 'active' | 'archived'): Promise<RowDto[]> {
  const r = await fetch(`/api/rows?status=${status}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as RowDto[];
}
