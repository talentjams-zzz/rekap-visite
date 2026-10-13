import { useState } from 'react';
import type { LabReport, LabTest, RowDto } from '../types';

const LAB_COLS: [keyof LabTest, string][] = [
  ['nama', 'Pemeriksaan'],
  ['hasil', 'Hasil'],
  ['komentar', 'Komentar'],
  ['normal', 'Nilai Normal'],
  ['satuan', 'Satuan'],
  ['keterangan', 'Keterangan'],
  ['tanggal', 'Tgl Hasil'],
];

/** v1 copyToClipboard: navigator.clipboard only in secure contexts (LAN http
 *  access has none) — fall back to hidden textarea + execCommand. */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('execCommand copy failed');
}

/** Collapsed Hasil Lab cell (v1 labSummary): kritis badge + date + counts. */
export function LabCell({
  row,
  open,
  onToggle,
}: {
  row: RowDto;
  open: boolean;
  onToggle: (row: RowDto) => void;
}) {
  const lab = row.lab;
  if (!lab) return <span className="italic text-(--text2)">—</span>;
  return (
    <div>
      {lab.kritis > 0 && (
        <div className="mb-1 inline-block rounded-full bg-red-600 px-2 text-[10px] font-bold text-white">
          ⚠ Lab Kritis
        </div>
      )}
      <button
        className="text-left text-xs hover:underline"
        onClick={() => onToggle(row)}
        title="Click to expand lab report"
      >
        <span className="font-bold text-(--primary)">{lab.maxDate || '—'}</span>{' '}
        <span className="text-(--text2)">
          {lab.testCount} tests · {lab.abnormal} abnormal
          {lab.kritis > 0 && <span className="font-bold text-(--danger)"> · {lab.kritis} kritis</span>}
        </span>{' '}
        <span className="text-(--primary)">{open ? '▲' : '▼'}</span>
      </button>
    </div>
  );
}

/** Expanded lab report panel: filter bar + section headers + findings table. */
export function LabPanel({
  row,
  rep,
  notify,
}: {
  row: RowDto;
  rep: LabReport;
  notify: (msg: string, error?: boolean) => void;
}) {
  // v1 labFilters: union of active 'abnormal' / 'kritis' filters.
  const [filters, setFilters] = useState<Set<string>>(new Set());
  const toggleFilter = (k: string) =>
    setFilters((f) => {
      const n = new Set(f);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const visible = rep.tests.filter((t) => {
    if (!filters.size) return true;
    return (filters.has('abnormal') && t.abnormal) || (filters.has('kritis') && t.kritis);
  });
  const nAbn = rep.tests.filter((t) => t.abnormal).length;
  const nKrit = rep.tests.filter((t) => t.kritis).length;

  const copy = async () => {
    const lines = visible.map((t) => `${t.nama} ${t.hasil}`);
    try {
      await copyText(lines.join('\n'));
      notify(`Copied ${lines.length} test(s)`);
    } catch {
      notify('Copy failed', true);
    }
  };

  // Section headers (Excel "Jenis:" rows) — once per section, only for
  // sections with at least one visible test.
  const body: React.ReactNode[] = [];
  let lastSection: string | null = null;
  for (const t of visible) {
    if (t.jenis !== lastSection) {
      body.push(
        <tr key={`s-${t.jenis}`} className="border-b border-(--border) bg-[#eee] text-[11px] font-bold text-(--text)">
          <td colSpan={LAB_COLS.length} className="px-2 py-1">
            Jenis: {t.jenis}
          </td>
        </tr>,
      );
      lastSection = t.jenis;
    }
    const cls = t.kritis ? 'bg-red-100' : t.abnormal ? 'bg-red-50' : '';
    body.push(
      <tr key={`${t.jenis}-${t.nama}`} className={`border-b border-[#e8e8e8] ${cls}`}>
        <td className="whitespace-nowrap px-2 py-1">{t.nama}</td>
        <td
          className={`whitespace-nowrap px-2 py-1 font-semibold ${
            t.kritis ? 'font-bold text-red-700' : t.abnormal ? 'text-red-600' : ''
          }`}
        >
          {t.hasil}
          {t.kritis && <span className="ml-1 text-[10px] font-bold text-red-700">LK</span>}
        </td>
        <td className="whitespace-pre-wrap px-2 py-1 text-(--text2)">{t.komentar}</td>
        <td className="whitespace-nowrap px-2 py-1">{t.normal}</td>
        <td className="whitespace-nowrap px-2 py-1">{t.satuan}</td>
        <td className="whitespace-pre-wrap px-2 py-1 text-(--text2)">{t.keterangan}</td>
        <td className="whitespace-nowrap px-2 py-1 text-(--text2)">{t.tanggal}</td>
      </tr>,
    );
  }

  return (
    <div className="text-xs">
      <div className="mb-2 flex items-center gap-2 text-sm font-bold text-(--primary)">
        <span>
          Hasil Laboratorium — {row.nama || '—'} (MR {row.mr}) · {rep.tests.length} test · loaded{' '}
          {rep.loadedAt || '—'}
        </span>
        <button
          className="rounded border border-(--border) bg-white px-2 py-0.5 text-xs font-normal hover:bg-(--row-hover)"
          onClick={copy}
        >
          📋 Copy
        </button>
      </div>
      <div className="mb-2 flex gap-1.5">
        <button
          className={`rounded border px-2 py-0.5 text-[11px] ${
            filters.has('abnormal')
              ? 'border-(--primary) bg-(--primary) text-white'
              : 'border-(--border) bg-white hover:bg-(--row-hover)'
          }`}
          onClick={() => toggleFilter('abnormal')}
        >
          Abnormal ({nAbn})
        </button>
        <button
          className={`rounded border px-2 py-0.5 text-[11px] ${
            filters.has('kritis')
              ? 'border-(--danger) bg-(--danger) text-white'
              : 'border-(--border) bg-white hover:bg-(--row-hover)'
          }`}
          onClick={() => toggleFilter('kritis')}
        >
          Kritis ({nKrit})
        </button>
      </div>
      <div className="max-h-96 overflow-auto rounded border border-(--border)">
        <table className="w-full border-collapse">
          <thead className="sticky top-0">
            <tr>
              {LAB_COLS.map(([k, label]) => (
                <th key={k} className="bg-(--thead) px-2 py-1 text-left text-[10px] text-white">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
    </div>
  );
}
