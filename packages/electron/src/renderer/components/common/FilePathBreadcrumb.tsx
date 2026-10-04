import React, { useCallback, useMemo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { dirname } from 'pathe';
import { revealFileInTree } from '../../utils/revealFileInTree';
import type { RendererFileTreeItem } from '../../store';
import { basename } from 'pathe';
import { useSetAtom } from 'jotai';

import {
  openFileRequestAtom,
  setWindowModeAtom,
} from '../../store';

interface BreadcrumbSegment {
  name: string;
  folderPath: string | null;
}

interface FilePathBreadcrumbProps {
  filePath: string;
  workspacePath?: string | null;
  className?: string;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function getBreadcrumbSegments(filePath: string, workspacePath?: string | null): BreadcrumbSegment[] {
  const normalizedFilePath = normalizePath(filePath);
  const normalizedWorkspacePath = workspacePath ? normalizePath(workspacePath) : null;
  const isWithinWorkspace = Boolean(
    normalizedWorkspacePath &&
      (normalizedFilePath === normalizedWorkspacePath ||
        normalizedFilePath.startsWith(`${normalizedWorkspacePath}/`)),
  );

  let displayPath = normalizedFilePath;
  if (isWithinWorkspace && normalizedWorkspacePath) {
    displayPath = normalizedFilePath.slice(normalizedWorkspacePath.length).replace(/^\/+/, '');
  }

  const parts = displayPath.split('/').filter(Boolean);
  if (!parts.length) {
    return [{ name: basename(filePath), folderPath: null }];
  }

  const absolutePrefix = !isWithinWorkspace && normalizedFilePath.startsWith('/') ? '/' : '';
  return parts.map((name, index) => {
    const isFile = index === parts.length - 1;
    if (isFile) {
      return { name, folderPath: null };
    }

    const folderPath = isWithinWorkspace && normalizedWorkspacePath
      ? `${normalizedWorkspacePath}/${parts.slice(0, index + 1).join('/')}`
      : `${absolutePrefix}${parts.slice(0, index + 1).join('/')}`;

    return { name, folderPath };
  });
}

export const FilePathBreadcrumb: React.FC<FilePathBreadcrumbProps> = ({
  filePath,
  workspacePath,
  className = '',
}) => {
  const setOpenFileRequest = useSetAtom(openFileRequestAtom);
  const setWindowMode = useSetAtom(setWindowModeAtom);

  const breadcrumbSegments = useMemo(
    () => getBreadcrumbSegments(filePath, workspacePath),
    [filePath, workspacePath],
  );

  const [menu, setMenu] = useState<{ path: string; left: number; top: number } | null>(null);
  const [entries, setEntries] = useState<RendererFileTreeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const closeMenu = useCallback(() => { setMenu(null); anchorRef.current?.focus(); }, []);
  const openFile = useCallback((target: string) => {
    setMenu(null);
    setWindowMode('files');
    setOpenFileRequest({ path: target, ts: Date.now() });
    void revealFileInTree(target).catch(error => console.error('Could not reveal file', error));
  }, [setOpenFileRequest, setWindowMode]);
  useEffect(() => { setMenu(null); }, [filePath, workspacePath]);
  useEffect(() => {
    if (!menu) return;
    let cancelled = false;
    setLoading(true); setError(null); setEntries([]);
    void window.electronAPI.refreshFolderContents(menu.path).then(items => {
      if (cancelled) return;
      setEntries([...items].sort((a,b) => (a.type === b.type ? 0 : a.type === 'directory' ? -1 : 1) || a.name.localeCompare(b.name)));
    }).catch(() => { if (!cancelled) setError('Could not read this folder.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [menu?.path]);
  useEffect(() => {
    if (menu && !loading) menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [menu, loading, entries]);
  useEffect(() => {
    if (!menu) return;
    const outside = (e: MouseEvent) => {
      const node = e.target as Node;
      if (!menuRef.current?.contains(node) && !anchorRef.current?.contains(node)) setMenu(null);
    };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); closeMenu(); } };
    const resize = () => setMenu(null);
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', resize);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('resize', resize); };
  }, [menu, closeMenu]);
  const handleBreadcrumbClick = (folderPath: string | null, target: string | undefined, element: HTMLElement) => {
    if (!folderPath) { if (target) openFile(target); return; }
    const rect = element.getBoundingClientRect();
    anchorRef.current = element;
    setMenu(current => current?.path === folderPath ? null : { path: folderPath, left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)), top: rect.bottom + 4 });
  };
  const parent = menu ? dirname(menu.path) : '';
  const canGoUp = !!menu && parent !== menu.path && parent !== '.' &&
    (!workspacePath || normalizePath(menu.path).toLowerCase() !== normalizePath(workspacePath).toLowerCase());

  return (
    <div className={`unified-header-breadcrumb flex items-center gap-1.5 text-[13px] min-w-0 overflow-hidden ${className}`.trim()}>
      {breadcrumbSegments.map((segment, index) => {
        const isLast = index === breadcrumbSegments.length - 1;
        const isClickable = (!isLast && segment.folderPath) || (isLast && Boolean(filePath));
        return (
          <React.Fragment key={`${segment.name}-${index}`}>
            <button
              type="button"
              className={`breadcrumb-segment bg-transparent border-none text-inherit text-[13px] flex items-center gap-1 whitespace-nowrap ${
                isLast
                  ? 'breadcrumb-filename text-[var(--nim-text)] font-medium'
                  : 'text-[var(--nim-text-muted)]'
              } ${
                isClickable
                  ? 'breadcrumb-clickable cursor-pointer rounded py-0.5 px-1 -my-0.5 -mx-1 transition-colors duration-150 hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'
                  : ''
              }`}
              onClick={isClickable ? e => handleBreadcrumbClick(segment.folderPath, isLast ? filePath : undefined, e.currentTarget) : undefined}
              aria-haspopup={!isLast ? "menu" : undefined}
              aria-expanded={!isLast ? menu?.path === segment.folderPath : undefined}
              title={isClickable ? (isLast ? `Go to ${segment.name} in file tree` : `Browse ${segment.name}`) : undefined}
            >
              {!isLast && (
                <svg className="breadcrumb-icon w-3.5 h-3.5 opacity-70 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
              )}
              {isLast && (
                <svg className="breadcrumb-icon w-3.5 h-3.5 opacity-80 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
              )}
              {segment.name}
            </button>
            {!isLast && <span className="breadcrumb-separator text-[var(--nim-text-faint)] text-[11px]">/</span>}
          </React.Fragment>
        );
      })}
      {menu && createPortal(
        <div ref={menuRef} role="menu" aria-label="Folder contents" className="fixed z-[10000] rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] shadow-lg text-[13px] overflow-y-auto p-1"
          style={{ left: menu.left, top: Math.min(menu.top, window.innerHeight - 80), width: 320, maxHeight: Math.max(64, Math.min(360, window.innerHeight - menu.top - 12)) }}
          onKeyDown={e => {
            const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (['ArrowDown','ArrowUp','Home','End'].includes(e.key) && buttons.length) {
              e.preventDefault();
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }
            if (e.key === 'Tab') setMenu(null);
          }}>
          <div className="px-2 py-1 text-nim-muted truncate" title={menu.path}>{menu.path}</div>
          {canGoUp && <button type="button" role="menuitem" className="w-full text-left rounded px-2 py-1.5 hover:bg-[var(--nim-bg-hover)] focus:bg-[var(--nim-bg-hover)]" onClick={() => setMenu({ ...menu, path: parent })}>↑ Parent folder</button>}
          {loading ? <div className="p-2 text-nim-muted">Loading…</div> : error ? <div role="alert" className="p-2 text-nim-muted">{error}</div> : entries.length === 0 ? <div className="p-2 text-nim-muted">Empty folder</div> : entries.map(entry => (
            <button type="button" role="menuitem" key={entry.path} className="w-full flex gap-2 text-left rounded px-2 py-1.5 hover:bg-[var(--nim-bg-hover)] focus:bg-[var(--nim-bg-hover)]" onClick={() => entry.type === 'directory' ? setMenu({ ...menu, path: normalizePath(entry.path) }) : openFile(entry.path)}>
              <span className="material-symbols-outlined text-base">{entry.type === 'directory' ? 'folder' : 'description'}</span><span className="truncate">{entry.name}</span>
            </button>
          ))}
        </div>, document.body)}
    </div>
  );
};
