import { diffArrays, diffChars, type Change } from 'diff';
import yaml from 'js-yaml';
import { applyFrontmatterOps, type FrontmatterOp } from '../../plugins/TrackerPlugin/documentHeader/frontmatterSource';

function splitHeader(text: string): { header: string; body: string } {
  const match = /^(?:\uFEFF)?---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/.exec(text);
  return match ? { header: match[0], body: text.slice(match[0].length) } : { header: '', body: text };
}

function fields(header: string): Record<string, unknown> {
  return header ? yaml.load(header.replace(/^(?:\uFEFF)?---\r?\n/, '').replace(/\r?\n---(?:\r?\n|$)$/, '')) as Record<string, unknown> ?? {} : {};
}

function canonicalValue(value: unknown): unknown {
  if (value instanceof Date) return { date: value.toISOString() };
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalValue(v)]));
  }
  return value;
}

interface Edit { start: number; end: number; text: string }
interface Mapping { start: number; end: number; rawStart: number; rawEnd: number; equal: boolean }

export class MarkdownSourceBudgetError extends Error {
  constructor(readonly sourceDraft?: string) {
    super('Cannot preserve Markdown formatting within the edit budget.');
    this.name = 'MarkdownSourceBudgetError';
  }
}

function changes(before: string, after: string): Change[] {
  // A difficult diff must not freeze typing or silently fall back to rewriting
  // the whole file. The host exposes this as a failed save, retaining the buffer.
  const result = diffChars(before, after, { timeout: 100 });
  if (!result) throw new MarkdownSourceBudgetError();
  return result;
}

function edits(before: string, after: string): Edit[] {
  const result: Edit[] = [];
  let offset = 0;
  let pending: Edit | undefined;
  for (const part of changes(before, after)) {
    if (!part.added && !part.removed) {
      if (pending) result.push(pending);
      pending = undefined;
      offset += part.value.length;
    } else {
      pending ??= { start: offset, end: offset, text: '' };
      if (part.removed) { offset += part.value.length; pending.end = offset; }
      else pending.text += part.value;
    }
  }
  if (pending) result.push(pending);
  return result;
}

function sourceMapping(raw: string, rendered: string): Mapping[] {
  const result: Mapping[] = [];
  let rawOffset = 0;
  let offset = 0;
  let pending: Mapping | undefined;
  for (const part of sourceChanges(raw, rendered)) {
    if (!part.added && !part.removed) {
      if (pending) result.push(pending);
      pending = undefined;
      result.push({ start: offset, end: offset + part.value.length, rawStart: rawOffset, rawEnd: rawOffset + part.value.length, equal: true });
      rawOffset += part.value.length;
      offset += part.value.length;
    } else {
      pending ??= { start: offset, end: offset, rawStart: rawOffset, rawEnd: rawOffset, equal: false };
      if (part.removed) { rawOffset += part.value.length; pending.rawEnd = rawOffset; }
      else { offset += part.value.length; pending.end = offset; }
    }
  }
  if (pending) result.push(pending);
  return result;
}

/** Anchor normalization changes by lines before doing character-level maps.
 * Whole-document character diff is quadratic for a file full of padded tables
 * or CRLFs, even when the user edits just one word. Equal anchors are compared
 * one line at a time so line-ending differences retain their exact offsets. */
function sourceChanges(raw: string, rendered: string): Change[] {
  const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const before = lines(raw);
  const after = lines(rendered);
  const anchors = uniqueLineAnchors(before, after);
  const result: Change[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const [oldAt, newAt] of [...anchors, [before.length, after.length]]) {
    result.push(...lineBlockChanges(before.slice(oldLine, oldAt), after.slice(newLine, newAt)));
    if (oldAt < before.length) result.push(...changes(before[oldAt], after[newAt]));
    oldLine = oldAt + 1;
    newLine = newAt + 1;
  }
  return result;
}

// Patience-diff anchors partition large documents at unchanged unique lines.
// Whitespace remains in each line's character diff; these keys only identify
// anchors and never become the persisted source.
function uniqueLineAnchors(before: string[], after: string[]): Array<[number, number]> {
  const index = (lines: string[]) => {
    const result = new Map<string, number>();
    lines.forEach((line, i) => {
      const key = line.replace(/\s+/g, '');
      result.set(key, result.has(key) ? -1 : i);
    });
    return result;
  };
  const oldLines = index(before);
  const newLines = index(after);
  const pairs: Array<[number, number]> = [];
  for (const [key, oldAt] of oldLines) {
    const newAt = newLines.get(key);
    if (oldAt >= 0 && newAt !== undefined && newAt >= 0) pairs.push([oldAt, newAt]);
  }
  const tails: number[] = [];
  const previous: number[] = [];
  pairs.forEach((pair, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pairs[tails[mid]][1] < pair[1]) lo = mid + 1; else hi = mid;
    }
    previous[i] = lo ? tails[lo - 1] : -1;
    tails[lo] = i;
  });
  const anchors: Array<[number, number]> = [];
  for (let at = tails.at(-1) ?? -1; at >= 0; at = previous[at]) anchors.push(pairs[at]);
  return anchors.reverse();
}

