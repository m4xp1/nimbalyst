import {treePolicyIncludes,type MemoryTreePolicy} from '../../../../../extensions/nimbalyst-memory/engine/src/ruleProgram';
import {memorySourceChangeAtom,sameMemoryWorkspace,store} from '@nimbalyst/runtime/store';
import {memoryTreeAvailableAtom,memoryTreeIncludedPathsAtom,memoryTreePathKey,memoryTreeErrorsAtom,memoryTreeIndexingAtom} from '../atoms/memoryTree';
import {rawFileTreeAtom,type RendererFileTreeItem} from '../atoms/fileTree';
interface Context {workspacePath:string;disposed:boolean;epoch:number;busy:boolean;pending:boolean;revision?:string;policy?:MemoryTreePolicy;}
let active:Context|undefined;
function clear(){store.set(memoryTreeErrorsAtom,new Map<string,string>());store.set(memoryTreeIndexingAtom,false);store.set(memoryTreeAvailableAtom,false);store.set(memoryTreeIncludedPathsAtom,new Set<string>());}
function applyPolicy(ctx:Context,policy:MemoryTreePolicy):void {
 ctx.policy=policy;const included=new Set<string>(),nodes:RendererFileTreeItem[]=[...store.get(rawFileTreeAtom)];
 while(nodes.length){const node=nodes.pop()!;if(treePolicyIncludes(policy,node.path,node.type==='directory')){
   const key=memoryTreePathKey(node.path);included.add(key);
   // Loaded ancestors are marked from their included descendants below.
  }if(node.children)nodes.push(...node.children);}
 const ancestors=(items:RendererFileTreeItem[]):boolean=>{let any=false;for(const node of items){const child=node.children?ancestors(node.children):false;const has=included.has(memoryTreePathKey(node.path));if(child)included.add(memoryTreePathKey(node.path));any=any||has||child;}return any;};
 ancestors(store.get(rawFileTreeAtom));store.set(memoryTreeIncludedPathsAtom,included);store.set(memoryTreeAvailableAtom,true);
}
async function backend(ctx:Context,toolName:string,args:Record<string,unknown>={}){
 return window.electronAPI.invoke('extensions:ai-call-backend-tool',{toolName,args,workspacePath:ctx.workspacePath,callerExtensionId:'com.nimbalyst.memory'});
}
function applyState(ctx:Context,state:any):void {
 if(!state || typeof state.revision!=='string')throw Error('Memory source state unavailable');
 if(!state.unchanged){
  if(!Array.isArray(state.files)||!Array.isArray(state.directories))throw Error('Invalid Memory source state');
  if(state.treePolicy)applyPolicy(ctx,state.treePolicy);else if(ctx.policy)applyPolicy(ctx,ctx.policy);else store.set(memoryTreeIncludedPathsAtom,new Set([...state.files,...state.directories].map(memoryTreePathKey)));
  store.set(memoryTreeErrorsAtom,new Map((Array.isArray(state.errors)?state.errors:[]).map((error:{path:string;category:string})=>[memoryTreePathKey(error.path),error.category])));
  store.set(memoryTreeIndexingAtom,state.indexing===true);
 }
 ctx.revision=state.revision;store.set(memoryTreeAvailableAtom,true);
}
async function refresh(ctx:Context):Promise<void>{
 if(ctx.disposed||active!==ctx)return;
 if(ctx.busy){ctx.pending=true;return;}
 ctx.busy=true;const epoch=ctx.epoch;
 try{
  const enabled=await window.electronAPI.invoke('extensions:get-enabled','com.nimbalyst.memory',false);
  if(ctx.disposed||active!==ctx||epoch!==ctx.epoch)return;
  if(enabled!==true){ctx.revision=undefined;clear();return;}
  const state=await backend(ctx,'memory.get_tree_index_state',{...(ctx.revision?{revision:ctx.revision}:{}),policyOnly:true});
  if(ctx.disposed||active!==ctx||epoch!==ctx.epoch)return;
  applyState(ctx,state);
 }catch{if(!ctx.disposed&&active===ctx&&epoch===ctx.epoch){ctx.revision=undefined;}}
 finally{ctx.busy=false;if(ctx.pending&&!ctx.disposed){ctx.pending=false;void refresh(ctx);}}
}
/** One workspace-scoped poll and tree invalidation subscription; never one request per icon. */
export function initMemoryTreeListeners(workspacePath:string):()=>void{
 const ctx:Context={workspacePath,disposed:false,epoch:0,busy:false,pending:false};active=ctx;clear();
 const invalidate=()=>{ctx.epoch++;ctx.revision=undefined;if(ctx.policy)applyPolicy(ctx,ctx.policy);void refresh(ctx);};
 const stopTree=store.sub(rawFileTreeAtom,invalidate);
 const stopRules=store.sub(memorySourceChangeAtom,()=>{const change=store.get(memorySourceChangeAtom);if(sameMemoryWorkspace(change?.workspacePath,ctx.workspacePath)){ctx.epoch++;ctx.revision=undefined;if(change?.treePolicy)applyPolicy(ctx,change.treePolicy as MemoryTreePolicy);else void refresh(ctx);}});
 const timer=setInterval(()=>void refresh(ctx),2000);void refresh(ctx);
 return()=>{ctx.disposed=true;ctx.epoch++;clearInterval(timer);stopTree();stopRules();if(active===ctx){active=undefined;clear();}};
}
export async function changeMemoryTreeRule(path:string,mode:'include'|'exclude'):Promise<void>{
 const ctx=active;if(!ctx||ctx.disposed||!store.get(memoryTreeAvailableAtom))throw Error('Memory is not available for this workspace.');
 ctx.epoch++;ctx.revision=undefined;
 const receipt=await backend(ctx,'memory.set_path_override',{path,mode});
 if(ctx.disposed||active!==ctx)return;
 if(receipt?.rules&&typeof receipt.revision==='string')store.set(memorySourceChangeAtom,{workspacePath:ctx.workspacePath,rootId:receipt.rootId??null,rules:receipt.rules,revision:receipt.revision,treePolicy:receipt.treePolicy});
 ctx.epoch++;ctx.revision=undefined;
 if(receipt?.treePolicy)applyPolicy(ctx,receipt.treePolicy);
 else if(receipt?.treeState)applyState(ctx,receipt.treeState);
 else void refresh(ctx);
}
