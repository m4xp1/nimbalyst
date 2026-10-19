/**
 * Heading-aware markdown chunker.
 *
 * Splits a markdown document into ~minTokens..maxTokens chunks that never cross
 * a heading boundary, each carrying its full heading breadcrumb (`headingPath`)
 * so a hit can later expand to its whole section. Frontmatter is stripped and
 * fenced code headings are ignored. Oversized blocks, including code, are split
 * without losing their text so embedding input always stays bounded.
 */
import {structuredChunks} from './structuredChunks.js';
import type { Chunk } from './types.js';

const CHARS_PER_TOKEN = 4;

/** Rough token estimate (no tokenizer dependency): ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface ChunkOptions {
  /** Plain text preserves leading --- blocks and does not interpret headings. */
  plainText?: boolean;
  minTokens?: number;
  maxTokens?: number;
}

/** Strip a leading YAML frontmatter block (`--- ... ---`). */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text;
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return lines.slice(i + 1).join('\n');
    }
  }
  return text;
}

export function chunkMarkdown(sourcePath:string,sourceClass:string,raw:string,opts:ChunkOptions={},ref?:{refType?:string;refId?:string}):Chunk[]{
  const body=opts.plainText?raw:stripFrontmatter(raw);
  return structuredChunks(sourcePath,sourceClass,raw,raw.length-body.length,opts,ref);
}
