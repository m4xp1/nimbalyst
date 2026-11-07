import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileTrackerStorageConfig } from '../../../../main/services/tracker/fileTrackerStorageConfig';

interface StorageSnapshot { config: FileTrackerStorageConfig; version: string }
interface TrackerStoragePanelProps {
  workspacePath?: string;
  types: Array<{ type: string; displayNamePlural: string }>;
}

export function TrackerStoragePanel({ workspacePath, types }: TrackerStoragePanelProps) {
  const [saved, setSaved] = useState<StorageSnapshot | null>(null);
  const [draft, setDraft] = useState<FileTrackerStorageConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const savePending = useRef(false);

  const load = useCallback(async () => {
    const request = ++generation.current;
    savePending.current = false;
    setSaved(null);
    setDraft(null);
    setError(null);
    setNotice(null);
    setSaving(false);
    setLoading(Boolean(workspacePath));
    if (!workspacePath) return;
    try {
      const snapshot: StorageSnapshot = await window.electronAPI.invoke('document-service:tracker-storage:get', { workspacePath });
      if (!snapshot?.config || typeof snapshot.version !== 'string') throw new Error('Could not load tracker storage settings.');
      if (request !== generation.current) return;
      setSaved(snapshot);
      setDraft(snapshot.config);
    } catch (err) {
      if (request === generation.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    void load();
    return () => { generation.current++; };
  }, [load]);

  const rows = useMemo(() => {
    const byType = new Map(types.map(type => [type.type, type]));
    for (const type of Object.keys(draft?.directories ?? {})) {
      if (!byType.has(type)) byType.set(type, { type, displayNamePlural: type });
    }
    return [...byType.values()];
  }, [types, draft?.directories]);

  const save = async () => {
    if (!workspacePath || !draft || !saved || savePending.current) return;
    savePending.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    const request = generation.current;
    const config = {
      ...draft,
      directories: Object.fromEntries(Object.entries(draft.directories).map(([type, path]) => [type, path.trim()]).filter(([, path]) => path)),
    };
    try {
      const snapshot: StorageSnapshot = await window.electronAPI.invoke('document-service:tracker-storage:set', {
        workspacePath, config, expectedVersion: saved.version,
      });
      if (!snapshot?.config || typeof snapshot.version !== 'string') throw new Error('Could not save tracker storage settings.');
      if (request !== generation.current) return;
      setSaved(snapshot);
      setDraft(snapshot.config);
      setNotice('Saved. This setting applies to new cards.');
    } catch (err) {
      if (request === generation.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request === generation.current) { savePending.current = false; setSaving(false); }
    }
  };

  const changed = saved && draft && JSON.stringify(saved.config) !== JSON.stringify(draft);
  return (
    <section className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]" aria-label="Tracker storage">
      <h4 className="text-[15px] font-semibold mb-2 text-[var(--nim-text)]">Card storage</h4>
      <p className="text-[13px] text-[var(--nim-text-muted)] mb-3">Choose where new cards are saved. Existing cards keep their current storage.</p>
      {!workspacePath ? <p className="text-sm text-[var(--nim-text-muted)]">Open a project to configure tracker storage.</p> : loading ? <p role="status">Loading tracker storage…</p> : draft && (
        <fieldset disabled={saving} className="space-y-3">
          <label className="flex items-center gap-3 text-sm">
            New cards
            <select aria-label="New card storage" value={draft.mode} className="rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-1"
              onChange={event => { setDraft({ ...draft, mode: event.target.value as FileTrackerStorageConfig['mode'] }); setNotice(null); }}>
              <option value="database">Application database</option>
              <option value="files">Markdown files</option>
            </select>
          </label>
          {draft.mode === 'files' && <>
            <p className="text-[12px] text-[var(--nim-text-muted)]">Card fields and content are saved in Markdown; comments are saved alongside the project. Files can be shared through Git. Session links and application history stay local.</p>
            <p className="text-[12px] text-[var(--nim-text-muted)]">Set a folder relative to this project for each type you create. A type without a folder cannot create new file cards. Changing a folder does not move existing cards.</p>
            <div className="space-y-2">
              {rows.map(({ type, displayNamePlural }) => <label key={type} className="grid grid-cols-[minmax(7rem,1fr)_2fr] gap-3 items-center text-[13px]">
                <span>{displayNamePlural}</span>
                <input aria-label={`${displayNamePlural} folder`} value={draft.directories[type] ?? ''} placeholder={`docs/trackers/${type}`} className="rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-1 font-mono text-xs"
                  onChange={event => { setDraft({ ...draft, directories: { ...draft.directories, [type]: event.target.value } }); setNotice(null); }} />
              </label>)}
            </div>
          </>}
          <button type="button" onClick={() => void save()} disabled={!changed || saving} className="rounded border border-[var(--nim-border)] px-3 py-1 text-sm disabled:opacity-50">{saving ? 'Saving…' : 'Save storage settings'}</button>
        </fieldset>
      )}
      {notice && <p role="status" className="mt-2 text-[12px] text-[var(--nim-text-muted)]">{notice}</p>}
      {error && <div className="mt-2 space-y-2"><p role="alert" className="text-sm text-[var(--nim-error)]">{error}</p><button type="button" onClick={() => void load()} disabled={saving} className="text-sm underline">Reload settings</button></div>}
    </section>
  );
}
