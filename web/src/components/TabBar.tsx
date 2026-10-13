import { FACILITIES, type Tab } from '../types';

interface Props {
  tab: Tab;
  onChange: (t: Tab) => void;
  counts: Record<string, number>; // facility -> active count; 'archived' -> archived count
}

const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function TabBar({ tab, onChange, counts }: Props) {
  const cls = (t: Tab) =>
    `rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
      tab === t
        ? 'bg-white text-teal-700 shadow-sm ring-1 ring-slate-200'
        : 'text-slate-500 hover:text-slate-800'
    }`;
  const count = (t: Tab) => {
    const c = counts[t] ?? 0;
    return (
      <span
        className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
          tab === t ? 'bg-teal-100 text-teal-700' : 'bg-slate-200/80 text-slate-500'
        }`}
      >
        {c}
      </span>
    );
  };
  return (
    <nav className="flex shrink-0 flex-wrap items-center gap-1 rounded-xl bg-slate-200/70 p-1">
      {FACILITIES.map((f) => (
        <button key={f} className={cls(f)} onClick={() => onChange(f)}>
          {label(f)}
          {count(f)}
        </button>
      ))}
      <button className={cls('archived')} onClick={() => onChange('archived')}>
        Archived
        {count('archived')}
      </button>
      <button className={cls('rekap')} onClick={() => onChange('rekap')}>
        Rekap Checklist
      </button>
    </nav>
  );
}