function lineBlockChanges(before: string[], after: string[]): Change[] {
  const blocks = diffArrays(before, after, {
    comparator: (a, b) => a.trim() === b.trim(),
    timeout: 100,
  });
  if (!blocks) return changes(before.join(''), after.join(''));
  const result: Change[] = [];
  let oldLine = 0;
  let newLine = 0;
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    if (removed.length === added.length) {
      for (let i = 0; i < removed.length; i++) result.push(...changes(removed[i], added[i]));
    } else if (removed.length || added.length) {
      result.push(...changes(removed.join(''), added.join('')));
    }
    removed = [];
    added = [];
  };
  for (const block of blocks) {
    const count = block.value.length;
    if (block.removed) {
      removed.push(...before.slice(oldLine, oldLine + count));
      oldLine += count;
    } else if (block.added) {
      added.push(...after.slice(newLine, newLine + count));
      newLine += count;
    } else {
      flush();
      for (let i = 0; i < count; i++) result.push(...changes(before[oldLine++], after[newLine++]));
    }
  }
  flush();
  return result;
}

/** Transfer actual editor changes onto the original text, not the normalized
 * rendering. Unchanged regions are copied from disk. An edit inside a generated
 * region replaces that whole region, so a partial normalized token cannot be
 * spliced into an incompatible original representation. */
export function preserveMarkdownBody(raw: string, baseline: string, current: string): string {
  if (baseline === current) return raw;
  if (raw === baseline) return current;
  const mapping = sourceMapping(raw, baseline);
  const patches = edits(baseline, current);
  const regions: Array<{ start: number; end: number; edits: Edit[] }> = [];
  for (const patch of patches) {
    let start = patch.start;
    let end = patch.end;
    for (const part of mapping) {
      const inside = part.start < start && start < part.end || part.start < end && end < part.end;
      // A new formatting marker adjacent to a normalized marker (e.g. adding
      // bold to imported `_italic_`) changes that marker as well. Ordinary
      // text edited beside it does not change the user's delimiter choice.
      const markerInsertion = patch.start === patch.end && /^[*_`~]+$/.test(patch.text) &&
        /^[*_`~]+$/.test(baseline.slice(part.start, part.end)) &&
        part.start <= start && start <= part.end;
      if (!part.equal && part.start !== part.end && (inside || markerInsertion)) {
        start = Math.min(start, part.start);
        end = Math.max(end, part.end);
      }
    }
    const previous = regions[regions.length - 1];
    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
      previous.edits.push(patch);
    } else regions.push({ start, end, edits: [patch] });
  }
  const rawOffset = (at: number, right: boolean): number => {
    const boundary = mapping.filter(part => part.start <= at && at <= part.end);
    if (!boundary.length) return raw.length;
    const part = right ? boundary[boundary.length - 1] : boundary[0];
    if (part.equal) return part.rawStart + at - part.start;
    if (part.start === part.end) return right ? part.rawEnd : part.rawStart;
    if (at === part.start) return part.rawStart;
    if (at === part.end) return part.rawEnd;
    throw new Error('Cannot map Markdown edit to its original source range.');
  };
  let result = raw;
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  for (const region of regions.reverse()) {
    let text = baseline.slice(region.start, region.end);
    for (const patch of [...region.edits].reverse()) {
      text = text.slice(0, patch.start - region.start) + patch.text + text.slice(patch.end - region.start);
    }
    const start = rawOffset(region.start, true);
    const end = region.start === region.end ? start : rawOffset(region.end, false);
    result = result.slice(0, start) + text.replace(/\r?\n/g, newline) + result.slice(end);
  }
  return result;
}

export function preserveMarkdownSource(source: string, baseline: string, current: string): string {
  if (baseline === current) return source;
  const original = splitHeader(source);
  const before = splitHeader(baseline);
  const after = splitHeader(current);
  let header = original.header;
  if (before.header !== after.header) {
    if (!after.header) header = '';
    else {
      const previous = fields(before.header);
      const next = fields(after.header);
      const ops: FrontmatterOp[] = [];
      for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
        if (JSON.stringify(canonicalValue(previous[key])) === JSON.stringify(canonicalValue(next[key]))) continue;
        ops.push(key in next ? { kind: 'set', key, value: next[key] } : { kind: 'delete', key });
      }
      const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
      header = bom + splitHeader(applyFrontmatterOps(source.slice(bom.length), ops)).header;
    }
  }
  try {
    return header + preserveMarkdownBody(original.body, before.body, after.body);
  } catch (error) {
    if (!(error instanceof MarkdownSourceBudgetError)) throw error;
    // Source Mode may show the edited body for explicit recovery. The original
    // frontmatter can still be kept even when the body's edit map times out.
    throw new MarkdownSourceBudgetError(header + after.body);
  }
}
