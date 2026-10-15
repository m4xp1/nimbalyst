/**
 * Local database page search, read on demand without another content store.
 * Russian normalization and whole-word forms are additive to the existing
 * accent-insensitive/prefix matches and body scoring from collab-protocol.
 * The Local data source supplies its still-visible document ids before limits;
 * unscoped legacy callers retain the existing local typed-page catalogue.
 * SQL and JSON/boolean conversion work on both SQLite and PGLite.
 */
import {
  pageSearchIndexKeys,
  pageSearchLimit,
  pageSearchMatches,
  pageSearchQueryKeys,
  pageSearchQueryTerms,
  pageSearchScore,
  pageSearchSnippet,
  pageSearchSource,
  pageSearchTextFromMarkdown,
  pageSearchTypeFilter,
  type PageSearchHit,
  type PageSearchRequest,
  type PageSearchResponse,
} from '@nimbalyst/collab-protocol';

import { matchAllSearchTerms, mergeSearchRanges, searchTextSnippet, type KeywordMatch } from '@nimbalyst/search-text';
import { bodyMarkdownOf } from '../tracker/trackerBodyLinks';

export interface PersonalSearchDb {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

interface Body {
  documentId: string;
  title: string;
  issueKey: string | null;
  updatedAt: number | null;
  text: string;
  /** A typed page's primary type; null for pages and type pages. */
  typeId: string | null;
  fieldsText?: string;
}

function rowsOf(result: unknown): any[] {
  const r = result as { rows?: unknown[] } | undefined;
  return Array.isArray(r?.rows) ? (r!.rows as any[]) : [];
}

function parseJson(value: unknown): any {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function isTrue(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}

function millis(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

async function pageBodies(db: PersonalSearchDb, workspacePath: string): Promise<Body[]> {
  const rows = rowsOf(await db.query(
    `SELECT document_id, title, body, fields, updated_at FROM personal_page_documents
     WHERE workspace_path = $1 AND trashed_at IS NULL`,
    [workspacePath],
  ));
  return rows.map((row) => ({
    documentId: String(row.document_id),
    title: typeof row.title === 'string' ? row.title : String(row.document_id),
    issueKey: null,
    updatedAt: millis(row.updated_at),
    text: pageSearchTextFromMarkdown(typeof row.body === 'string' ? row.body : ''),
    typeId: null,
    fieldsText: Object.values(parseJson(row.fields) ?? {}).map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' '),
  }));
}

async function typedPageBodies(db: PersonalSearchDb, workspacePath: string): Promise<Body[]> {
  // The newest cached room body wins when it is at least as new as the row.
  const rows = rowsOf(await db.query(
    `SELECT t.id, t.type, t.issue_key, t.data, t.content, t.body_version, t.archived, t.updated,
            c.content AS cached_content, c.body_version AS cached_version
     FROM tracker_items t
     LEFT JOIN tracker_body_cache c
       ON c.item_id = t.id
      AND c.body_version = (SELECT MAX(body_version) FROM tracker_body_cache WHERE item_id = t.id)
     WHERE t.workspace = $1 AND t.deleted_at IS NULL
       AND (t.sync_status IS NULL OR t.sync_status = 'local')
       AND (t.content IS NOT NULL OR c.content IS NOT NULL)`,
    [workspacePath],
  ));
  const out: Body[] = [];
  for (const row of rows) {
    if (isTrue(row.archived)) continue;
    const useCache = row.cached_content != null && Number(row.cached_version ?? 0) >= Number(row.body_version ?? 0);
    const markdown = bodyMarkdownOf(useCache ? row.cached_content : row.content);
    if (!markdown.trim()) continue;
    const data = parseJson(row.data) ?? {};
    out.push({
      documentId: `tracker-content/${row.id}`,
      title: typeof data.title === 'string' ? data.title : String(row.id),
      issueKey: typeof row.issue_key === 'string' ? row.issue_key : null,
      updatedAt: millis(row.updated),
      text: pageSearchTextFromMarkdown(markdown),
      typeId: typeof row.type === 'string' ? row.type : null,
    });
  }
  return out;
}

/** The workspace's Personal pages whose bodies match `request`, best first. Titles are matched by the caller. */
export async function searchPersonalPages(
  db: PersonalSearchDb,
  workspacePath: string,
  request: PageSearchRequest & { localDocumentIds?: string[] },
): Promise<PageSearchResponse> {
  const parsed = pageSearchQueryTerms(typeof request.query === 'string' ? request.query : '');
  if (!request.query.trim()) return { hits: [], status: 'ready' };
  const bodies = [...(await pageBodies(db, workspacePath)), ...(request.localDocumentIds ? [] : await typedPageBodies(db, workspacePath))]
    .filter(body => !request.localDocumentIds || request.localDocumentIds.includes(body.documentId));

  const groups = pageSearchQueryKeys(parsed);
  const keyed = bodies.map((body) => {
    const keys = pageSearchIndexKeys(body.text);
    let length = 0;
    for (const [key, count] of keys) if (key.startsWith('t:')) length += count;
    return { body, length, counts: groups.map((anyOf) => Math.max(0, ...anyOf.map((key) => keys.get(key) ?? 0))) };
  });
  const docs = groups.map((_, i) => keyed.filter((entry) => entry.counts[i]! > 0).length);
  const averageLength = keyed.reduce((sum, entry) => sum + entry.length, 0) / Math.max(1, keyed.length);

  // Typed pages of listed types only, before the limit; pages and type pages always pass.
  const types = pageSearchTypeFilter(request.typeIds);
  const ranked = keyed
    .filter(entry => entry.body.typeId === null || !types || types.has(entry.body.typeId))
    .map(entry => {
      const texts = [entry.body.title, entry.body.issueKey ?? '', entry.body.text, entry.body.fieldsText ?? ''];
      const match = localBodyMatch(request.query, texts);
      if (!match) return null;
      const oldBodyMatch = parsed.terms.length > 0 && entry.counts.every(count => count > 0) && pageSearchMatches(entry.body.text, parsed);
      const score = oldBodyMatch ? pageSearchScore({ counts: entry.counts, docs, total: keyed.length, length: entry.length, averageLength }) : 0;
      return { entry, score, keywordMatch: match, titleMatch: localBodyMatch(request.query, texts.slice(0,2)) !== null };
    })
    .filter((hit): hit is NonNullable<typeof hit> => hit !== null)
    .sort((a,b) => Number(a.keywordMatch === 'stem') - Number(b.keywordMatch === 'stem') || Number(b.titleMatch)-Number(a.titleMatch) || b.score-a.score || a.entry.body.documentId.localeCompare(b.entry.body.documentId))
    .slice(0, pageSearchLimit(request.limit));
  const hits: PageSearchHit[] = ranked.map(({ entry, score, keywordMatch }) => {
    const fresh = searchTextSnippet(entry.body.text + '\n' + (entry.body.fieldsText ?? ''), request.query, 180);
    const old = parsed.terms.length ? pageSearchSnippet(entry.body.text, parsed) : { snippet: '', highlights: [] };
    // Preserve accent/prefix highlighting, but use actual Russian form positions when present.
    const snippet = fresh.highlights.length ? fresh : old;
    const oldInSnippet = pageSearchSnippet(snippet.snippet, parsed);
    const accents = oldInSnippet.snippet === snippet.snippet ? oldInSnippet.highlights : [];
    return { ...pageSearchSource(entry.body.documentId), documentId: entry.body.documentId,
      title: entry.body.title, issueKey: entry.body.issueKey, ...snippet,
      highlights: mergeSearchRanges([...snippet.highlights, ...accents]), keywordMatch,
      updatedAt: entry.body.updatedAt, score };
  });
  return { hits, status: 'ready' };
}

/** All words, allowing old DB accent/prefix matching per term alongside Russian forms. */
function localBodyMatch(query: string, texts: string[]): KeywordMatch | null {
  const whole = matchAllSearchTerms(query, texts);
  if (whole) return whole.keywordMatch;
  const words = query.trim().split(/\s+/); let stem = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i], lexical = matchAllSearchTerms(word, texts);
    const old = pageSearchQueryTerms(word + (i === words.length-1 && !/\s$/.test(query) ? '' : ' '));
    const literal = old.terms.length > 0 && pageSearchMatches(texts.join('\n'), old);
    if (!lexical && !literal) return null;
    if (!literal && lexical?.keywordMatch === 'stem') stem = true;
  }
  return stem ? 'stem' : 'exact';
}
