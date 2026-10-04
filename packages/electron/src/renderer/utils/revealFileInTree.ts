import { store, rawFileTreeAtom, workspaceRootPathsAtom, revealFileAtom, selectedPathsAtom, lastSelectedPathAtom, type RendererFileTreeItem } from '../store';
import { applyLoadedFolderContents } from '../store/listeners/fileTreeListeners';

function key(p: string): string {
  const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
}
function find(items: RendererFileTreeItem[], target: string): string | null {
  for (const item of items) {
    if (item.type === 'file' && key(item.path) === key(target)) return item.path;
    const nested = item.children && find(item.children, target);
    if (nested) return nested;
  }
  return null;
}
/** Resolve the tree's path spelling, loading parents beyond the initial scan depth. */
export async function revealFileInTree(filePath: string): Promise<void> {
  let treePath = find(store.get(rawFileTreeAtom), filePath);
  const root = [...store.get(workspaceRootPathsAtom)].sort((a,b) => b.length-a.length)
    .find(candidate => key(filePath).startsWith(key(candidate) + '/'));
  if (!treePath && root && window.electronAPI?.refreshFolderContents) {
    const relative = filePath.replace(/\\/g, '/').slice(root.replace(/\\/g, '/').replace(/\/+$/, '').length + 1);
    let directory = root.replace(/[\\/]+$/, '');
    for (const part of ['', ...relative.split('/').slice(0,-1)]) {
      if (part) directory += '/' + part;
      const contents = await window.electronAPI.refreshFolderContents(directory);
      applyLoadedFolderContents(directory, Array.isArray(contents) ? contents : []);
    }
    treePath = find(store.get(rawFileTreeAtom), filePath);
  }
  const target = treePath || filePath;
  store.set(revealFileAtom, target);
  store.set(selectedPathsAtom, new Set([target]));
  store.set(lastSelectedPathAtom, target);
}
