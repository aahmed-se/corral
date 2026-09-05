import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Compass, Download, FileJson2, FileUp, Folder, FolderPlus, X } from 'lucide-react';
import { FOLDER_SEPARATOR, UNFILED, type BookmarkRecord, type FolderCount } from '../lib/db.ts';
import { openableBookmarkUrl } from '../lib/bookmark-url.ts';
import type { BookmarkDraft } from '../lib/bookmark-edit.ts';
import { countLabel } from './use-corral.ts';

function Dialog({ title, subtitle, onClose, children }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const priorFocusRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key !== 'Tab' || !backdropRef.current) return;
      const focusable = Array.from(backdropRef.current.querySelectorAll<HTMLElement>('button:not(:disabled):not([hidden]), input:not(:disabled):not([hidden]), select:not(:disabled):not([hidden]), [tabindex]:not([tabindex="-1"]):not([hidden])'));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    if (!backdropRef.current?.contains(document.activeElement)) {
      backdropRef.current?.querySelector<HTMLElement>('button:not(:disabled):not([hidden]), input:not(:disabled):not([hidden]), select:not(:disabled):not([hidden])')?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      priorFocusRef.current?.focus();
    };
  }, []);

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

export function BookmarkDialog({ record, folder, folders, onSave, onClose }: {
  record?: BookmarkRecord;
  folder: string;
  folders: FolderCount[];
  onSave: (draft: BookmarkDraft, id?: number) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<BookmarkDraft>({ title: record?.title ?? '', url: record?.url ?? '', folder: record?.folder ?? (folder || UNFILED) });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const urlRef = useRef<HTMLInputElement>(null);
  useEffect(() => urlRef.current?.focus(), []);
  const close = () => { if (!saving) onClose(); };
  return <Dialog title={record ? 'Edit bookmark' : 'Add bookmark'} subtitle="Save a link in your local library." onClose={close}>
    <form className="picker bookmark-form" onSubmit={async (event) => {
      event.preventDefault();
      if (saving) return;
      if (!openableBookmarkUrl(draft.url)) { setError('Enter a complete, supported URL, such as https://example.com.'); urlRef.current?.focus(); return; }
      setError('');
      setSaving(true);
      const saved = await onSave(draft, record?.id);
      setSaving(false);
      if (saved) onClose();
      else setError('The bookmark could not be saved. Your changes are still here; please try again.');
    }}>
      <label>URL<input ref={urlRef} className="picker-input" value={draft.url} required spellCheck={false} placeholder="https://example.com" onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label>
      <label>Title<input className="picker-input" value={draft.title} placeholder="Optional — defaults to the URL" onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
      <label>Folder<input className="picker-input" list="bookmark-folders" value={draft.folder} onChange={(event) => setDraft({ ...draft, folder: event.target.value })} /></label>
      <datalist id="bookmark-folders">{folders.map(({ folder: path }) => <option key={path} value={path} />)}</datalist>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="dialog-footer">
        <button type="button" className="button ghost" disabled={saving} onClick={close}>Cancel</button>
        <button className="button primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save bookmark'}</button>
      </footer>
    </form>
  </Dialog>;
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
            <small>{canUseChrome ? 'Adds new bookmarks while keeping your current Corral organization.' : 'Available when Corral runs as a Chrome extension.'}</small>
          </span>
        </button>
        <button className="choice" disabled={busy} onClick={() => fileRef.current?.click()}>
          <span className="choice-icon"><FileUp /></span>
          <span>
            <strong>Import a file</strong>
            <small>Merges an HTML export or Corral JSON backup without replacing current bookmarks.</small>
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
