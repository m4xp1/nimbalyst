/**
 * Heading-aware markdown chunker.
 *
 * Splits a markdown document into ~minTokens..maxTokens chunks that never cross
 * a heading boundary, each carrying its full heading breadcrumb (`headingPath`)
 * so a hit can later expand to its whole section. Frontmatter is stripped and
 * fenced code headings are ignored. Oversized blocks, including code, are split
 * without losing their text so embedding input always stays bounded.
 */
import {documentFrontmatter} from './frontmatter.js';
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
  return text.slice(documentFrontmatter(text).bodyStart);
}

export function chunkMarkdown(sourcePath:string,sourceClass:string,raw:string,opts:ChunkOptions={},ref?:{refType?:string;refId?:string}):Chunk[]{
  const body=opts.plainText?raw:stripFrontmatter(raw);
  return body.trim()?structuredChunks(sourcePath,sourceClass,raw,raw.length-body.length,opts,ref):structuredChunks(sourcePath,sourceClass,raw,0,{...opts,plainText:true},ref);
}
