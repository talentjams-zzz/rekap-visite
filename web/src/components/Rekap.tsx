import { useCallback, useEffect, useState } from 'react';
import { fetchRekap } from '../api';
import { CHECKLIST_LABELS, type RekapData, type Tab } from '../types';

const LABEL = Object.fromEntries(CHECKLIST_LABELS) as Record<string, string>;

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

function formatDatePretty(d: string): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(y, m - 1, day);
  return `${days[dt.getDay()]}, ${d}`;
}

/**
 * Rekap Checklist tab (v1 renderRekap): summary stats + per-date breakdown.
 * MR tags switch to the tab where the row lives (facility if active,
 * archived otherwise).
 */
export function Rekap({
  onOpenMR,
}: {
  onOpenMR: (mr: string, tab: Tab) => void;
}) {
  const [data, setData] = useState<RekapData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchRekap()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('change', load);
    return () => es.close();
  }, [load]);

  if (error) return <p className="rounded bg-red-100 p-2 text-red-800">Rekap error: {error}</p>;
  if (!data) return <p className="text-zinc-500">Loading…</p>;

  const dates = Object.keys(data.byDate).sort().reverse();
  if (!dates.length) {
    return (
      <div className="rounded border border-zinc-300 bg-white p-6 text-center text-zinc-500">
        <h2 className="text-lg font-semibold text-zinc-700">No checklist data</h2>
        <p>Check off items in the patient table and they will appear here.</p>
      </div>
    );
  }

  const copyMRs = async (mrs: string[]) => {
    try {
      await copyText(mrs.join('\n'));
    } catch {
      /* toast-less: clipboard unavailable */
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <div className="rounded border border-zinc-300 bg-white px-3 py-2 text-center">
          <div className="text-xl font-bold text-teal-700">{data.totalPatients}</div>
          <div className="text-xs text-zinc-500">Total Patients</div>
        </div>
        {data.allKeys.map((key) => (
          <div key={key} className="rounded border border-zinc-300 bg-white px-3 py-2 text-center">
            <div className="text-xl font-bold text-teal-700">{data.totals[key] ?? 0}</div>
            <div className="text-xs text-zinc-500">{LABEL[key] ?? key}</div>
          </div>
        ))}
      </div>

      <div className="rounded border border-zinc-300 bg-white p-3">
        <h3 className="mb-2 font-semibold">Breakdown by Date</h3>
        <div className="divide-y divide-zinc-100">
          {dates.map((date) => (
            <div key={date} className="py-2">
              <div className="mb-1 text-sm font-semibold text-zinc-700">{formatDatePretty(date)}</div>
              {Object.entries(data.byDate[date]).map(([key, entry]) => (
                <div key={key} className="mb-1.5 flex flex-wrap items-center gap-1">
                  <span className="mr-1 text-[11px] font-semibold text-zinc-600">
                    {LABEL[key] ?? key} ({entry.mrs.length})
                  </span>
                  <button
                    className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-[11px] hover:bg-zinc-50"
                    onClick={() => copyMRs(entry.mrs)}
                  >
                    📋 Copy MRs
                  </button>
                  {entry.mrs.map((mr) => (
                    <button
                      key={mr}
                      title={entry.names[mr] || ''}
                      className="rounded bg-teal-50 px-1.5 py-0.5 text-[11px] text-teal-800 hover:bg-teal-100"
                      onClick={() => {
                        const r = data.rowsByMR[mr];
                        onOpenMR(mr, r && !r.archived ? (r.facility as Tab) : 'archived');
                      }}
                    >
                      {mr}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
