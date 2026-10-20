import {useRef,useState} from 'react';
import {useAtom} from 'jotai';
import {memorySearchRootIdsAtomFamily} from '../store/atoms/memorySources';
import {useFloating,useClick,useDismiss,useInteractions,useRole,FloatingPortal,FloatingFocusManager,autoUpdate,offset,flip,shift} from '@floating-ui/react';
import type {MemorySourceFolder} from '../store/atoms/memorySources';
import {MaterialSymbol} from './icons/MaterialSymbol';
import {windowControlsClearance} from './floating/windowControlsClearance';

/** Uses the host's Jotai instance, including in dynamically loaded extensions. */
export function useMemorySearchRoots(workspacePath:string){return useAtom(memorySearchRootIdsAtomFamily(workspacePath));}

/** A presentation-only multi-folder selector shared by desktop Memory surfaces. */
export function MemorySourcePicker({sources,value,onChange}:{sources:MemorySourceFolder[];value:Array<string|null>|undefined;onChange:(value:Array<string|null>|undefined)=>void}){
  const [open,setOpen]=useState(false);
  const labels=useRef(new Map<string|null,MemorySourceFolder>());
  for(const root of sources)labels.current.set(root.id,root);
  const missing=(value??[]).filter(id=>!sources.some(root=>root.id===id));
  const options=[...sources,...missing.map(id=>({...labels.current.get(id),id,label:labels.current.get(id)?.label??'Detached source',path:labels.current.get(id)?.path??String(id),available:false}))];
  const {refs,floatingStyles,context}=useFloating({open,onOpenChange:setOpen,placement:'bottom-end',whileElementsMounted:autoUpdate,middleware:[offset(4),flip(),shift({padding:8}),windowControlsClearance()]});
  const {getReferenceProps,getFloatingProps}=useInteractions([useClick(context),useDismiss(context),useRole(context,{role:'dialog'})]);
  if(sources.length<=1&&!missing.length)return null;
  const summary=value===undefined?'All':value.length===1?options.find(root=>root.id===value[0])?.label??'Unavailable':`${value.length} folders`;
  const toggle=(id:string|null)=>{const next=value?.includes(id)?value.filter(current=>current!==id):[...value??[],id];onChange(next.length?next:undefined);};
  return <span className="memory-source-picker" style={{display:'inline-flex',flexShrink:0}}>
    <button ref={refs.setReference} type="button" {...getReferenceProps()} aria-label={`Sources: ${summary}`} style={{display:'flex',alignItems:'center',gap:6,padding:'8px 10px',border:'1px solid var(--nim-border)',borderRadius:6,background:'var(--nim-bg-secondary)',color:'var(--nim-text-muted)',cursor:'pointer',whiteSpace:'nowrap'}}>
      <span>Sources: {summary}</span><MaterialSymbol icon="expand_more" size={16}/>
    </button>
    {open&&<FloatingPortal><FloatingFocusManager context={context} modal={false} returnFocus>
      <div ref={refs.setFloating} {...getFloatingProps({onKeyDown:event=>event.stopPropagation()})} className="memory-source-picker__menu" aria-label="Memory source folders" style={{...floatingStyles,zIndex:100000,minWidth:240,maxWidth:520,maxHeight:350,overflowY:'auto',padding:8,border:'1px solid var(--nim-border)',borderRadius:6,background:'var(--nim-bg)',color:'var(--nim-text)'}}>
        <label style={{display:'flex',gap:8,padding:6,cursor:'pointer'}}><input type="checkbox" checked={value===undefined} onChange={()=>onChange(undefined)}/>All</label>
        {options.map(root=><label key={root.id??'primary'} title={root.path} style={{display:'flex',gap:8,padding:6,cursor:'pointer'}}>
          <input type="checkbox" aria-label={root.label} checked={value?.includes(root.id)??false} onChange={()=>toggle(root.id)}/>
          <span><span>{root.label}{!root.available?' (unavailable)':''}</span><small style={{display:'block',color:'var(--nim-text-muted)',overflowWrap:'anywhere'}}>{root.path}</small></span>
        </label>)}
        {!!missing.length&&<p role="alert" style={{margin:6}}>A selected source was detached. Change the selection to continue.</p>}
      </div>
    </FloatingFocusManager></FloatingPortal>}
  </span>;
}
