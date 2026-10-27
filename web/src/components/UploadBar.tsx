import { useRef, useState } from 'react';
import {
  uploadLab,
  uploadRegistry,
  UploadError,
  type LabUploadResult,
  type RegistryUploadResult,
} from '../api';

interface Props {
  onUploaded: () => void;
  notify: (msg: string, error?: boolean) => void;
  /** Rendered inside the dark title bar: V1 topbar button style, no hint. */
  inHeader?: boolean;
}

// One request carries at most this many files (v2.1, loading guide Phase 2):
// bounded memory on the server, bounded write-back cost, predictable
// progress. Batches run SEQUENTIALLY — no concurrent SQLite writes, no
// concurrent full write-backs. A failed batch is reported and the rest
// continue.
const BATCH_SIZE = 5;

export function UploadBar({ onUploaded, notify, inHeader = false }: Props) {
  const btn = inHeader
    ? 'cursor-pointer rounded-md border border-white/30 bg-white/10 px-2.5 py-1 text-[12px] text-white transition-colors hover:bg-white/25'
    : 'cursor-pointer rounded bg-(--primary) px-2.5 py-1 text-[13px] font-medium text-white hover:bg-(--primary-hover)';
  const btn2 = inHeader
    ? 'ml-2 cursor-pointer rounded-md border border-white/30 bg-white/10 px-2.5 py-1 text-[12px] text-white transition-colors hover:bg-white/25'
    : 'ml-2 cursor-pointer rounded bg-indigo-600 px-2.5 py-1 text-[13px] font-medium text-white hover:bg-indigo-700';
  const inputRef = useRef<HTMLInputElement>(null);
  const labRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null); // progress label or null
  const [labBusy, setLabBusy] = useState<string | null>(null);

  async function handle(files: FileList | null) {
    if (!files?.length) return;
    const all = Array.from(files);
    setBusy(`${all.length}/${all.length}…`);
    let parsed = 0;
    let added = 0;
    let merged = 0;
    let readmissions = 0;
    const skipped: string[] = [];
    const failed: string[] = [];
    const warnings: string[] = [];
    const t0 = Date.now();
    try {
      for (let i = 0; i < all.length; i += BATCH_SIZE) {
        const batch = all.slice(i, i + BATCH_SIZE);
        setBusy(`${Math.min(i + BATCH_SIZE, all.length)}/${all.length}…`);
        try {
          const j: RegistryUploadResult = await uploadRegistry(batch);
          parsed += j.files;
          added += j.added;
          merged += j.merged;
          readmissions += j.readmissions ?? 0;
          skipped.push(...(j.skipped ?? []));
          failed.push(...(j.failed ?? []).map((f) => `${f.filename}: ${f.message}`));
          warnings.push(...(j.warnings ?? []));
        } catch (e) {
          // Request-level failure (multipart limit, timeout, network):
          // record the batch and continue with the remaining files.
          const msg = e instanceof UploadError ? e.message : `HTTP error (${(e as Error).message})`;
          failed.push(`${batch.map((b) => b.name).join(', ')} — ${msg}`);
        }
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      let msg = `Loaded ${parsed} file(s): +${added} new, ${merged} merged`;
      if (readmissions > 0) msg += ` · ${readmissions} readmission(s) reset`;
      if (skipped.length) msg += ` · skipped: ${skipped.join(', ')}`;
      if (failed.length) msg += ` · FAILED: ${failed.join(' · ')}`;
      msg += ` (${secs}s)`;
      notify(msg, failed.length > 0 || warnings.length > 0);
      for (const w of warnings) notify(w, true);
      if (parsed > 0) onUploaded();
    } finally {
      setBusy(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function handleLab(files: FileList | null) {
    if (!files?.length) return;
    const all = Array.from(files);
    setLabBusy(`${all.length}/${all.length}…`);
    let loaded = 0;
    let duplicates = 0;
    const skipped: string[] = [];
    const failed: string[] = [];
    const t0 = Date.now();
    try {
      for (let i = 0; i < all.length; i += BATCH_SIZE) {
        const batch = all.slice(i, i + BATCH_SIZE);
        setLabBusy(`${Math.min(i + BATCH_SIZE, all.length)}/${all.length}…`);
        try {
          const j: LabUploadResult = await uploadLab(batch);
          loaded += j.loaded;
          duplicates += (j.duplicates ?? []).length;
          skipped.push(...(j.skipped ?? []));
          failed.push(...(j.failed ?? []).map((f) => f.message));
        } catch (e) {
          const msg = e instanceof UploadError ? e.message : `HTTP error (${(e as Error).message})`;
          failed.push(`${batch.map((b) => b.name).join(', ')} — ${msg}`);
        }
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      let msg = `Lab files: ${loaded} loaded`;
      if (duplicates) msg += `, ${duplicates} duplicate(s) ignored`;
      if (skipped.length) msg += ` · skipped: ${skipped.join(', ')}`;
      if (failed.length) msg += ` · FAILED: ${failed.join(' · ')}`;
      msg += ` (${secs}s)`;
      notify(msg, skipped.length > 0 || failed.length > 0);
      if (loaded > 0) onUploaded();
    } finally {
      setLabBusy(null);
      if (labRef.current) labRef.current.value = '';
    }
  }

  return (
    <div className={inHeader ? 'flex items-center' : 'mb-1'}>
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
      <label htmlFor="file-input" className={`${btn} ${busy ? 'opacity-60' : ''}`}>
        {busy ? `📄 ${busy}` : '📄 Load Excel Files'}
      </label>
      <label htmlFor="lab-input" className={`${btn2} ${labBusy ? 'opacity-60' : ''}`}>
        {labBusy ? `🧪 ${labBusy}` : '🧪 Load Lab Files'}
      </label>
      {!inHeader && (
        <span className="ml-2 text-xs text-(--text2)">
          registry: nusin/melati/sakura/observasi DD-M-YY.xlsx · handover: operan nusin DD-M-YY.xlsx · lab: lab-{'{'}MR{'}'}.xlsx
        </span>
      )}
    </div>
  );
}
