import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ConflictError,
  fetchRows,
  patchAso,
  patchRow,
  postPatientCheck,
  postRowCheck,
  runMaintenance,
  type RowWriteResult,
} from './api';
import { PatientTable } from './components/PatientTable';
import { Rekap } from './components/Rekap';
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
  // Archived-tab filters (v1 archiveFilterBar): facility + registration date range.
  const [archFacility, setArchFacility] = useState('all');
  const [archFrom, setArchFrom] = useState('');
  const [archTo, setArchTo] = useState('');

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
      const call: Promise<RowWriteResult | undefined> = isRowItem
        ? postRowCheck(row.id, key, value, row.rev)
        : postPatientCheck(row.mr, key, value).then(() => undefined);
      call.then((res) => {
        // Refresh the local rev so back-to-back writes don't 409.
        if (isRowItem && res && typeof res.rev === 'number') {
          const nr = res.rev;
          updateLocal((rows) => rows.map((r) => (r.id === row.id ? { ...r, rev: nr } : r)));
        }
      }).catch((e: Error) => {
        if (e instanceof ConflictError) {
          notify('Row changed on another device — reloading', true);
        } else {
          notify(`Check failed: ${e.message}`, true);
        }
        reload();
      });
    },
    [notify, reload, updateLocal],
  );

  const handleEditField = useCallback(
    (row: RowDto, key: EditableKey, value: string) => {
      updateLocal((rows) => rows.map((r) => (r.id === row.id ? { ...r, [key]: value } : r)));
      const patch = key === 'pharmacistNote' ? { note: value } : { [key]: value };
      patchRow(row.id, { ...patch, rev: row.rev }).then((res) => {
        if (typeof res.rev === 'number') {
          const nr = res.rev;
          updateLocal((rows) => rows.map((r) => (r.id === row.id ? { ...r, rev: nr } : r)));
        }
      }).catch((e: Error) => {
        if (e instanceof ConflictError) {
          notify('Row changed on another device — reloading', true);
        } else {
          notify(`Save failed: ${e.message}`, true);
        }
        reload();
      });
    },
    [notify, reload, updateLocal],
  );

  const handleToggleArchive = useCallback(
    (row: RowDto) => {
      const archived = !row.archived;
      updateLocal((rows) => rows.map((r) => (r.id === row.id ? { ...r, archived } : r)));
      patchRow(row.id, { archived, rev: row.rev }).then((res) => {
        notify(`${row.nama || row.mr} ${archived ? 'archived' : 'returned to active'}`);
        if (typeof res.rev === 'number') {
          const nr = res.rev;
          updateLocal((rows) => rows.map((r) => (r.id === row.id ? { ...r, rev: nr } : r)));
        }
      }).catch((e: Error) => {
        if (e instanceof ConflictError) {
          notify('Row changed on another device — reloading', true);
        } else {
          notify(`Archive failed: ${e.message}`, true);
        }
        reload();
      });
    },
    [notify, reload, updateLocal],
  );

  const handleAsoChange = useCallback(
    (row: RowDto, aso: AsoMed[]) => {
      updateLocal((rows) => rows.map((r) => (r.id === row.id ? { ...r, aso } : r)));
      patchAso(row.id, aso, row.rev).then((res) => {
        if (typeof res.rev === 'number') {
          const nr = res.rev;
          updateLocal((rows) => rows.map((r) => (r.id === row.id ? { ...r, rev: nr } : r)));
        }
      }).catch((e: Error) => {
        if (e instanceof ConflictError) {
          notify('Row changed on another device — reloading', true);
        } else {
          notify(`ASO save failed: ${e.message}`, true);
        }
        reload();
      });
    },
    [notify, reload, updateLocal],
  );

  // v1 🧹 Monthly Cleanup: back up ALL data, then remove archived patients.
  const [busyCleanup, setBusyCleanup] = useState(false);
  const handleMaintenance = async () => {
    const n = archived.length;
    const ok = window.confirm(
      `Monthly cleanup:\n1. Back up ALL data (active + archived) to a timestamped file\n` +
        `2. Remove ${n} archived patient(s) and their leftover checklist/lab data\n\n` +
        `Active patients are kept. The backup is verified before anything is removed.\n\nContinue?`,
    );
    if (!ok) return;
    setBusyCleanup(true);
    try {
      const j = await runMaintenance();
      notify(`Cleanup done: ${j.lastMaintenance?.removedRows ?? 0} archived removed · backup ${j.lastMaintenance?.backupFile ?? ''}`);
      reload();
    } catch (e) {
      notify(`Cleanup failed: ${(e as Error).message}`, true);
    } finally {
      setBusyCleanup(false);
    }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = { archived: archived.length };
    for (const f of FACILITIES) c[f] = active.filter((r) => r.facility === f).length;
    return c;
  }, [active, archived]);

  const shown =
    tab === 'archived'
      ? archived.filter((r) => {
          if (archFacility !== 'all' && r.facility !== archFacility) return false;
          // tglRegistrasi may carry a time part — compare date part only so a
          // row on the boundary day is kept (v1 semantics).
          const regDate = (r.tglRegistrasi || '').slice(0, 10);
          if (archFrom && regDate < archFrom) return false;
          if (archTo && regDate > archTo) return false;
          return true;
        })
      : active.filter((r) => r.facility === tab && (!asoFilter || asoDueCount(r) > 0));

  // ASO warning lives on the per-facility filter button (no top banner).
  const asoCount = active.filter((r) => r.facility === tab && asoDueCount(r) > 0).length;
  const title =
    tab === 'archived' ? 'Archived' : tab === 'rekap' ? 'Rekap Checklist' : tab.charAt(0).toUpperCase() + tab.slice(1);

  return (
    // Full-height flex column: the page itself never scrolls; the table area
    // is the scroll box, so its header row can stick (sticky inside a plain
    // page scroll + overflow-x wrapper does not work).
    <div className="flex h-screen flex-col overflow-hidden bg-(--bg) text-(--text)">
      {/* V1 topbar: dark slate bar, white text, white/30 buttons. */}
      <header className="flex shrink-0 flex-wrap items-center gap-4 bg-(--header) px-5 py-3">
        <h1 className="mr-auto text-[18px] font-bold text-white">
          Rekap Visite Multicentre{' '}
          <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-semibold">v2</span>
        </h1>
        <button
          className="rounded-md border border-white/30 bg-white/10 px-3.5 py-1.5 text-xs text-white transition-colors hover:bg-white/25 disabled:opacity-50"
          disabled={busyCleanup}
          onClick={handleMaintenance}
          title="Monthly job: back up ALL data, then remove archived patients. Runs automatically on the 1st of each month — this runs it now."
        >
          {busyCleanup ? 'Running…' : '🧹 Monthly Cleanup'}
        </button>
      </header>
      <main className="mx-auto flex w-full min-h-0 max-w-[1920px] flex-1 flex-col gap-3 p-4">
        <div className="shrink-0">
          <TabBar tab={tab} onChange={setTab} counts={counts} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {tab !== 'rekap' && (
            <div className="shrink-0">
              <UploadBar onUploaded={reload} notify={notify} />
            </div>
          )}
          {error && <p className="mb-2 shrink-0 rounded bg-red-100 p-2 text-red-800">API error: {error}</p>}
          {loading && <p className="shrink-0 text-(--text2)">Loading…</p>}
          {!loading && !error && tab === 'rekap' && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Rekap onOpenMR={(_mr, t) => setTab(t)} />
            </div>
          )}
          {!loading && !error && tab !== 'rekap' && (
            <div className="flex min-h-0 flex-1 flex-col">
              {tab !== 'archived' && (
                <div className="mb-2 flex shrink-0 items-center gap-2">
                  <button
                    className={`rounded-lg px-2.5 py-1 text-xs font-semibold shadow-sm transition-colors ${
                      asoCount > 0
                        ? asoFilter
                          ? 'bg-red-700 text-white ring-2 ring-red-300'
                          : 'bg-red-600 text-white hover:bg-red-700'
                        : 'border border-(--border) bg-white text-(--text2) hover:bg-(--row-hover)'
                    }`}
                    onClick={() => setAsoFilter(!asoFilter)}
                  >
                    ASO ⚠ ({asoCount})
                  </button>
                </div>
              )}
              {tab === 'archived' && (
                <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2 text-xs">
                  <span className="text-(--text2)">Facility:</span>
                  <select
                    className="rounded border border-(--border) bg-white px-2 py-1 text-(--text)"
                    value={archFacility}
                    onChange={(e) => setArchFacility(e.target.value)}
                  >
                    <option value="all">All</option>
                    {FACILITIES.map((f) => (
                      <option key={f} value={f}>
                        {f.charAt(0).toUpperCase() + f.slice(1)}
                      </option>
                    ))}
                  </select>
                  <span className="ml-2 text-(--text2)">Date from:</span>
                  <input
                    type="date"
                    className="rounded border border-(--border) px-2 py-1 text-(--text)"
                    value={archFrom}
                    onChange={(e) => setArchFrom(e.target.value)}
                  />
                  <span className="text-(--text2)">to:</span>
                  <input
                    type="date"
                    className="rounded border border-(--border) px-2 py-1 text-(--text)"
                    value={archTo}
                    onChange={(e) => setArchTo(e.target.value)}
                  />
                </div>
              )}
              <div className="min-h-0 flex-1">
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
              </div>
              <p className="mt-2 shrink-0 text-xs text-(--text2)">
                {title} — {shown.length} row(s)
              </p>
            </div>
          )}
        </div>
      </main>
      <div className="fixed bottom-4 right-4 z-50 flex w-96 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded border p-3 text-sm shadow ${
              t.error ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-(--primary) bg-[#eef2ff] text-(--primary)'
            }`}
          >
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
