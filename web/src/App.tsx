import { useEffect, useMemo, useState } from 'react';
import { fetchRows } from './api';
import { PatientTable } from './components/PatientTable';
import { TabBar } from './components/TabBar';
import { FACILITIES, type RowDto, type Tab } from './types';

export default function App() {
  const [tab, setTab] = useState<Tab>('nusin');
  const [active, setActive] = useState<RowDto[]>([]);
  const [archived, setArchived] = useState<RowDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchRows('active'), fetchRows('archived')])
      .then(([a, b]) => {
        setActive(a);
        setArchived(b);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = { archived: archived.length };
    for (const f of FACILITIES) c[f] = active.filter((r) => r.facility === f).length;
    return c;
  }, [active, archived]);

  const title =
    tab === 'archived' ? 'Archived' : tab === 'rekap' ? 'Rekap Checklist' : tab.charAt(0).toUpperCase() + tab.slice(1);

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900">
      <header className="bg-white border-b border-zinc-200 px-4 py-2">
        <h1 className="text-lg font-semibold">
          Rekap Visite <span className="text-xs font-normal text-zinc-400">v2</span>
        </h1>
      </header>
      <main className="mx-auto max-w-[1920px] p-4">
        <TabBar tab={tab} onChange={setTab} counts={counts} />
        <div className="mt-3">
          {error && <p className="mb-2 rounded bg-red-100 p-2 text-red-800">API error: {error}</p>}
          {loading && <p className="text-zinc-500">Loading…</p>}
          {!loading && !error && tab === 'rekap' && (
            <div className="rounded border border-zinc-300 bg-white p-6 text-zinc-500">
              Rekap Checklist — aggregates land in P7.
            </div>
          )}
          {!loading && !error && tab !== 'rekap' && (
            <PatientTable
              rows={tab === 'archived' ? archived : active.filter((r) => r.facility === tab)}
              facility={tab === 'archived' ? 'all' : tab}
              showFacility={tab === 'archived'}
            />
          )}
          {!loading && !error && tab !== 'rekap' && (
            <p className="mt-2 text-xs text-zinc-400">
              {title} — {tab === 'archived' ? archived.length : active.filter((r) => r.facility === tab).length} row(s)
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
