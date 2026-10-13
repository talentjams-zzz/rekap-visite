import { FACILITIES, type Tab } from '../types';

interface Props {
  tab: Tab;
  onChange: (t: Tab) => void;
  counts: Record<string, number>; // facility -> active count; 'archived' -> archived count
}

const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// V1 tabs (frozen look): white bar, 2px #ddd underline track, active tab =
// blue underline + blue text, hover = light blue.
export function TabBar({ tab, onChange, counts }: Props) {
  const cls = (t: Tab) =>
    `-mb-0.5 border-b-2 px-5 py-2.5 text-[13px] font-semibold transition-colors ${
      tab === t
        ? 'border-(--primary) text-(--primary)'
        : 'border-transparent text-(--text) hover:bg-(--row-hover)'
    }`;
  return (
    <nav className="flex shrink-0 overflow-x-auto border-b-2 border-(--border) bg-white">
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
