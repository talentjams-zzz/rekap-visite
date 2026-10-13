import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchRows } from './api';
import { PatientTable } from './components/PatientTable';
import { TabBar } from './components/TabBar';
import { UploadBar } from './components/UploadBar';
import { FACILITIES, type RowDto, type Tab } from './types';

interface Toast {
  id: number;
  msg: string;
  error?: boolean;
}

export default function App() {
  const [tab, setTab] = useState<Tab>('nusin');
  const [active, setActive] = useState<RowDto[]>([]);
  const [archived, setArchived] = useState<RowDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((msg: string, isError = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, error: isError }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 8000);
  }, []);

  const reload = useCallback(() => {
    Promise.all([fetchRows('active'), fetchRows('archived')])
      .then(([a, b]) => {
        setActive(a);
        setArchived(b);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    reload();
    setLoading(false);
    // Live sync: refetch when the server broadcasts a change (upload,
    // auto-migration, or another device's save).
    const es = new EventSource('/api/events');
    es.addEventListener('change', reload);
    return () => es.close();
  }, [reload]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { archived: archived.length };
    for (const f of FACILITIES) c[f] = active.filter((r) => r.facility === f).length;
    return c;
  }, [active, archived]);

  const shown = tab === 'archived' ? archived : active.filter((r) => r.facility === tab);
  const title =
    tab === 'archived' ? 'Archived' : tab === 'rekap' ? 'Rekap Checklist' : tab.charAt(0).toUpperCase() + tab.slice(1);

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white px-4 py-2">
        <h1 className="text-lg font-semibold">
          Rekap Visite <span className="text-xs font-normal text-zinc-400">v2</span>
        </h1>
      </header>
      <main className="mx-auto max-w-[1920px] p-4">
        <TabBar tab={tab} onChange={setTab} counts={counts} />
        <div className="mt-3">
          {tab !== 'rekap' && <UploadBar onUploaded={reload} notify={notify} />}
          {error && <p className="mb-2 rounded bg-red-100 p-2 text-red-800">API error: {error}</p>}
          {loading && <p className="text-zinc-500">Loading…</p>}
          {!loading && !error && tab === 'rekap' && (
            <div className="rounded border border-zinc-300 bg-white p-6 text-zinc-500">
              Rekap Checklist — aggregates land in P7.
            </div>
          )}
          {!loading && !error && tab !== 'rekap' && (
            <>
              <PatientTable
                rows={shown}
                facility={tab === 'archived' ? 'all' : tab}
                showFacility={tab === 'archived'}
              />
              <p className="mt-2 text-xs text-zinc-400">
                {title} — {shown.length} row(s)
              </p>
            </>
          )}
        </div>
      </main>
      <div className="fixed bottom-4 right-4 z-50 flex w-96 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded border p-3 text-sm shadow ${
              t.error ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-teal-300 bg-teal-50 text-teal-900'
            }`}
          >
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
