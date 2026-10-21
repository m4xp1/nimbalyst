import path from 'node:path';
import {documentFrontmatter} from './frontmatter.js';
import {MAX_EMBEDDING_INPUT_BYTES,utf8Prefix} from './embeddingInput.js';
import {sha256} from './hash.js';
import type {Chunk,EmbedderInfo,SourceSearchRecord} from './types.js';
export const SOURCE_SEARCH_VERSION=1;
/** Flatten scalar values from an acyclic, expansion-bounded YAML graph. */
function fieldValues(data:Record<string,unknown>):Record<string,string[]> {
 const fields:Record<string,string[]>=Object.create(null);
 const stack=Object.entries(data).reverse().map(([key,value])=>({key,value}));
 while(stack.length){const {value,key}=stack.pop()!;
  if(value===null||value===undefined)continue;
  if(typeof value==='string'||typeof value==='number'||typeof value==='boolean'){(fields[key]??=[]).push(String(value));continue;}
  if(typeof value!=='object')continue;
  const items=Array.isArray(value)?value.map(item=>({key,value:item})):Object.entries(value).map(([name,item])=>({key:key?key+'.'+name:name,value:item}));for(const item of items.reverse())stack.push(item);
 }
 return fields;
}
export function sourceSearchRecord(sourcePath:string,sourceClass:string,raw:string,chunks:Chunk[],info:EmbedderInfo,ref?:{refType?:string;refId?:string},plainText=false):SourceSearchRecord {
 const parsed=plainText?{data:{},bodyStart:0}:documentFrontmatter(raw),fields=fieldValues(parsed.data);
 const relativePath=sourcePath.replace(/^@[^/]+\//,''),fileName=path.posix.basename(relativePath);
 const headings=[...new Set(chunks.flatMap(chunk=>chunk.headingPath))];
 const context=utf8Prefix([
  'File: '+fileName,'Path: '+relativePath,
  ...['title','description','aliases','tags'].flatMap(key=>fields[key]?.length?[key+': '+fields[key].join('; ')]:[]),
  headings.length?'Headings: '+headings.join(' > '):'',
 ].filter(Boolean).join('\n'),MAX_EMBEDDING_INPUT_BYTES);
 return{sourcePath,sourceClass,refType:ref?.refType??'doc-file',refId:ref?.refId??sourcePath,version:SOURCE_SEARCH_VERSION,fileName,relativePath,fields,context,contextHash:sha256(context),denseEmbedding:null,embedderId:info.id,model:info.model,dims:info.dims,...(parsed.warning?{warning:parsed.warning}:{}),...(parsed.bodyStart?{metadataRange:{start:0,end:parsed.bodyStart}}:{})};
}
