import path from 'node:path';
import {realpath,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {MemorySourceRoot} from './attachedSources';
import type {SourceRules} from '../engine/dist/index.js';
const key=(p:string)=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
function inside(base:string,file:string){const a=key(base),b=key(file);return a===b||b.startsWith(a+path.sep);}
export function treeOwningRoot(roots:MemorySourceRoot[],file:string):MemorySourceRoot|undefined{
 const matches=roots.filter(root=>root.available&&inside(root.path,file));
 return matches.find(root=>root.id===null)??matches.sort((a,b)=>b.path.length-a.path.length)[0];
}
export async function resolveTreeTarget(roots:MemorySourceRoot[],value:unknown){
 if(typeof value!=='string'||!path.isAbsolute(value)||value.includes('\0'))throw Error('Choose a file or folder inside this workspace.');
 const absolute=await realpath(value),root=treeOwningRoot(roots,absolute);
 if(!root)throw Error('The path is outside the available workspace source roots.');
 const info=await stat(absolute);if(!info.isFile()&&!info.isDirectory())throw Error('Unsupported source path.');
 return{absolute,root,relative:path.relative(root.path,absolute).split(path.sep).join('/'),kind:info.isDirectory()?'directory' as const:'file' as const};
}
export async function buildTreeIndexState(filePaths:string[],roots:MemorySourceRoot[],rulesForRoot:(id:string|null)=>SourceRules,diagnostics:{indexing:boolean;failures:Array<{sourcePath:string;relativePath?:string;rootId:string|null;error:{category:string}}> }={indexing:false,failures:[]}){
 const files=new Set<string>(),directories=new Map<string,boolean>();
 for(const file of filePaths){const root=treeOwningRoot(roots,file);if(!root)continue;files.add(file);
  for(let dir=path.dirname(file);inside(root.path,dir);dir=path.dirname(dir)){
   directories.set(dir,true);if(key(dir)===key(root.path))break;
  }
 }
 for(const root of roots.filter(root=>root.available))for(const override of rulesForRoot(root.id).overrides??[]){
  if(override.mode!=='include'||override.kind!=='directory')continue;
  const target=path.resolve(root.path,override.path);
  try{const resolved=await resolveTreeTarget(roots,target);if(resolved.root.id!==root.id||resolved.kind!=='directory')continue;
   directories.set(resolved.absolute,true);
   for(let dir=path.dirname(resolved.absolute);inside(root.path,dir);dir=path.dirname(dir)){directories.set(dir,true);if(key(dir)===key(root.path))break;}
  }catch{/* Missing or inaccessible rules remain visible in settings, not as confirmed tree membership. */}
 }
 const aliases=(file:string)=>{const root=treeOwningRoot(roots,file);if(!root)return[];const relative=path.relative(root.path,file);return [...new Set([file,...(root.treePaths??[]).map(alias=>path.join(alias,relative))])];};
 const errors=diagnostics.failures.flatMap(f=>{if(f.sourcePath.startsWith('@harness-memory/'))return[];const root=roots.find(root=>root.id===f.rootId);if(!root)return[];
  const relative=f.relativePath??(f.rootId?f.sourcePath.slice(f.rootId.length+2):f.sourcePath);
  const absolute=path.resolve(root.path,relative);if(!inside(root.path,absolute))return[];
  return aliases(absolute).map(path=>({path,category:f.error.category}));
 });
 const state={indexing:diagnostics.indexing,errors,files:[...new Set([...files].flatMap(aliases))].sort(),directories:[...new Set([...directories.keys()].flatMap(aliases))].sort(),roots:roots.map(({id,path,label,available})=>({id,path,label,available}))};
 return{...state,revision:createHash('sha256').update(JSON.stringify(state)).digest('hex')};
}
