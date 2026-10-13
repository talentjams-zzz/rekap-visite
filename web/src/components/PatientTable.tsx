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
import { fetchHistory } from '../api';
import {
  CHECKLIST_LABELS,
  type EditableKey,
  type HistoryEntry,
  type RowDto,
} from '../types';
import { EditableCell } from './EditableCell';

const col = createColumnHelper<RowDto>();

interface Handlers {
  onToggleCheck: (row: RowDto, key: string) => void;
  onEditField: (row: RowDto, key: EditableKey, value: string) => void;
  onToggleArchive: (row: RowDto) => void;
  notify: (msg: string, error?: boolean) => void;
}

/** Tgl Reg cell: date on line 1, time on line 2 (v1 style). */
function TglRegCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-zinc-400">—</span>;
  const sp = value.indexOf(' ');
  const [d, t] = sp > 0 ? [value.slice(0, sp), value.slice(sp + 1)] : [value, ''];
  return (
    <div className="leading-tight">
      <div>{d}</div>
      {t && <div className="text-xs text-zinc-400">{t}</div>}
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
            className={`rounded px-1 py-0.5 text-[10px] font-semibold hover:ring-1 hover:ring-teal-400 ${
              ts ? 'bg-teal-100 text-teal-800' : 'bg-zinc-100 text-zinc-400'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

const HISTORY_COLS: [keyof HistoryEntry, string][] = [
  ['date', 'Tgl'],
  ['tglRegistrasi', 'Tgl Reg'],
  ['nama', 'Nama'],
  ['umur', 'Umur'],
  ['kamar', 'Kamar'],
  ['bed', 'Bed'],
  ['dokter', 'Dokter'],
  ['diagnosis', 'Diagnosis'],
  ['operan', 'Operan'],
  ['terapi', 'Terapi'],
];

/** Riwayat badge: expands an inline table of PAST days (fetched on demand). */
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
    <button className="text-xs text-teal-700 hover:underline" onClick={() => onToggle(row)}>
      {open ? '▲' : '▼'} ({n})
    </button>
  );
}

/** Inline riwayat table: one row per PAST day (newest first). */
function RiwayatTable({ days }: { days: HistoryEntry[] }) {
  return (
    <table className="mt-1 w-full border-collapse text-xs">
      <thead>
        <tr className="bg-zinc-100 text-left text-[10px] uppercase text-zinc-500">
          {HISTORY_COLS.map(([k, label]) => (
            <th key={k} className="p-1">
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {days.map((d) => (
          <tr key={d.date} className="border-t border-zinc-100">
            {HISTORY_COLS.map(([k]) => (
              <td key={k} className="p-1 whitespace-pre-wrap">
                {d[k] ?? ''}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Header({ table }: { table: Table<RowDto> }) {
  return (
    <tr className="border-b border-zinc-300 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-600">
      {table.getHeaderGroups().map((hg) =>
        hg.headers.map((header) => {
          const canSort = header.column.getCanSort();
          const dir = header.column.getIsSorted();
          return (
            <th key={header.id} className="relative p-0 select-none">
              <div className="flex items-center gap-1 p-2">
                <button
                  className="flex-1 text-left disabled:cursor-default"
                  disabled={!canSort}
                  onClick={header.column.getToggleSortingHandler()}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  {canSort && (
                    <span className="ml-1 text-zinc-400">
                      {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '↕'}
                    </span>
                  )}
                </button>
                {header.column.getCanResize() && (
                  <span
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize bg-zinc-200 hover:bg-teal-400"
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

export function PatientTable({ rows, facility, showFacility = false, ...handlers }: Props) {
  const storageKey = `rekap-col-widths-${showFacility ? 'archived' : facility}`;
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

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(columnSizing));
  }, [columnSizing, storageKey]);

  const full = facility === 'nusin';

  const columns = useMemo(() => {
    return [
      col.accessor((r) => r.tglRegistrasi,
        { id: 'tglRegistrasi', header: 'Tgl Reg', size: 110, cell: (info) => <TglRegCell value={info.getValue()} /> }),
      col.accessor((r) => r.dateAdded, { id: 'dateAdded', header: 'Tgl Input', size: 95 }),
      col.accessor((r) => r.mr, { id: 'mr', header: 'MR', size: 90 }),
      ...(showFacility
        ? [col.accessor((r) => r.facility, { id: 'facility', header: 'Facility', size: 90 })]
        : []),
      col.accessor((r) => r.nama, { id: 'nama', header: 'Nama', size: 140 }),
      col.accessor((r) => r.umur, { id: 'umur', header: 'Umur', size: 55 }),
      col.accessor((r) => r.kamar, { id: 'kamar', header: 'Kamar', size: 80 }),
      col.accessor((r) => r.bed, { id: 'bed', header: 'Bed', size: 50 }),
      col.accessor((r) => r.dokter, { id: 'dokter', header: 'Dokter', size: 130 }),
      ...(full
        ? [
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
          ]
        : []),
      col.display({
        id: 'riwayat',
        header: 'Riwayat',
        size: 80,
        cell: (info) => (
          <RiwayatBadge
            row={info.row.original}
            open={expanded?.id === info.row.original.id}
            onToggle={toggleRiwayat}
          />
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
      col.display({
        id: 'actions',
        header: '',
        size: 70,
        cell: (info) => {
          const r = info.row.original;
          return (
            <button
              className="rounded border border-zinc-300 px-1.5 py-0.5 text-xs hover:bg-zinc-100"
              onClick={() => handlers.onToggleArchive(r)}
            >
              {r.archived ? '↩' : '🗄'}
            </button>
          );
        },
      }),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facility, showFacility, expanded?.id, handlers.onToggleCheck, handlers.onEditField, handlers.onToggleArchive, handlers.notify]);

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
    <div className="overflow-x-auto rounded-b border border-t-0 border-zinc-300 bg-white">
      <table className="w-full border-collapse text-sm">
        <thead>
          <Header table={table} />
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <Fragment key={row.id}>
              <tr className="border-b border-zinc-100 hover:bg-teal-50/40">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="p-2 align-top">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
              {expanded?.id === row.original.id && (
                <tr className="bg-teal-50/30">
                  <td colSpan={columns.length} className="p-2">
                    <div className="text-[10px] uppercase text-zinc-400">Riwayat (past days)</div>
                    {expanded.days ? (
                      <RiwayatTable days={expanded.days} />
                    ) : (
                      <div className="text-xs text-zinc-400">Loading…</div>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="p-6 text-center text-zinc-400">
                No patients.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
