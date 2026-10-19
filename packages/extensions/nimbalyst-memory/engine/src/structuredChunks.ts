import { sha256 } from "./hash.js";
import {
  MAX_CHUNK_BODY_BYTES,
  splitUtf8,
  utf8Bytes,
  utf8Prefix,
} from "./embeddingInput.js";
import type { Chunk } from "./types.js";
interface Line {
  start: number;
  end: number;
  text: string;
}
interface Section {
  start: number;
  end: number;
  headingPath: string[];
  lines: Line[];
}
interface Unit {
  start: number;
  end: number;
  context?: string;
}
const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/;
function closes(line: string, fence: string): boolean {
  const match = opening.exec(line);
  return (
    !!match &&
    match[1][0] === fence[0] &&
    match[1].length >= fence.length &&
    !match[2].trim()
  );
}
function lines(raw: string, start: number): Line[] {
  const result: Line[] = [];
  let offset = start;
  while (offset < raw.length) {
    const newline = raw.indexOf("\n", offset),
      end = newline < 0 ? raw.length : newline + 1;
    result.push({
      start: offset,
      end,
      text: raw.slice(offset, end).replace(/\r?\n$/, ""),
    });
    offset = end;
  }
  return result;
}
function sections(raw: string, start: number, plain: boolean): Section[] {
  const result: Section[] = [],
    stack: { level: number; title: string }[] = [];
  let fence: string | undefined;
  let current: Section = { start, end: raw.length, headingPath: [], lines: [] };
  for (const line of lines(raw, start)) {
    const match = !plain && !fence ? heading.exec(line.text) : null;
    if (match) {
      if (current.lines.length) {
        current.end = line.start;
        result.push(current);
      }
      const level = match[1].length;
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      stack.push({ level, title: match[2].trim() });
      current = {
        start: line.start,
        end: raw.length,
        headingPath: stack.map((h) => h.title),
        lines: [],
      };
    }
    current.lines.push(line);
    if (!plain) {
      if (fence) {
        if (closes(line.text, fence)) fence = undefined;
      } else {
        const opened = opening.exec(line.text);
        if (opened) fence = opened[1];
      }
    }
  }
  if (current.lines.length) result.push(current);
  return result;
}
const delimiter = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
function tableAt(rows: Line[], i: number): boolean {
  return rows[i]?.text.includes("|") && delimiter.test(rows[i + 1]?.text ?? "");
}
function splitLine(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let carry = "";
  for (const hard of splitUtf8(text, MAX_CHUNK_BODY_BYTES, maxChars)) {
    carry += hard;
    while (carry.length > maxChars || utf8Bytes(carry) > MAX_CHUNK_BODY_BYTES) {
      const prefix = splitUtf8(
        utf8Prefix(carry, MAX_CHUNK_BODY_BYTES),
        MAX_CHUNK_BODY_BYTES,
        maxChars
      )[0];
      let boundary = -1;
      for (let i = 0; i < prefix.length; i++)
        if (/\s/.test(prefix[i])) boundary = i + 1;
      const end = boundary >= prefix.length / 2 ? boundary : prefix.length;
      out.push(carry.slice(0, end));
      carry = carry.slice(end);
    }
  }
  if (carry) out.push(carry);
  return out;
}
/** Blocks keep source spans; synthetic column/fence context is never inserted into quoted text. */
function units(
  raw: string,
  section: Section,
  maxChars: number,
  plain: boolean
): Unit[] {
  const rows = section.lines,
    out: Unit[] = [];
  let i = 0;
  while (i < rows.length) {
    const first = i;
    let context: string | undefined;
    const fence = !plain ? opening.exec(rows[i].text) : null;
    if (fence) {
      i++;
      while (i < rows.length && !closes(rows[i].text, fence[1])) i++;
      if (i < rows.length) i++;
      context = "Code continuation:\n" + rows[first].text;
    } else if (!plain && tableAt(rows, i)) {
      i += 2;
      while (
        i < rows.length &&
        rows[i].text.includes("|") &&
        rows[i].text.trim()
      )
        i++;
      context =
        "Table columns:\n" + rows[first].text + "\n" + rows[first + 1].text;
    } else {
      i++;
      if (rows[first].text.trim())
        while (
          i < rows.length &&
          rows[i].text.trim() &&
          (plain || (!opening.test(rows[i].text) && !tableAt(rows, i)))
        )
          i++;
    }
    let start = rows[first].start,
      end = start,
      part = 0;
    const push = () => {
      if (end > start) {
        out.push({ start, end, ...(part > 0 && context ? { context } : {}) });
        part++;
        start = end;
      }
    };
    for (const row of rows.slice(first, i)) {
      const text = raw.slice(row.start, row.end);
      if (
        end > start &&
        (row.end - start > maxChars ||
          utf8Bytes(raw.slice(start, row.end)) > MAX_CHUNK_BODY_BYTES)
      )
        push();
      if (text.length > maxChars || utf8Bytes(text) > MAX_CHUNK_BODY_BYTES) {
        for (const piece of splitLine(text, maxChars)) {
          end = start + piece.length;
          push();
        }
      } else end = row.end;
    }
    push();
  }
  return out;
}
/** Exact UTF-16 source spans, with paragraph, table-row and code-line boundaries where feasible. */
export function structuredChunks(
  sourcePath: string,
  sourceClass: string,
  raw: string,
  bodyStart: number,
  opts: { plainText?: boolean; minTokens?: number; maxTokens?: number },
  ref?: { refType?: string; refId?: string }
): Chunk[] {
  const maxChars = Math.max(2, Math.floor((opts.maxTokens ?? 500) * 4)),
    minChars = Math.min(maxChars, Math.max(0, (opts.minTokens ?? 200) * 4)),
    out: Chunk[] = [];
  for (const section of sections(raw, bodyStart, opts.plainText === true)) {
    let pending: Unit | undefined;
    const flush = () => {
      if (!pending) return;
      const text = raw.slice(pending.start, pending.end);
      if (text.trim())
        out.push({
          id: sourcePath + "#" + out.length,
          sourcePath,
          sourceClass,
          ordinal: out.length,
          headingPath: section.headingPath,
          text,
          contentHash: sha256(text),
          refType: ref?.refType ?? "doc-file",
          refId: ref?.refId ?? sourcePath,
          sectionId: sourcePath + "#section:" + section.start,
          sourceRange: { start: pending.start, end: pending.end },
          coordinateSpace:
            ref?.refType && ref.refType !== "doc-file"
              ? "record-projection"
              : "source-text",
          ...(pending.context ? { context: pending.context } : {}),
        });
      pending = undefined;
    };
    for (const unit of units(raw, section, maxChars, opts.plainText === true)) {
      if (
        pending &&
        (unit.context ||
          pending.context ||
          unit.end - pending.start > maxChars ||
          utf8Bytes(raw.slice(pending.start, unit.end)) > MAX_CHUNK_BODY_BYTES)
      )
        flush();
      pending = pending ? { ...pending, end: unit.end } : { ...unit };
      if (
        pending.end - pending.start >= minChars &&
        raw.slice(pending.start, pending.end).trim()
      )
        flush();
    }
    flush();
  }
  return out;
}
