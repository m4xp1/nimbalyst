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
/** Current projection preserves the closest heading and reserves separate continuation context. */
export function embeddingInput(headingPath:string[],text:string,context?:string):string {
 let crumb='';
 for(let i=headingPath.length-1;i>=0;i--){const title=utf8Prefix(headingPath[i],499);const candidate=title+(crumb?' > '+crumb:'');if(utf8Bytes(candidate)>499)break;crumb=candidate;}
 const prefix=[crumb,context?utf8Prefix(context,499):''].filter(Boolean).join('\n');
 return prefix?prefix+'\n'+text:text;
}
/** Reconstruct exactly what pre-projection stores embedded; never relabel an old vector as new. */
export function legacyEmbeddingInput(headingPath:string[],text:string):string {
 const crumb=utf8Prefix(headingPath.join(' > '),MAX_EMBEDDING_INPUT_BYTES-MAX_CHUNK_BODY_BYTES-1);return crumb?crumb+'\n'+text:text;
}
export function validateEmbeddingResponse(vectors:unknown,count:number,dims:number):asserts vectors is number[][] {
 if(!Array.isArray(vectors)||vectors.length!==count||vectors.some(vector=>!Array.isArray(vector)||vector.length!==dims||vector.some(value=>typeof value!=='number'||!Number.isFinite(value)||!Number.isFinite(Math.fround(value)))))throw Object.assign(Error('Invalid embedding response: vector count, dimensions or values do not match the request.'),{code:'EMBEDDING_RESPONSE_INVALID',status:502});
}
