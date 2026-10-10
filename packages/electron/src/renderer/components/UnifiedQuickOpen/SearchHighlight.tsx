import React from 'react';
import { matchSearchText } from '@nimbalyst/runtime/utils/searchText';
import { fuzzyMatchPath } from '@nimbalyst/runtime/utils/fuzzyMatch';

/** Highlight original UTF-16 ranges, including decomposed graphemes. */
export function SearchHighlight({ text, query, fuzzy = false }: { text: string; query: string; fuzzy?: boolean }) {
  const indices = fuzzy ? fuzzyMatchPath(query, text).matchedIndices : matchSearchText(query, text)?.matchedIndices ?? [];
  if (!query.trim() || !indices.length) return <>{text}</>;
  const marked = new Set(indices), pieces: React.ReactNode[] = [];
  let start = 0;
  for (let end = 1; end <= text.length; end++) {
    if (end < text.length && marked.has(end) === marked.has(start)) continue;
    const value = text.slice(start, end);
    pieces.push(marked.has(start) ? <mark key={start} className="rounded bg-[var(--nim-highlight-bg)] text-[var(--nim-highlight-text)]">{value}</mark> : value);
    start = end;
  }
  return <>{pieces}</>;
}
