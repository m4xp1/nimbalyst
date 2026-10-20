import {atom} from 'jotai';
import {atomFamily} from 'jotai-family';
import {store} from '../store';
/** Durable Memory-rule receipts shared by file-tree actions and the extension settings panel. */
export interface MemorySourceChange {
 workspacePath:string;rootId:string|null;revision:string;
 rules:{version:1;include:string[];exclude:string[]};
 /** Serialized, browser-safe rule program supplied with the durable receipt. */
 treePolicy?:unknown;
}
export const memorySourceChangeAtom=atom<MemorySourceChange|null>(null);
export interface MemorySourceFolder {id:string|null;label:string;path:string;available:boolean;}
/** Host-owned metadata, updated by the central Memory listener, never one RPC per picker. */
export const memorySourceFoldersAtomFamily=atomFamily((_workspacePath:string)=>atom<MemorySourceFolder[]>([]));
/** Session-local selection; undefined means All, never persisted into indexing rules. */
export const memorySearchRootIdsAtomFamily=atomFamily((_workspacePath:string)=>atom<Array<string|null>|undefined>(undefined));
export function sameMemoryWorkspace(a:string|undefined,b:string|undefined):boolean {
 if(!a||!b)return false;
 const key=(p:string)=>{const s=p.replace(/\\/g,'/').replace(/\/+$/,'');return /^[a-z]:/i.test(s)||s.startsWith('//')?s.toLowerCase():s;};
 return key(a)===key(b);
}

/** Renderer-only notifications, never a backend capability or a rule write route. */
export const memorySourceChanges={
 publish(change:MemorySourceChange):void{store.set(memorySourceChangeAtom,change);},
 subscribe(listener:(change:MemorySourceChange)=>void):()=>void{return store.sub(memorySourceChangeAtom,()=>{const change=store.get(memorySourceChangeAtom);if(change)listener(change);});},
};
