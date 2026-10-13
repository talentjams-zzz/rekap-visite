import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnSizingState,
  type SortingState,
  type Table,
} from '@tanstack/react-table';
import { fetchHistory, fetchLab } from '../api';
import {
  CHECKLIST_LABELS,
  type AsoMed,
  type EditableKey,
  type HistoryEntry,
  type LabReport,
  type RowDto,
} from '../types';
import { AsoCell } from './AsoCell';
import { EditableCell } from './EditableCell';
import { LabCell, LabPanel } from './LabCell';

const col = createColumnHelper<RowDto>();

interface Handlers {
  onToggleCheck: (row: RowDto, key: string) => void;
  onEditField: (row: RowDto, key: EditableKey, value: string) => void;
  onToggleArchive: (row: RowDto) => void;
  onAsoChange: (row: RowDto, aso: AsoMed[]) => void;
  notify: (msg: string, error?: boolean) => void;
}

/** Tgl Reg cell: date on line 1, time on line 2 (v1 style). */
function TglRegCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-slate-300">—</span>;
  const sp = value.indexOf(' ');
  const [d, t] = sp > 0 ? [value.slice(0, sp), value.slice(sp + 1)] : [value, ''];
  return (
    <div className="leading-tight">
      <div className="font-medium tabular-nums text-slate-700">{d}</div>
      {t && <div className="text-xs tabular-nums text-slate-400">{t}</div>}
    </div>
  );
}

/** Name cell: initials avatar + semibold name (the visual anchor of a row). */
function NameCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-slate-300">—</span>;
  const initials = (value || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-teal-400 to-teal-600 text-[10px] font-bold text-white shadow-sm">
        {initials}
      </span>
      <span className="truncate font-semibold text-slate-800">{value}</span>
    </div>
  );
}

