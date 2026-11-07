import { $getEditor, type LexicalEditor } from 'lexical';

export type MarkdownSourcePreserver = (source: string, baseline: string, current: string) => string;

interface SourceSnapshot { source: string; rendered: string }
// Source belongs to one editor, not to NodeState/Yjs or persisted JSON.
const sources = new WeakMap<LexicalEditor, SourceSnapshot>();

export function $rememberMarkdownSource(source: string, rendered: string): void {
  sources.set($getEditor(), { source, rendered });
}

/** A disk-backed host supplies its source writer. Collaborative editors keep
 * their canonical export without loading the file writer and YAML CST parser. */
export function $preserveMarkdownSource(rendered: string, preserve: MarkdownSourcePreserver): string {
  const snapshot = sources.get($getEditor());
  return snapshot ? preserve(snapshot.source, snapshot.rendered, rendered) : rendered;
}
