import { asoDue, type AsoMed, type RowDto } from '../types';

/**
 * ASO cell (v1 renderAsoCell): meds that must be stopped.
 * Due meds (not stopped, stopDate <= today) render red. Active rows get
 * inline name/date inputs + ✓ stop / × remove + "+ Add med"; archived rows
 * are read-only.
 */
export function AsoCell({
  row,
  onChange,
}: {
  row: RowDto;
  onChange: (row: RowDto, aso: AsoMed[]) => void;
}) {
  const meds = row.aso;
  const due = meds.filter(asoDue).length;
  const set = (idx: number, patch: Partial<AsoMed>) =>
    onChange(row, meds.map((m, i) => (i === idx ? { ...m, ...patch } : m)));

  return (
    <div className="min-w-[170px]">
      {due > 0 && (
        <div className="mb-1 inline-block rounded-full bg-red-600 px-2 text-[10px] font-bold text-white">
          ⚠ {due} due to stop
        </div>
      )}
      {!meds.length && <span className="italic text-(--text2)">—</span>}
      {meds.map((med, idx) => {
        const d = asoDue(med);
        return (
          <div key={med.id} className="mb-1">
            {row.archived ? (
              <>
                <div className={d ? 'font-bold text-red-600' : ''}>{med.name || '—'}</div>
                <div className="flex items-center gap-1 text-(--text2)">
                  <span>{med.stopDate || ''}</span>
                  {med.stopped ? <span className="text-green-700">✓ stopped</span> : <span>…</span>}
                </div>
              </>
            ) : (
              <>
                <input
                  className={`w-full rounded border px-1 py-0.5 text-xs ${
                    d ? 'border-red-400 font-bold text-red-600' : 'border-(--border)'
                  }`}
                  value={med.name}
                  placeholder="Med name"
                  onChange={(e) => set(idx, { name: e.target.value })}
                />
                <div className="mt-0.5 flex items-center gap-1 break-words">
                  <input
                    type="date"
                    className={`rounded border px-1 py-0.5 text-xs ${
                      d ? 'border-red-400' : 'border-(--border)'
                    }`}
                    value={med.stopDate}
                    onChange={(e) => set(idx, { stopDate: e.target.value })}
                  />
                  <button
                    className={`rounded border px-1.5 text-xs ${
                      med.stopped
                        ? 'border-green-600 bg-green-600 text-white'
                        : 'border-(--border) bg-white hover:bg-(--row-hover)'
                    }`}
                    title={med.stopped ? `Stopped ${med.stoppedAt || ''}` : 'Confirm stopped'}
                    onClick={() =>
                      set(idx, {
                        stopped: !med.stopped,
                        stoppedAt: !med.stopped ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
                      })
                    }
                  >
                    ✓
                  </button>
                  <button
                    className="rounded border border-(--border) bg-white px-1.5 text-xs hover:bg-red-50"
                    title="Remove"
                    onClick={() => onChange(row, meds.filter((_, i) => i !== idx))}
                  >
                    ×
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
      {!row.archived && (
        <button
          className="mt-1 text-xs text-(--primary) hover:underline"
          onClick={() =>
            onChange(row, [
              ...meds,
              {
                id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                name: '',
                stopDate: '',
                stopped: false,
                stoppedAt: null,
              },
            ])
          }
        >
          + Add med
        </button>
      )}
    </div>
  );
}
