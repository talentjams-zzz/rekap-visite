import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchRows, patchAso, patchRow, postPatientCheck, postRowCheck } from './api';
import { PatientTable } from './components/PatientTable';
import { TabBar } from './components/TabBar';
import { UploadBar } from './components/UploadBar';
import {
  asoDueCount,
  FACILITIES,
  nowTs,
  ROW_ITEM_KEYS,
  type AsoMed,
  type EditableKey,
  type RowDto,
  type Tab,
} from './types';

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
  const [asoFilter, setAsoFilter] = useState(false);

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

  /** Optimistic local update across both lists; reload on API failure. */
  const updateLocal = useCallback(
    (fn: (rows: RowDto[]) => RowDto[]) => {
      setActive((a) => fn(a));
      setArchived((a) => fn(a));
    },
    [],
  );

  const handleToggleCheck = useCallback(
    (row: RowDto, key: string) => {
      const value = row.checklist[key] ? null : nowTs();
      const isRowItem = ROW_ITEM_KEYS.has(key);
      // Patient items are keyed by MR — update all rows sharing that MR.
      updateLocal((rows) =>
        rows.map((r) =>
          (isRowItem ? r.id === row.id : r.mr === row.mr)
            ? { ...r, checklist: { ...r.checklist, [key]: value } }
            : r,
        ),
      );
      const call = isRowItem
        ? postRowCheck(row.id, key, value)
        : postPatientCheck(row.mr, key, value);
      call.catch((e: Error) => {
        notify(`Check failed: ${e.message}`, true);
        reload();
      });
    },
    [notify, reload, updateLocal],
  );

  const handleEditField = useCallback(
    (row: RowDto, key: EditableKey, value: string) => {
      updateLocal((rows) => rows.map((r) => (r.id === row.id ? { ...r, [key]: value } : r)));
      const patch = key === 'pharmacistNote' ? { note: value } : { [key]: value };
      patchRow(row.id, patch).catch((e: Error) => {
        notify(`Save failed: ${e.message}`, true);
        reload();
      });
    },
    [notify, reload, updateLocal],
  );

  const handleToggleArchive = useCallback(
    (row: RowDto) => {
      const archived = !row.archived;
      updateLocal((rows) => rows.map((r) => (r.id === row.id ? { ...r, archived } : r)));
      patchRow(row.id, { archived }).then(() => {
        notify(`${row.nama || row.mr} ${archived ? 'archived' : 'returned to active'}`);
      }).catch((e: Error) => {
        notify(`Archive failed: ${e.message}`, true);
        reload();
      });
    },
    [notify, reload, updateLocal],
  );

  const handleAsoChange = useCallback(
    (row: RowDto, aso: AsoMed[]) => {
      updateLocal((rows) => rows.map((r) => (r.id === row.id ? { ...r, aso } : r)));
      patchAso(row.id, aso).catch((e: Error) => {
        notify(`ASO save failed: ${e.message}`, true);
        reload();
      });
    },
    [notify, reload, updateLocal],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = { archived: archived.length };
    for (const f of FACILITIES) c[f] = active.filter((r) => r.facility === f).length;
    return c;
  }, [active, archived]);

  const shown =
    tab === 'archived'
      ? archived
      : active.filter((r) => r.facility === tab && (!asoFilter || asoDueCount(r) > 0));

  // v1 updateAsoAlertBanner: meds due to stop across ALL active patients.
  const asoTotal = useMemo(() => active.reduce((n, r) => n + asoDueCount(r), 0), [active]);
  const title =
    tab === 'archived' ? 'Archived' : tab === 'rekap' ? 'Rekap Checklist' : tab.charAt(0).toUpperCase() + tab.slice(1);

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white px-4 py-2">
        <h1 className="text-lg font-semibold">
          Rekap Visite <span className="text-xs font-normal text-zinc-400">v2</span>
        </h1>
      </header>
      {asoTotal > 0 && (
        <div className="flex items-center gap-2 bg-red-600 px-4 py-1.5 text-sm font-bold text-white">
          ⚠️ ASO Alert : {asoTotal} {asoTotal === 1 ? 'med' : 'meds'}
        </div>
      )}
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
              {tab !== 'archived' && (
                <div className="mb-2 flex items-center gap-2">
                  <button
                    className={`rounded border px-2 py-0.5 text-xs ${
                      asoFilter
                        ? 'border-red-600 bg-red-600 text-white'
                        : 'border-zinc-300 bg-white hover:bg-zinc-50'
                    }`}
                    onClick={() => setAsoFilter(!asoFilter)}
                  >
                    ASO ⚠ ({active.filter((r) => r.facility === tab && asoDueCount(r) > 0).length})
                  </button>
                </div>
              )}
              <PatientTable
                rows={shown}
                facility={tab === 'archived' ? 'all' : tab}
                showFacility={tab === 'archived'}
                onToggleCheck={handleToggleCheck}
                onEditField={handleEditField}
                onToggleArchive={handleToggleArchive}
                onAsoChange={handleAsoChange}
                notify={notify}
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
