import { useRef, useState } from 'react';
import { uploadLab } from '../api';

interface Props {
  onUploaded: () => void;
  notify: (msg: string, error?: boolean) => void;
}

export function UploadBar({ onUploaded, notify }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const labRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [labBusy, setLabBusy] = useState(false);

  async function handle(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append('files', f);
      const r = await fetch('/api/uploads', { method: 'POST', body: fd });
      const j = (await r.json()) as {
        ok?: boolean;
        error?: string;
        files?: number;
        added?: number;
        merged?: number;
        skipped?: string[];
        warnings?: string[];
        sync?: { archived: number; unarchived: number };
      };
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      let msg = `Loaded ${j.files} file(s): +${j.added} new, ${j.merged} merged`;
      if (j.sync && (j.sync.archived || j.sync.unarchived)) {
        msg += ` · ${j.sync.archived} archived, ${j.sync.unarchived} returned to active`;
      }
      if (j.skipped?.length) msg += ` · skipped: ${j.skipped.join(', ')}`;
      notify(msg, (j.warnings?.length ?? 0) > 0);
      for (const w of j.warnings ?? []) notify(w, true);
      onUploaded();
    } catch (e) {
      notify(`Upload failed: ${(e as Error).message}`, true);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function handleLab(files: FileList | null) {
    if (!files?.length) return;
    setLabBusy(true);
    try {
      const j = await uploadLab(Array.from(files));
      let msg = `Loaded ${j.loaded} lab report(s)`;
      if (j.skipped.length) msg += ` · skipped: ${j.skipped.join(', ')}`;
      notify(msg, j.skipped.length > 0);
      onUploaded();
    } catch (e) {
      notify(`Lab upload failed: ${(e as Error).message}`, true);
    } finally {
      setLabBusy(false);
      if (labRef.current) labRef.current.value = '';
    }
  }

  return (
    <div className="mb-2">
      <input
        ref={inputRef}
        id="file-input"
        type="file"
        accept=".xlsx,.xls"
        multiple
        className="hidden"
        onChange={(e) => handle(e.target.files)}
      />
      <input
        ref={labRef}
        id="lab-input"
        type="file"
        accept=".xlsx,.xls"
        multiple
        className="hidden"
        onChange={(e) => handleLab(e.target.files)}
      />
      <label
        htmlFor="file-input"
        className="inline-block cursor-pointer rounded bg-(--primary) px-3 py-1.5 text-sm font-medium text-white hover:bg-(--primary-hover)"
      >
        {busy ? 'Loading…' : '📄 Load Excel Files'}
      </label>
      <label
        htmlFor="lab-input"
        className={`ml-2 inline-block cursor-pointer rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 ${
          labBusy ? 'opacity-60' : ''
        }`}
      >
        {labBusy ? 'Loading…' : '🧪 Load Lab Files'}
      </label>
      <span className="ml-2 text-xs text-(--text2)">
        registry: nusin/melati/sakura/observasi DD-M-YY.xlsx · handover: operan nusin DD-M-YY.xlsx · lab: lab-{'{'}MR{'}'}.xlsx
      </span>
    </div>
  );
}
