import { useEffect, useMemo, useState } from 'react';
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
import { CHECKLIST_LABELS, type RowDto } from '../types';

const col = createColumnHelper<RowDto>();

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

function ChecklistCell({ row }: { row: RowDto }) {
  return (
    <div className="flex flex-wrap gap-1">
      {CHECKLIST_LABELS.map(([key, label]) => {
        const ts = row.checklist[key] ?? null;
        return (
          <span
            key={key}
            title={ts ? `${key}: ${ts}` : `${key}: not done`}
            className={`rounded px-1 py-0.5 text-[10px] font-semibold ${
              ts ? 'bg-teal-100 text-teal-800' : 'bg-zinc-100 text-zinc-400'
            }`}
          >
            {label}
          </span>
        );
      })}
    </div>
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
                      {dir === 'asc' ? '▲' : dir === 'desc' ? '▼': '↕'}
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

interface Props {
  rows: RowDto[];
  /** 'nusin' gets the full column set; other facilities a reduced one. */
  facility: string;
  /** Archived tab shows a Facility column. */
  showFacility?: boolean;
}

export function PatientTable({ rows, facility, showFacility = false }: Props) {
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

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(columnSizing));
  }, [columnSizing, storageKey]);

  const columns = useMemo(() => {
    const full = facility === 'nusin';
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
            col.accessor((r) => r.diagnosis, { id: 'diagnosis', header: 'Diagnosis', size: 150 }),
            col.accessor((r) => r.operan, { id: 'operan', header: 'Operan', size: 150 }),
            col.accessor((r) => r.terapi, { id: 'terapi', header: 'Terapi', size: 150 }),
          ]
        : []),
      col.display({
        id: 'riwayat',
        header: 'Riwayat',
        size: 80,
        cell: (info) => {
          const n = info.row.original.dayCount - 1;
          return n > 0 ? <span className="text-xs text-teal-700">({n})</span> : null;
        },
      }),
      col.display({ id: 'checklist', header: 'Checklist', size: 230, cell: (info) => <ChecklistCell row={info.row.original} /> }),
      col.accessor((r) => r.pharmacistNote, {
        id: 'note',
        header: 'Note',
        size: 160,
        cell: (info) => <span className="whitespace-pre-wrap text-xs">{info.getValue() || ''}</span>,
      }),
    ];
  }, [facility, showFacility]);

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
            <tr key={row.id} className="border-b border-zinc-100 hover:bg-teal-50/40">
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="p-2 align-top">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
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
