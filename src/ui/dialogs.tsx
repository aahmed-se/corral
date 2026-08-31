import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Compass, Download, FileJson2, FileUp, Folder, FolderPlus, X } from 'lucide-react';
import { FOLDER_SEPARATOR, type FolderCount } from '../lib/db.ts';
import { countLabel } from './use-corral.ts';

function Dialog({ title, subtitle, onClose, children }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      ref={backdropRef}
      className="dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === backdropRef.current) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header className="dialog-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="dialog-close" aria-label="Close" onClick={onClose}><X /></button>
        </header>
        {children}
      </div>
    </div>
  );
}

/** Destination picker used by Move, drag-to-new, and Corral: filter existing
 * folders or mint a new path. */
export function FolderPickerDialog({ title, subtitle, folders, suggested, confirmLabel, onConfirm, onClose }: {
  title: string;
  subtitle?: string;
  folders: FolderCount[];
  suggested?: string;
  confirmLabel: string;
  onConfirm: (destination: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(suggested ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const needle = value.trim().toLowerCase();
  const matches = useMemo(() => {
    const sorted = [...folders].sort((left, right) => right.count - left.count);
    const filtered = needle ? sorted.filter(({ folder }) => folder.toLowerCase().includes(needle)) : sorted;
    return filtered.slice(0, 8);
  }, [folders, needle]);
  const exactExists = folders.some(({ folder }) => folder === value.trim());

  const submit = (destination: string) => {
    const trimmed = destination.trim();
    if (!trimmed) return;
    onClose();
    onConfirm(trimmed);
  };

  return (
    <Dialog title={title} subtitle={subtitle} onClose={onClose}>
      <form
        className="picker"
        onSubmit={(event) => {
          event.preventDefault();
          submit(value);
        }}
      >
        <input
          ref={inputRef}
          className="picker-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={`Folder path, e.g. Reading${FOLDER_SEPARATOR}Research`}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="picker-options" role="listbox">
          {matches.map(({ folder, count }) => (
            <button type="button" key={folder} className="picker-option" onClick={() => submit(folder)}>
              <Folder />
              <span className="picker-path" title={folder}>{folder}</span>
              <span className="picker-count">{count.toLocaleString()}</span>
            </button>
          ))}
          {value.trim() && !exactExists && (
            <button type="button" className="picker-option create" onClick={() => submit(value)}>
              <FolderPlus />
              <span className="picker-path">Create “{value.trim()}”</span>
            </button>
          )}
          {matches.length === 0 && !value.trim() && <p className="picker-empty">Type to filter folders or name a new one.</p>}
        </div>
        <footer className="dialog-footer">
          <button type="button" className="button ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="button primary" disabled={!value.trim()}>{confirmLabel}</button>
        </footer>
      </form>
    </Dialog>
  );
}

/** Single-field dialog for naming things: new folders, renames. */
export function NameDialog({ title, subtitle, initial, placeholder, confirmLabel, onSubmit, onClose }: {
  title: string;
  subtitle?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <Dialog title={title} subtitle={subtitle} onClose={onClose}>
      <form
        className="picker"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = value.trim();
          if (!trimmed) return;
          onClose();
          onSubmit(trimmed);
        }}
      >
        <input
          ref={inputRef}
          className="picker-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
        />
        <footer className="dialog-footer">
          <button type="button" className="button ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="button primary" disabled={!value.trim()}>{confirmLabel}</button>
        </footer>
      </form>
    </Dialog>
  );
}

/** Yes/no gate for destructive bulk actions. */
export function ConfirmDialog({ title, body, confirmLabel, danger, onConfirm, onClose }: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="confirm-body">{body}</p>
      <footer className="dialog-footer">
        <button type="button" className="button ghost" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className={`button ${danger ? 'danger' : 'primary'}`}
          autoFocus
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
      </footer>
    </Dialog>
  );
}

export function ImportDialog({ canUseChrome, busy, onChrome, onFile, onClose }: {
  canUseChrome: boolean;
  busy: boolean;
  onChrome: () => void;
  onFile: (file: File) => void;
  onClose: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog title="Bring bookmarks in" subtitle="Parsed and stored on this device — nothing is uploaded." onClose={onClose}>
      <div className="choice-list">
        <button
          className="choice"
          disabled={!canUseChrome || busy}
          onClick={() => {
            onClose();
            onChrome();
          }}
        >
          <span className="choice-icon"><Compass /></span>
          <span>
            <strong>Copy from Chrome</strong>
            <small>{canUseChrome ? 'Snapshots the live bookmark tree. Chrome itself is never modified.' : 'Available when Corral runs as a Chrome extension.'}</small>
          </span>
        </button>
        <button className="choice" disabled={busy} onClick={() => fileRef.current?.click()}>
          <span className="choice-icon"><FileUp /></span>
          <span>
            <strong>Import a file</strong>
            <small>Chrome/Firefox/Netscape HTML export, or a Corral JSON backup.</small>
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".html,.htm,.json,text/html,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) {
              onClose();
              onFile(file);
            }
          }}
        />
      </div>
    </Dialog>
  );
}

export function ExportDialog({ selectedCount, onExport, onClose }: {
  selectedCount: number;
  onExport: (format: 'json' | 'html', onlySelection: boolean) => void;
  onClose: () => void;
}) {
  const [onlySelection, setOnlySelection] = useState(selectedCount > 0);
  return (
    <Dialog title="Export" subtitle="Portable files, generated locally." onClose={onClose}>
      {selectedCount > 0 && (
        <label className="export-scope">
          <input type="checkbox" checked={onlySelection} onChange={(event) => setOnlySelection(event.target.checked)} />
          <span>Only the {countLabel(selectedCount, 'selected bookmark')}</span>
        </label>
      )}
      <div className="choice-list">
        <button className="choice" onClick={() => { onClose(); onExport('html', onlySelection); }}>
          <span className="choice-icon"><Download /></span>
          <span>
            <strong>Bookmarks HTML</strong>
            <small>Imports into Chrome, Firefox, Safari, and most managers.</small>
          </span>
        </button>
        <button className="choice" onClick={() => { onClose(); onExport('json', onlySelection); }}>
          <span className="choice-icon"><FileJson2 /></span>
          <span>
            <strong>Corral JSON</strong>
            <small>Lossless backup with normalized metadata.</small>
          </span>
        </button>
      </div>
    </Dialog>
  );
}
