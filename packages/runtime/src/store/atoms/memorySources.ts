import {atom} from 'jotai';
import {store} from '../store';
/** Durable Memory-rule receipts shared by file-tree actions and the extension settings panel. */
export interface MemorySourceChange {
 workspacePath:string;rootId:string|null;revision:string;
 rules:{version:1;include:string[];exclude:string[]};
}
export const memorySourceChangeAtom=atom<MemorySourceChange|null>(null);
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
