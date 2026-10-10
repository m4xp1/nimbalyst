import { matchSearchText, normalizeSearchText, searchTokens, stemSearchToken, type KeywordMatch } from '@nimbalyst/runtime/utils/searchText';

export function isRegexSearch(query: string): boolean { return /[.*+?^${}()|[\]\\]/u.test(query); }
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function normalizedLiteralPattern(text: string): string {
  return [...text].map(char => {
    if (char === 'е') return '[её](?:\\x{0308})?';
    const nfd = char.normalize('NFD');
    return nfd === char ? escapeRegex(char) : `(?:${escapeRegex(char)}|${escapeRegex(nfd)})`;
  }).join('');
}
/** rg limits the scan; Snowball verifies complete tokens and phrase order afterwards. */
export function fileContentPattern(query: string): string {
  if (isRegexSearch(query)) return query;
  const first = searchTokens(query)[0];
  return normalizedLiteralPattern(first ? stemSearchToken(first) : normalizeSearchText(query));
}
export interface FileContentMatch { line: number; text: string; start: number; end: number; keywordMatch?: KeywordMatch }
/** ripgrep uses UTF-8 bytes, whereas JS/UI positions use UTF-16 code units. */
export function decodeRipgrepMatch(data: { line_number: number; lines: { text: string }; submatches: { start: number; end: number }[] }, query: string): FileContentMatch | null {
  const raw = data.lines.text;
  const text = raw.trim();
  if (!isRegexSearch(query)) {
    const match = matchSearchText(query, text);
    return match ? { line: data.line_number, text, start: match.start, end: match.end, keywordMatch: match.keywordMatch } : null;
  }
  const bytes = Buffer.from(raw, 'utf8');
  const leading = raw.length - raw.trimStart().length;
  const first = data.submatches[0];
  const start = Math.max(0, bytes.subarray(0, first?.start ?? 0).toString('utf8').length - leading);
  const end = Math.max(start, Math.min(text.length, bytes.subarray(0, first?.end ?? bytes.length).toString('utf8').length - leading));
  return { line: data.line_number, text, start, end };
}
