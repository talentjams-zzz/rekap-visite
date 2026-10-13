import type { Page } from '@playwright/test';
import { apiRows } from './server.js';

export async function uploadFiles(page: Page, files: string[], input = '#file-input'): Promise<void> {
  await page.locator(input).setInputFiles(files);
}

export async function waitRows(
  base: string,
  status: 'active' | 'archived',
  pred: (rows: any[]) => boolean,
): Promise<any[]> {
  for (let i = 0; i < 80; i++) {
    const rows = await apiRows(base, status);
    if (pred(rows)) return rows;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('timeout waiting for rows');
}

/** Row locator by MR (MR is column 3 in facility tabs; column 4 in archived). */
export function rowFor(page: Page, mr: string, archived = false): ReturnType<Page['locator']> {
  const col = archived ? 4 : 3;
  return page
    .locator('table tbody tr')
    .filter({ has: page.locator(`td:nth-child(${col})`, { hasText: mr }) })
    .first();
}

/** Click a checklist chip (TR/CP/PIO/V/PTO/K/RO/PO) in a row. */
export async function toggleCheck(page: Page, mr: string, chip: string, archived = false): Promise<void> {
  await rowFor(page, mr, archived).locator('button', { hasText: chip }).click();
}
