import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ConflictError,
  fetchCounts,
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

// V1 filter bar order (frozen), with ASO moved to first (user request).
const FILTER_KEYS = [
  'aso',
  'telaah_resep',
  'catatan_pengobatan',
  'penelusuran_obat',
  'rekonsiliasi_obat',
  'visite',
  'pto',
  'konseling',
  'pio',
] as const;
const FILTER_BTNS: Array<[string, string]> = [
  ['aso', 'ASO ⚠'],
  ['telaah_resep', 'Telaah Resep'],
  ['catatan_pengobatan', 'Catatan Pengobatan'],
  ['penelusuran_obat', 'Penelusuran Obat'],
  ['rekonsiliasi_obat', 'Rekonsiliasi Obat'],
  ['visite', 'Visite'],
  ['pto', 'PTO'],
  ['konseling', 'Konseling'],
  ['pio', 'PIO'],
];

export default function App() {
  const [tab, setTab] = useState<Tab>('nusin');
  const [active, setActive] = useState<RowDto[]>([]);
  // v2.1: the archived list is loaded LAZILY (the tab is rarely the first
  // thing looked at, and it's the bigger payload). archLoaded=false means
  // the list is stale/missing — the next Archived-tab open refetches.
  const [archived, setArchived] = useState<RowDto[]>([]);
  const [archLoaded, setArchLoaded] = useState(false);
  // Server-side count for the tab badge (no archived transfer needed).
  const [archCount, setArchCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  // V1 "Filter undone:" bar (ASO first): multi-select checklist filters.
  const [undoneFilters, setUndoneFilters] = useState<string[]>([]);
  // Light/dark theme (persisted; default light = V1).
  const [dark, setDark] = useState(() => {
    try {
      return localStorage.getItem('rekap-theme') === 'dark';
    } catch {
      return false;
    }
  });
  // Archived-tab filters (v1 archiveFilterBar): facility + registration date range.
  const [archFacility, setArchFacility] = useState('all');
  const [archFrom, setArchFrom] = useState('');
  const [archTo, setArchTo] = useState('');

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem('rekap-theme', dark ? 'dark' : 'light');
    } catch {
      /* private mode */
    }
  }, [dark]);

  const notify = useCallback((msg: string, isError = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, error: isError }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 8000);
  }, []);

  // ── Reloading (v2.1: coalesced + aborting + lazy archived) ──────────────
  // Every change event used to trigger a full fetch of BOTH lists; an
  // upload (immediate) + its SSE broadcast (a moment later) meant two
  // overlapping list loads. Now: calls within 150 ms collapse into one,
  // and a new reload ABORTS the in-flight one (cancelling the network work,
  // not just ignoring the response). The archived list only travels when
  // it's already loaded or visible.
  // Stale-response guard stays: a slow response must never clobber newer
  // state — the last load started wins.
  const loadSeq = useRef(0);
  const reloadTimer = useRef<number | null>(null);
  const reloadAbort = useRef<AbortController | null>(null);
  // Refs so the coalesced closure sees the current tab/archLoaded without
  // being re-created (reload must stay referentially stable).
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const archLoadedRef = useRef(archLoaded);
  archLoadedRef.current = archLoaded;

  const reload = useCallback(() => {
    if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null;
      reloadAbort.current?.abort(); // cancel the superseded request(s)
      const ctrl = new AbortController();
      reloadAbort.current = ctrl;
      const seq = ++loadSeq.current;
      const wantArchived = archLoadedRef.current || tabRef.current === 'archived';
      const archP = wantArchived ? fetchRows('archived', ctrl.signal) : Promise.resolve(null);
      Promise.all([fetchRows('active', ctrl.signal), fetchCounts(ctrl.signal), archP])
        .then(([a, c, b]) => {
          if (seq !== loadSeq.current) return; // superseded by a newer load
          setActive(a);
          setArchCount(c.archived);
          if (b !== null) {
            setArchived(b);
            setArchLoaded(true);
          } else {
            setArchLoaded(false); // list now stale — next tab open refetches
          }
          setError(null); // a successful load always clears the banner
        })
        .catch((e: unknown) => {
          const name = (e as { name?: string })?.name;
          if (name === 'AbortError') return; // superseded — not an error
          if (seq === loadSeq.current) setError(String(e));
        });
    }, 150);
  }, []);

  // Opening the Archived tab with a stale/missing list triggers the load.
  useEffect(() => {
    if (tab === 'archived' && !archLoaded) reload();
  }, [tab, archLoaded, reload]);

  useEffect(() => {
    reload();
    setLoading(false);
    // Live sync: refetch when the server broadcasts a change (upload,
    // auto-migration, or another device's save).
    const es = new EventSource('/api/events');
    es.addEventListener('change', reload);
    return () => {
      es.close();
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
    };
  }, [reload]);

  // Self-healing: a transient failure ("TypeError: Failed to fetch" after a
  // network hiccup, laptop sleep, server restart) must not blank the page.
  // While the error banner is up, retry every 5 s until a load succeeds.
  useEffect(() => {
    if (!error) return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [error, reload]);

  // Also refresh when the tab is shown again — backgrounded tabs die on
  // stale connections after sleep/network changes.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
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

  // ── ASO writes: debounce + per-row serialization ───────────────────────
  // Saving per keystroke (the old behavior) meant fast typing sent several
  // PATCHes with the SAME row rev; the second hit a 409 from the first and
  // the UI said "Row changed on another device" — a self-inflicted conflict.
  // Now: local state updates instantly (optimistic), the server save is
  // debounced (quiet period), same-row saves are serialized, and each send
  // uses the newest known rev (kept in a ref, updated synchronously from
  // the previous response — React state can't be trusted mid-chain). A 409
  // can only come from a genuine cross-device change now.
  const ASO_SAVE_MS = 500;
  const asoTimer = useRef(new Map<string, number>());
  const asoChain = useRef(new Map<string, Promise<unknown>>());
  const asoRev = useRef(new Map<string, number>());
  const asoDead = useRef(new Set<string>()); // row: last save 409'd, skip queued saves
  const rowsRef = useRef<RowDto[]>([]);
  useEffect(() => {
    rowsRef.current = [...active, ...archived];
  }, [active, archived]);

  const flushAso = useCallback(
    (rowId: string, aso: AsoMed[]) => {
      if (asoDead.current.has(rowId)) return; // a real conflict reloaded; drop stale saves
      const prev = asoChain.current.get(rowId) ?? Promise.resolve();
      const task = prev
        .then(async () => {
          const row = rowsRef.current.find((r) => r.id === rowId);
          const rev = asoRev.current.get(rowId) ?? row?.rev;
          const res = await patchAso(rowId, aso, rev);
          if (typeof res.rev === 'number') {
            asoRev.current.set(rowId, res.rev);
            const nr = res.rev;
            updateLocal((rows) => rows.map((r) => (r.id === rowId ? { ...r, rev: nr } : r)));
          }
        })
        .catch((e: Error) => {
          asoDead.current.add(rowId);
          asoChain.current.delete(rowId);
          asoRev.current.delete(rowId);
          if (e instanceof ConflictError) {
            notify('Row changed on another device — reloading', true);
          } else {
            notify(`ASO save failed: ${e.message}`, true);
          }
          reload();
        });
      asoChain.current.set(rowId, task.catch(() => undefined));
    },
    [notify, reload, updateLocal],
  );

  const handleAsoChange = useCallback(
    (row: RowDto, aso: AsoMed[]) => {
      updateLocal((rows) => rows.map((r) => (r.id === row.id ? { ...r, aso } : r)));
      asoDead.current.delete(row.id); // user is typing again — clear any conflict flag
      const prev = asoTimer.current.get(row.id);
      if (prev) window.clearTimeout(prev);
      asoTimer.current.set(
        row.id,
        window.setTimeout(() => {
          asoTimer.current.delete(row.id);
          flushAso(row.id, aso); // `aso` is the latest local state (each keystroke reschedules)
        }, ASO_SAVE_MS),
      );
    },
    [flushAso, updateLocal],
  );

  // v1 🧹 Monthly Cleanup: back up ALL data, then remove archived patients.
  const [busyCleanup, setBusyCleanup] = useState(false);
  const handleMaintenance = async () => {
    const n = archCount; // server count — the list itself may not be loaded
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
    const c: Record<string, number> = { archived: archCount };
    for (const f of FACILITIES) c[f] = active.filter((r) => r.facility === f).length;
    return c;
  }, [active, archCount]);

  // V1 isItemDone/matchesFilters: a row shows when it is UNDONE for every
  // active filter (multi-select AND semantics, exactly like v1).
  // (Must be defined BEFORE `shown` below — the filter callback runs during
  // its evaluation, and a later const is in the TDZ at that point.)
  const isItemDone = (r: RowDto, key: string) =>
    key === 'aso' ? asoDueCount(r) === 0 : !!(r.checklist || {})[key];
  const matchesFilters = (r: RowDto) => undoneFilters.every((k) => !isItemDone(r, k));
  const toggleFilter = (key: string) =>
    setUndoneFilters((f) => (f.includes(key) ? f.filter((x) => x !== key) : [...f, key]));

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
      : active.filter((r) => r.facility === tab && matchesFilters(r));

  // Per-facility undone counts for the filter pills (v1 getUndoneCount).
  const undoneCounts = useMemo(() => {
    const c: Record<string, number> = {};
    if (tab === 'archived' || tab === 'rekap') return c;
    for (const r of active) {
      if (r.facility !== tab) continue;
      for (const k of FILTER_KEYS) {
        if (isItemDone(r, k)) continue;
        c[k] = (c[k] ?? 0) + 1;
      }
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tab]);
  const title =
    tab === 'archived' ? 'Archived' : tab === 'rekap' ? 'Rekap Checklist' : tab.charAt(0).toUpperCase() + tab.slice(1);

  return (
    // Full-height flex column: the page itself never scrolls; the table area
    // is the scroll box, so its header row can stick (sticky inside a plain
    // page scroll + overflow-x wrapper does not work).
    <div className="flex h-screen flex-col overflow-hidden bg-(--bg) text-(--text)">
      {/* V1 topbar: dark slate bar, white text, white/30 buttons. */}
      <header className="flex shrink-0 flex-wrap items-center gap-4 bg-(--header) px-4 py-1.5">
        <h1 className="mr-auto text-[18px] font-bold text-white">
          Rekap Visite Multicentre{' '}
          <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-semibold">v2</span>
        </h1>
        {/* Load buttons live in the title bar (v1 topbar layout). */}
        <UploadBar inHeader onUploaded={reload} notify={notify} />
        <button
          className="rounded-md border border-white/30 bg-white/10 px-3.5 py-1.5 text-xs text-white transition-colors hover:bg-white/25 disabled:opacity-50"
          disabled={busyCleanup}
          onClick={handleMaintenance}
          title="Monthly job: back up ALL data, then remove archived patients. Runs automatically on the 1st of each month — this runs it now."
        >
          {busyCleanup ? 'Running…' : '🧹 Monthly Cleanup'}
        </button>
        <button
          className="rounded-md border border-white/30 bg-white/10 px-2 py-1 text-xs text-white transition-colors hover:bg-white/25"
          onClick={() => setDark(!dark)}
          title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {dark ? '☀️' : '🌙'}
        </button>
      </header>
      {/* minimal vertical rhythm: the table gets the space, not the gaps */}
      <main className="mx-auto flex w-full min-h-0 max-w-[1920px] flex-1 flex-col gap-1 px-3 py-1">
        <div className="shrink-0">
          <TabBar tab={tab} onChange={setTab} counts={counts} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Transient API errors keep the last data visible (no dead page);
              the banner offers an instant retry and auto-retry runs above. */}
          {error && (
            <p className="mb-1 flex shrink-0 items-center gap-2 rounded bg-(--danger)/10 px-2 py-1 text-xs text-(--danger)">
              <span className="truncate">
                ⚠ API error: {error} — retrying every 5 s
              </span>
              <button
                className="shrink-0 rounded border border-(--danger) px-2 py-0.5 font-semibold transition-colors hover:bg-(--danger) hover:text-white"
                onClick={reload}
              >
                Retry now
              </button>
            </p>
          )}
          {loading && <p className="shrink-0 text-(--text2)">Loading…</p>}
          {!loading && tab === 'rekap' && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Rekap onOpenMR={(_mr, t) => setTab(t)} />
            </div>
          )}
          {!loading && tab !== 'rekap' && (
            <div className="flex min-h-0 flex-1 flex-col">
              {tab !== 'archived' && (
                // V1 filter bar (frozen look): "Filter undone:" + pill buttons;
                // ASO comes first (user request). Active = solid fill.
                <div className="mb-1 flex shrink-0 flex-wrap items-center gap-1.5 border-b border-(--border) bg-(--card) px-2 py-1">
                  <span className="mr-1 text-[11px] font-semibold text-(--text2)">Filter undone:</span>
                  {FILTER_BTNS.map(([k, label]) => {
                    const n = undoneCounts[k] ?? 0;
                    const on = undoneFilters.includes(k);
                    const isAso = k === 'aso';
                    const cls = on
                      ? isAso
                        ? 'border-(--danger) bg-(--danger) font-semibold text-white'
                        : 'border-(--primary) bg-(--primary) font-semibold text-white'
                      : isAso && n > 0
                        ? 'border-(--danger) bg-(--card) font-semibold text-(--danger)'
                        : 'border-(--border) bg-(--card) text-(--text) hover:border-(--primary) hover:bg-(--row-hover)';
                    return (
                      <button
                        key={k}
                        className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${cls}`}
                        onClick={() => toggleFilter(k)}
                      >
                        {label} <span className="opacity-70">({n})</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {tab === 'archived' && (
                <div className="mb-1 flex shrink-0 flex-wrap items-center gap-2 text-xs">
                  <span className="text-(--text2)">Facility:</span>
                  <select
                    className="rounded border border-(--border) bg-(--card) px-2 py-1 text-(--text)"
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
                    className="rounded border border-(--border) bg-(--card) px-2 py-1 text-(--text)"
                    value={archFrom}
                    onChange={(e) => setArchFrom(e.target.value)}
                  />
                  <span className="text-(--text2)">to:</span>
                  <input
                    type="date"
                    className="rounded border border-(--border) bg-(--card) px-2 py-1 text-(--text)"
                    value={archTo}
                    onChange={(e) => setArchTo(e.target.value)}
                  />
                </div>
              )}
              <div className="min-h-0 flex-1">
                {tab === 'archived' && !archLoaded && (
                  <p className="p-4 text-(--text2)">Loading archived…</p>
                )}
                {!(tab === 'archived' && !archLoaded) && (
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
                )}
              </div>
              <p className="shrink-0 text-[11px] leading-tight text-(--text2)">
                {title} — {tab === 'archived' && !archLoaded ? '…' : shown.length} row(s)
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
              t.error ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-(--primary) bg-(--badge-bg) text-(--primary)'
            }`}
          >
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
