import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnSizingState,
  type Row,
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

/** Tgl Reg cell: date on line 1, time on line 2 (v1: 10px time in --text2). */
function TglRegCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-(--border)">—</span>;
  const sp = value.indexOf(' ');
  const [d, t] = sp > 0 ? [value.slice(0, sp), value.slice(sp + 1)] : [value, ''];
  return (
    <div className="leading-tight">
      <div className="tabular-nums text-(--text)">{d}</div>
      {t && <div className="text-[10px] tabular-nums text-(--text2)">{t}</div>}
    </div>
  );
}

/** Name cell: semibold name (v1 name-col; avatar removed at the user's request). */
function NameCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-(--border)">—</span>;
  return <span className="font-semibold text-(--text)">{value}</span>;
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
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
              ts ? 'bg-(--check-done) text-(--success)' : 'bg-[#eee] text-(--text2)'
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
    // V1 .btn-history: blue border, #eef2ff fill, inverts on hover.
    <button
      className="ml-1.5 whitespace-nowrap rounded border border-(--primary) bg-[#eef2ff] px-2 py-0.5 text-[10px] font-medium text-(--primary) transition-colors hover:bg-(--primary) hover:text-white"
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
  // V1 history rows: #f8fafc background, blue date accent.
  const cell =
    'overflow-hidden whitespace-pre-wrap border-b border-[#e2e8f0] px-1.5 py-1.5 align-top text-(--text2)';
  return (
    <>
      {days.map((d) => (
        <tr key={d.date} className="bg-[#f8fafc]">
          <td className={`${cell} border-l-2 border-l-(--primary)`}>{d.tglRegistrasi ?? ''}</td>
          <td className={cell}>
            <span className="mr-1.5 rounded bg-[#eef2ff] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-(--primary)">
              Riwayat
            </span>
            <span className="tabular-nums font-bold text-(--primary)">{d.date}</span>
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

function Header({
  table,
  onResizeStart,
}: {
  table: Table<RowDto>;
  onResizeStart: (e: React.MouseEvent, colId: string) => void;
}) {
  return (
    // The header row stays pinned to the top of the table's scroll box while
    // the rows scroll under it. V1 header look: dark #334155, white 11px.
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
              // box-shadow (not border-b) for the header's bottom edge: with
              // border-collapse the border would scroll away from the sticky
              // th; the shadow is painted per element and sticks with it.
              className="sticky top-0 z-10 border-r border-white/10 bg-(--thead) p-0 select-none shadow-[inset_0_-1px_0_#ddd] transition-colors hover:bg-[#475569]"
              style={{ width: header.getSize() }}
            >
              <div className="relative flex items-center gap-1 p-0">
                <button
                  className="flex-1 truncate px-1.5 py-2 text-left text-[11px] font-semibold text-white disabled:cursor-default"
                  disabled={!canSort}
                  onClick={header.column.getToggleSortingHandler()}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  {canSort && (
                    <span className={`ml-1 text-[10px] ${dir ? 'text-white' : 'text-white/50'}`}>
                      {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '↕'}
                    </span>
                  )}
                </button>
                {header.column.getCanResize() && (
                  // V1 grip: 6px at the column's right edge, white/35 on hover.
                  <span
                    onMouseDown={(e) => onResizeStart(e, header.column.id)}
                    title="Drag to resize"
                    className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-white/35"
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

/**
 * One body row (data + optional riwayat rows + optional lab panel).
 * Memoized by row DATA identity: during a live column drag the table
 * instance (and every TanStack row wrapper) changes on each mousemove, but
 * the row data does not — so React skips the 300+ row re-renders and only
 * updates the 17 header widths; table-fixed then reflows the body natively.
 * Without this, a drag over the 316-row Archived tab cost ~95ms per frame.
 */
const BodyRow = memo(
  function BodyRow({
    row,
    showFacility,
    expanded,
    labOpen,
    handlers,
    colCount,
  }: {
    row: Row<RowDto>;
    showFacility: boolean;
    expanded: { id: string; days: HistoryEntry[] | null } | null;
    labOpen: { mr: string; rep: LabReport | null; sig: string } | null;
    handlers: Handlers;
    colCount: number;
  }) {
    return (
      <Fragment>
        <tr className="transition-colors hover:bg-(--row-hover)">
          {row.getVisibleCells().map((cell) => (
            <td
              key={cell.id}
              className="overflow-hidden border-b border-(--border) px-1.5 py-1.5 align-top text-(--text)"
            >
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </td>
          ))}
        </tr>
        {expanded?.id === row.original.id &&
          (expanded.days ? (
            <RiwayatRows days={expanded.days} base={row.original} showFacility={showFacility} />
          ) : (
            <tr className="bg-[#f8fafc]">
              <td colSpan={colCount} className="p-2 text-xs text-(--text2)">
                Loading riwayat…
              </td>
            </tr>
          ))}
        {labOpen?.mr === row.original.mr && row.original.lab && (
          <tr className="bg-[#f8fafc]">
            <td colSpan={colCount} className="p-2">
              {labOpen.rep ? (
                <LabPanel row={row.original} rep={labOpen.rep} notify={handlers.notify} />
              ) : (
                <div className="text-xs text-(--text2)">Loading lab…</div>
              )}
            </td>
          </tr>
        )}
      </Fragment>
    );
  },
  (prev, next) =>
    prev.row.original === next.row.original &&
    prev.showFacility === next.showFacility &&
    prev.expanded === next.expanded &&
    prev.labOpen === next.labOpen &&
    prev.handlers === next.handlers &&
    prev.colCount === next.colCount,
);

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
      col.accessor((r) => r.mr, {
        id: 'mr',
        header: 'MR',
        size: 90,
        cell: (info) => <span className="font-semibold tabular-nums">{info.getValue()}</span>,
      }),
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
            className="text-[11px]"
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
            className="text-[11px]"
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
            className="text-[11px]"
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
            // V1: archive = red outline on #fef2f2, unarchive = green on #f0fdf4.
            <button
              className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                r.archived
                  ? 'border-(--success) bg-[#f0fdf4] text-(--success) hover:bg-[#dcfce7]'
                  : 'border-(--danger) bg-(--archive-bg) text-(--danger) hover:bg-[#fee2e2]'
              }`}
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
    // Resizing state lives in columnSizing (persisted), but the DRAG itself
    // is handled below with direct DOM writes — see startColResize.
    enableColumnResizing: true,
  });
  const tableRef = useRef<Table<RowDto> | null>(null);
  tableRef.current = table;

  // ── Column resize — V1's approach, verbatim in spirit ─────────────────
  // During the drag we write the new width straight to the <th> (and keep
  // the table's total width in sync) with NO React state update and NO
  // re-render per mousemove. That is exactly why V1's resize feels instant
  // while V2's stuttered: every framework re-render per frame cost 15-90ms.
  // React's columnSizing state is committed exactly once, on release.
  const dragRef = useRef<{
    colId: string;
    th: HTMLElement;
    tableEl: HTMLTableElement;
    startX: number;
    startWidth: number;
    lastWidth: number;
    onMove: (e: MouseEvent) => void;
    onUp: () => void;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  const startColResize = (e: React.MouseEvent, colId: string) => {
    const th = (e.currentTarget as HTMLElement).closest('th');
    const tableEl = th?.closest('table');
    if (!th || !tableEl) return;
    e.preventDefault();
    const startWidth = (th as HTMLElement).offsetWidth;
    const d = {
      colId,
      th: th as HTMLElement,
      tableEl: tableEl as HTMLTableElement,
      startX: e.clientX,
      startWidth,
      lastWidth: startWidth,
      onMove: (_e: MouseEvent) => {},
      onUp: () => {},
    };
    d.onMove = (ev: MouseEvent) => {
      let w = d.startWidth + (ev.clientX - d.startX);
      if (w < 40) w = 40; // V1's minimum column width
      d.lastWidth = w;
      d.th.style.width = `${w}px`;
      let total = 0;
      d.tableEl.querySelectorAll('thead th').forEach((c) => {
        total += (c as HTMLElement).offsetWidth;
      });
      d.tableEl.style.width = `${total}px`;
    };
    d.onUp = () => {
      document.removeEventListener('mousemove', d.onMove);
      document.removeEventListener('mouseup', d.onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      tableRef.current?.setColumnSizing({ [d.colId]: d.lastWidth });
      dragRef.current = null;
      setDragging(false);
    };
    dragRef.current = d;
    document.addEventListener('mousemove', d.onMove);
    document.addEventListener('mouseup', d.onUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    setDragging(true);
  };

  // Lost-mouseup safety net: if the drag is released OUTSIDE the browser
  // window (taskbar / second monitor), the mouseup never reaches document.
  // When the cursor leaves the page or the window blurs, commit the drag at
  // the last width instead of leaving it armed for the next click.
  useEffect(() => {
    if (!dragging) return;
    const finish = () => dragRef.current?.onUp();
    const onOut = (e: MouseEvent) => {
      if (!e.relatedTarget) finish();
    };
    window.addEventListener('blur', finish);
    document.addEventListener('mouseout', onOut);
    return () => {
      window.removeEventListener('blur', finish);
      document.removeEventListener('mouseout', onOut);
    };
  }, [dragging]);

  return (
    // The wrapper is the scroll box (both axes) — h-full inside the app's
    // flex column. overflow-x-auto alone would make the sticky header inert.
    <div className="h-full overflow-auto border border-(--border) bg-white">
      {/* table-fixed: column widths are exactly what the user resizes them to
          (auto layout let long content push resized columns back out). No
          w-full: the table is exactly the sum of its (resizable) columns, so
          resizing is not squished back; the wrapper scrolls both axes.
          border-collapse = V1's layout mode: measurably cheaper per-frame
          reflow than border-separate on 300-row tables. */}
      <table
        // text-[12px] = v1's table font size (frozen contract).
        className="table-fixed border-collapse text-[12px] tabular-nums text-(--text)"
        style={{ width: table.getTotalSize() }}
      >
        <thead>
          <Header table={table} onResizeStart={startColResize} />
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <BodyRow
              key={row.id}
              row={row}
              showFacility={showFacility}
              expanded={expanded}
              labOpen={labOpen}
              handlers={handlers}
              colCount={columns.length}
            />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-6 py-16 text-center">
                <div className="text-3xl">🗂️</div>
                <p className="mt-2 text-sm font-medium text-(--text2)">No patients</p>
                <p className="text-xs text-(--text2)">Upload a daily report to get started.</p>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