function ChecklistCell({ row, onToggleCheck }: { row: RowDto; onToggleCheck: Handlers['onToggleCheck'] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {CHECKLIST_LABELS.map(([key, label]) => {
        const ts = row.checklist[key] ?? null;
        return (
          <button
            key={key}
            title={`${key}: ${ts ?? 'not done'} — click to ${ts ? 'clear' : 'check'}`}
            onClick={() => onToggleCheck(row, key)}
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold transition-colors hover:ring-1 hover:ring-teal-400 ${
              ts ? 'bg-teal-100 text-teal-800' : 'bg-slate-100 text-slate-400'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Riwayat badge: expands PAST days as rows in the SAME columns as today. */
function RiwayatBadge({
  row,
  open,
  onToggle,
}: {
  row: RowDto;
  open: boolean;
  onToggle: (row: RowDto) => void;
}) {
  const n = row.dayCount - 1;
  if (n <= 0) return null;
  return (
    <button
      className="ml-1 inline-flex items-center gap-0.5 whitespace-nowrap rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-700 ring-1 ring-teal-200 transition-colors hover:bg-teal-100"
      onClick={() => onToggle(row)}
    >
      {open ? '▲' : '▼'} Riwayat ({n})
    </button>
  );
}

/**
 * Riwayat rows: one REAL <tr> per PAST day (newest first), in the SAME
 * columns as the main table. With table-fixed each cell lands in its column,
 * so past days line up exactly under today's data and follow every column
 * resize (a separate nested table could not do that).
 */
function RiwayatRows({
  days,
  base,
  showFacility,
}: {
  days: HistoryEntry[];
  base: RowDto;
  showFacility: boolean;
}) {
  const cell =
    'overflow-hidden whitespace-pre-wrap border-b border-teal-100/70 px-2.5 py-2 align-top text-slate-500';
  return (
    <>
      {days.map((d) => (
        <tr key={d.date} className="bg-teal-50/40">
          <td className={`${cell} border-l-2 border-l-teal-300`}>{d.tglRegistrasi ?? ''}</td>
          <td className={cell}>
            <span className="mr-1.5 rounded-full bg-teal-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-teal-700">
              Riwayat
            </span>
            <span className="tabular-nums">{d.date}</span>
          </td>
          <td className={cell}>{base.mr}</td>
          {showFacility && <td className={cell}>{base.facility}</td>}
          <td className={cell}>{d.nama ?? ''}</td>
          <td className={cell}>{d.umur ?? ''}</td>
          <td className={cell}>{d.kamar ?? ''}</td>
          <td className={cell}>{d.bed ?? ''}</td>
          <td className={cell}>{d.dokter ?? ''}</td>
          <td className={cell}>{d.diagnosis ?? ''}</td>
          <td className={cell}>{d.operan ?? ''}</td>
          <td className={cell}>{d.terapi ?? ''}</td>
          <td className={cell} />
          <td className={cell} />
          <td className={cell} />
          <td className={cell} />
          <td className={cell}>{d.soap ?? ''}</td>
          <td className={cell} />
        </tr>
      ))}
    </>
  );
}

function Header({ table }: { table: Table<RowDto> }) {
  return (
    // The header row stays pinned to the top of the table's scroll box while
    // the rows scroll under it (the user's "slider on top" request).
    <tr className="text-left">
      {table.getHeaderGroups().map((hg) =>
        hg.headers.map((header) => {
          const canSort = header.column.getCanSort();
          const dir = header.column.getIsSorted();
          // The width MUST come from the column state — without it the
          // resize handler updates state that no element renders (the classic
          // "I can drag but nothing happens" bug).
          return (
            <th
              key={header.id}
              className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 p-0 select-none"
              style={{ width: header.getSize() }}
            >
              <div className="flex items-center gap-1 p-0">
                <button
                  className="flex-1 px-2.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500 transition-colors hover:text-slate-800 disabled:cursor-default"
                  disabled={!canSort}
                  onClick={header.column.getToggleSortingHandler()}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  {canSort && (
                    <span className={`ml-1 ${dir ? 'text-teal-600' : 'text-slate-300'}`}>
                      {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '↕'}
                    </span>
                  )}
                </button>
                {header.column.getCanResize() && (
                  // Wide, visible grip at the column's right edge — every column
                  // is resizable; drag it to size freely (persisted per tab).
                  <span
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    title="Drag to resize"
                    className="absolute right-0 top-0 h-full w-2 cursor-col-resize border-l border-slate-200 transition-colors hover:bg-teal-300/70"
                  />
                )}
              </div>
            </th>
          );
        }),
      )}
    </tr>
  );
}

interface Props extends Handlers {
  rows: RowDto[];
  /** 'nusin' gets the full column set; other facilities a reduced one. */
  facility: string;
  /** Archived tab shows a Facility column. */
  showFacility?: boolean;
}

export function PatientTable({ rows, facility: _facility, showFacility = false, ...handlers }: Props) {
  void _facility; // all facilities share the full column set (v1 COLS_SHORT === COLS_FULL)
  const storageKey = `rekap-col-widths-${showFacility ? 'archived' : _facility}`;
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || '{}') as ColumnSizingState;
    } catch {
      return {};
    }
  });
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'tglRegistrasi', desc: true },
  ]);
  const [expanded, setExpanded] = useState<{ id: string; days: HistoryEntry[] | null } | null>(null);
  const [labOpen, setLabOpen] = useState<{ mr: string; rep: LabReport | null; sig: string } | null>(null);

  const labSig = (r: RowDto) =>
    r.lab ? `${r.lab.maxDate}|${r.lab.testCount}|${r.lab.loadedAt}` : '';

  const toggleRiwayat = (row: RowDto) => {
    if (expanded?.id === row.id) {
      setExpanded(null);
      return;
    }
    setExpanded({ id: row.id, days: null });
    fetchHistory(row.id)
      .then((days) => setExpanded({ id: row.id, days }))
      .catch(() => {
        setExpanded(null);
        handlers.notify('Failed to load riwayat', true);
      });
  };

  const toggleLab = (row: RowDto) => {
    if (labOpen?.mr === row.mr) {
      setLabOpen(null);
      return;
    }
    if (!row.lab) return;
    const sig = labSig(row);
    setLabOpen({ mr: row.mr, rep: null, sig });
    fetchLab(row.mr)
      .then((rep) => {
        if (rep) setLabOpen({ mr: row.mr, rep, sig });
        else {
          setLabOpen(null);
          handlers.notify('No lab report found', true);
        }
      })
      .catch(() => {
        setLabOpen(null);
        handlers.notify('Failed to load lab report', true);
      });
  };

  // Keep an open panel in sync when the underlying report changes (e.g. an
  // upload on another device triggers an SSE reload) — v1 always re-rendered
  // the panel from current state.
  useEffect(() => {
    if (!labOpen) return;
    const cur = rows.find((r) => r.mr === labOpen.mr);
    if (!cur || !cur.lab || labSig(cur) === labOpen.sig) return;
    const sig = labSig(cur);
    setLabOpen({ mr: labOpen.mr, rep: null, sig });
    fetchLab(labOpen.mr)
      .then((rep) => {
        if (rep) setLabOpen((o) => (o && o.mr === labOpen.mr ? { mr: o.mr, rep, sig } : o));
      })
      .catch(() => setLabOpen(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(columnSizing));
  }, [columnSizing, storageKey]);

  // v1 (frozen): ALL facilities show the full column set (COLS_SHORT ===
  // COLS_FULL) — Diagnosis/Operan/Terapi are editable on every facility.
  const columns = useMemo(() => {
    return [
      col.accessor((r) => r.tglRegistrasi,
        { id: 'tglRegistrasi', header: 'Tgl Reg', size: 110, cell: (info) => <TglRegCell value={info.getValue()} /> }),
      // v1 places the Riwayat button INSIDE the Tgl Input cell, right by the
      // date (2nd column — visible without scrolling). A far-away unlabeled
      // badge column is how the team "lost" the feature.
      col.accessor((r) => r.dateAdded, {
        id: 'dateAdded',
        header: 'Tgl Input',
        size: 175,
        cell: (info) => {
          const row = info.row.original;
          return (
            <span className="flex flex-wrap items-center gap-x-1.5">
              <span>{row.dateAdded ?? ''}</span>
              <RiwayatBadge row={row} open={expanded?.id === row.id} onToggle={toggleRiwayat} />
            </span>
          );
        },
      }),
      col.accessor((r) => r.mr, { id: 'mr', header: 'MR', size: 90 }),
      ...(showFacility
        ? [col.accessor((r) => r.facility, { id: 'facility', header: 'Facility', size: 90 })]
        : []),
      col.accessor((r) => r.nama, {
        id: 'nama',
        header: 'Nama',
        size: 150,
        cell: (info) => <NameCell value={info.getValue()} />,
      }),
      col.accessor((r) => r.umur, { id: 'umur', header: 'Umur', size: 55 }),
      col.accessor((r) => r.kamar, { id: 'kamar', header: 'Kamar', size: 80 }),
      col.accessor((r) => r.bed, { id: 'bed', header: 'Bed', size: 50 }),
      col.accessor((r) => r.dokter, { id: 'dokter', header: 'Dokter', size: 130 }),
      col.accessor((r) => r.diagnosis, {
        id: 'diagnosis',
        header: 'Diagnosis',
        size: 150,
        cell: (info) => (
          <EditableCell
            value={info.getValue()}
            onSave={(v) => handlers.onEditField(info.row.original, 'diagnosis', v)}
          />
        ),
      }),
      col.accessor((r) => r.operan, {
        id: 'operan',
        header: 'Operan',
        size: 150,
        cell: (info) => (
          <EditableCell
            value={info.getValue()}
            onSave={(v) => handlers.onEditField(info.row.original, 'operan', v)}
          />
        ),
      }),
      col.accessor((r) => r.terapi, {
        id: 'terapi',
        header: 'Terapi',
        size: 150,
        cell: (info) => (
          <EditableCell
            value={info.getValue()}
            onSave={(v) => handlers.onEditField(info.row.original, 'terapi', v)}
          />
        ),
      }),
      col.display({
        id: 'hasilLab',
        header: 'Hasil Lab',
        size: 180,
        cell: (info) => (
          <LabCell
            row={info.row.original}
            open={labOpen?.mr === info.row.original.mr}
            onToggle={toggleLab}
          />
        ),
      }),
      col.display({
        id: 'aso',
        header: 'ASO',
        size: 180,
        cell: (info) => (
          <AsoCell row={info.row.original} onChange={handlers.onAsoChange} />
        ),
      }),
      col.display({
        id: 'checklist',
        header: 'Checklist',
        size: 230,
        cell: (info) => <ChecklistCell row={info.row.original} onToggleCheck={handlers.onToggleCheck} />,
      }),
      col.accessor((r) => r.pharmacistNote, {
        id: 'note',
        header: 'Note',
        size: 160,
        cell: (info) => (
          <EditableCell
            value={info.getValue()}
            className="text-xs"
            onSave={(v) => handlers.onEditField(info.row.original, 'pharmacistNote', v)}
          />
        ),
      }),
      // SOAP: free text, resets to blank on the next day; the previous day's
      // value moves to Riwayat automatically (per-day snapshot).
      col.accessor((r) => r.soap, {
        id: 'soap',
        header: 'SOAP',
        size: 160,
        cell: (info) => (
          <EditableCell
            value={info.getValue() ?? ''}
            className="text-xs"
            onSave={(v) => handlers.onEditField(info.row.original, 'soap', v)}
          />
        ),
      }),
      col.display({
        id: 'actions',
        header: '',
        size: 70,
        cell: (info) => {
          const r = info.row.original;
          return (
            <button
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-500 shadow-sm transition-colors hover:bg-slate-100 hover:text-slate-800"
              onClick={() => handlers.onToggleArchive(r)}
            >
              {r.archived ? '↩' : '🗄'}
            </button>
          );
        },
      }),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFacility, expanded?.id, labOpen?.mr, handlers.onToggleCheck, handlers.onEditField, handlers.onToggleArchive, handlers.onAsoChange, handlers.notify]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnSizing },
    onSortingChange: setSorting,
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableColumnResizing: true,
  });

  return (
    // The wrapper is the scroll box (both axes) — h-full inside the app's
    // flex column. overflow-x-auto alone would make the sticky header inert.
    <div className="h-full overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* table-fixed: column widths are exactly what the user resizes them to
          (auto layout let long content push resized columns back out). No
          w-full: the table is exactly the sum of its (resizable) columns, so
          resizing is not squished back; the wrapper scrolls both axes.
          border-separate (not collapse) keeps the sticky header's border
          pinned to the header row while rows scroll under it. */}
      <table
        className="table-fixed border-separate border-spacing-0 text-sm tabular-nums"
        style={{ width: table.getTotalSize() }}
      >
        <thead>
          <Header table={table} />
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <Fragment key={row.id}>
              <tr className="transition-colors hover:bg-teal-50/70">
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className="overflow-hidden border-b border-slate-100 px-2.5 py-2 align-top text-slate-700"
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
              {expanded?.id === row.original.id &&
                (expanded.days ? (
                  <RiwayatRows days={expanded.days} base={row.original} showFacility={showFacility} />
                ) : (
                  <tr className="bg-teal-50/30">
                    <td colSpan={columns.length} className="p-2 text-xs text-zinc-400">
                      Loading riwayat…
                    </td>
                  </tr>
                ))}
              {labOpen?.mr === row.original.mr && row.original.lab && (
                <tr className="bg-slate-50">
                  <td colSpan={columns.length} className="p-2">
                    {labOpen.rep ? (
                      <LabPanel row={row.original} rep={labOpen.rep} notify={handlers.notify} />
                    ) : (
                      <div className="text-xs text-zinc-400">Loading lab…</div>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-6 py-16 text-center">
                <div className="text-3xl">🗂️</div>
                <p className="mt-2 text-sm font-medium text-slate-500">No patients</p>
                <p className="text-xs text-slate-400">Upload a daily report to get started.</p>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
