/** Conservative UTF-8 budgets, independent of token estimates and provider calls. */
export const MAX_EMBEDDING_INPUT_BYTES = 6000;
export const MAX_EMBEDDING_BATCH_BYTES = 240000;
export const MAX_CHUNK_BODY_BYTES = 5000;
const encoder = new TextEncoder();
export function utf8Bytes(text: string): number { return encoder.encode(text).length; }
/** Split only between Unicode code points; never discard content. */
export function splitUtf8(text: string, maxBytes: number, maxChars = Number.MAX_SAFE_INTEGER): string[] {
  const parts: string[] = [];
  let part = '', bytes = 0;
  for (const char of text) {
    const size = utf8Bytes(char);
    if (part && (bytes + size > maxBytes || part.length + char.length > maxChars)) {
      parts.push(part); part = ''; bytes = 0;
    }
    part += char; bytes += size;
  }
  if (part) parts.push(part);
  return parts;
}
export function utf8Prefix(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  let out = '', bytes = 0;
  for (const char of text) {
    const size = utf8Bytes(char);
    if (bytes + size > maxBytes) break;
    out += char; bytes += size;
  }
  return out;
}
export function embeddingInput(headingPath: string[], text: string): string {
  const crumb = utf8Prefix(headingPath.join(' > '), MAX_EMBEDDING_INPUT_BYTES - MAX_CHUNK_BODY_BYTES - 1);
  return crumb ? crumb + '\n' + text : text;
}
