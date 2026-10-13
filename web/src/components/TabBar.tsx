import { FACILITIES, type Tab } from '../types';

interface Props {
  tab: Tab;
  onChange: (t: Tab) => void;
  counts: Record<string, number>; // facility -> active count; 'archived' -> archived count
}

const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function TabBar({ tab, onChange, counts }: Props) {
  const cls = (t: Tab) =>
    `px-3 py-1.5 rounded-t border-b-2 text-sm font-medium ${
      tab === t
        ? 'border-teal-600 text-teal-800 bg-white'
        : 'border-transparent text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100'
    }`;
  return (
    <nav className="flex gap-1 border-b border-zinc-300">
      {FACILITIES.map((f) => (
        <button key={f} className={cls(f)} onClick={() => onChange(f)}>
          {label(f)} ({counts[f] ?? 0})
        </button>
      ))}
      <button className={cls('archived')} onClick={() => onChange('archived')}>
        Archived ({counts['archived'] ?? 0})
      </button>
      <button className={cls('rekap')} onClick={() => onChange('rekap')}>
        Rekap Checklist
      </button>
    </nav>
  );
}
