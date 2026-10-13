import { useRef, useState } from 'react';

interface Props {
  value: string | null;
  onSave: (v: string) => void;
  className?: string;
}

/**
 * In-place editable cell (v1 startEditCell/commitEditCell): click to edit,
 * blur commits, Esc cancels. The cancel guard mirrors v1: an Esc must not be
 * re-committed by the blur that follows the re-render.
 */
export function EditableCell({ value, onSave, className = '' }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const cancelled = useRef(false);

  if (editing) {
    return (
      <textarea
        autoFocus
        className="min-h-[56px] w-full rounded border border-teal-400 p-1 text-xs"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (!cancelled.current) onSave(draft);
          cancelled.current = false;
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            cancelled.current = true;
            setEditing(false);
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.currentTarget.blur();
          }
        }}
      />
    );
  }
  return (
    <span
      className={`cursor-text whitespace-pre-wrap border-b border-dotted border-zinc-300 hover:border-teal-500 ${className}`}
      onClick={() => {
        setDraft(value || '');
        setEditing(true);
      }}
    >
      {value || <span className="text-zinc-300">+</span>}
    </span>
  );
}
