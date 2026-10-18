export interface SourceFolder {id:string|null;path:string;label:string;available:boolean;}
/** Selectable workspace roots only, with aliases collapsed using host path spelling. */
export function selectableSourceFolders(value:unknown):SourceFolder[]{
 if(!Array.isArray(value))return[];
 const ids=new Set<string|null>(),paths=new Set<string>();
 return [...value].sort((a,b)=>a?.id===null?-1:b?.id===null?1:0).filter((root):root is SourceFolder=>{
  if(!root || root.id==='harness-memory' || (root.id!==null && typeof root.id!=='string') || typeof root.path!=='string' || typeof root.label!=='string')return false;
  let key=root.path.replace(/\\/g,'/').replace(/\/+$/,'');
  if(/^[a-z]:/i.test(key)||key.startsWith('//'))key=key.toLowerCase();
  if(ids.has(root.id)||paths.has(key))return false;
  ids.add(root.id);paths.add(key);return true;
 });
}
