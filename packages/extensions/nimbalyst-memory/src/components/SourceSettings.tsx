import { useEffect, useRef, useState } from 'react';
import {memorySourceChanges,sameMemoryWorkspace} from '@nimbalyst/runtime';
import { selectableSourceFolders, type SourceFolder } from './sourceFolders';
interface Rules { version: 1; include: string[]; exclude: string[];revision?:string;}
type Call = (name: string, params?: any) => Promise<any>;
const parse = (text: string) => text.split('\n').map(s => s.trim()).filter(Boolean);
export function SourceSettings({ callBackendTool, onApplied, onRootsChanged,workspacePath }: {
  workspacePath?:string;callBackendTool?: Call; onApplied: () => void;onRootsChanged?:(roots:SourceFolder[])=>void;
}) {
  const [rootId,setRootId]=useState<string|null>(null);
  const [roots,setRoots]=useState<Array<{id:string|null;label:string;path:string;available:boolean}>>([]);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bridge = useRef({ callBackendTool, onApplied, onRootsChanged });
  bridge.current = { callBackendTool, onApplied, onRootsChanged };
  const draft = useRef({ rootId:null as string|null, include: '', exclude: '', loaded: false, dirty: false });
  const live = useRef(false);
  const revisions=useRef(new Map<string|null,string>());
  const drafts=useRef(new Map<string|null,typeof draft.current>());
  const [conflict,setConflict]=useState(false);
  const adopt=useRef((id:string|null,rules:Rules)=>{});
  adopt.current=(id,rules)=>{
    if(draft.current.rootId!==id||!live.current)return;
    if(draft.current.dirty){setConflict(true);setError('Saved rules changed elsewhere. Your draft is kept; reload the saved rules before saving again.');return;}
    const inc=rules.include.join('\n'),exc=rules.exclude.join('\n');
    if(rules.revision)revisions.current.set(id,rules.revision);
    draft.current={rootId:id,include:inc,exclude:exc,loaded:true,dirty:false};
    saved.current=submitted.current=JSON.stringify({rootId:id,version:1,include:rules.include,exclude:rules.exclude});
    setInclude(inc);setExclude(exc);setLoaded(true);setError(null);setConflict(false);
  };
  const saved = useRef('');
  const submitted = useRef('');
  const queue = useRef<Promise<void>>(Promise.resolve());
  const flush = useRef<() => void>(() => {});
  flush.current = () => {
    const call = bridge.current.callBackendTool;
    if (!call || !draft.current.loaded || !draft.current.dirty) return;
    const rules: Rules = { version: 1, include: parse(draft.current.include), exclude: parse(draft.current.exclude) };
    const id=draft.current.rootId;
    const key = JSON.stringify({rootId:id,...rules});
    if (key === submitted.current) return;
    submitted.current = key;
    queue.current = queue.current.then(async () => {
      try {
        const expectedRevision=revisions.current.get(id);
        const receipt=await call('memory.set_sources',{...rules,...(id?{rootId:id}:{}),...(expectedRevision?{expectedRevision}:{})});
        if(receipt?.revision)revisions.current.set(id,receipt.revision);
        const cached=drafts.current.get(id);
        if(cached&&JSON.stringify({rootId:id,version:1,include:parse(cached.include),exclude:parse(cached.exclude)})===key)drafts.current.delete(id);
        if(draft.current.rootId===id&&draft.current.loaded)generation.current++;
        if(draft.current.rootId===id&&JSON.stringify({rootId:id,version:1,include:parse(draft.current.include),exclude:parse(draft.current.exclude)})===key)draft.current.dirty=false;
        if(workspacePath&&receipt?.revision)memorySourceChanges.publish({workspacePath,rootId:id,rules,revision:receipt.revision});
        if(draft.current.rootId===id)saved.current = key;
        if (live.current && draft.current.rootId===id) { setError(null); bridge.current.onApplied(); }
      } catch {
        if(draft.current.rootId!==id)return;
        if (submitted.current === key) submitted.current = saved.current;
        if (live.current) setError('Could not finish saving sources. Check paths and index status; focus and leave a field to try again.');
        else console.error('[memory] Could not save sources when closing settings.');
      }
    });
  };
  const generation=useRef(0);
  const loadRoot = async (id:string|null) => {
    flush.current();
    drafts.current.set(draft.current.rootId,{...draft.current});
    const current=++generation.current;
    setRootId(id);setLoaded(false);
    draft.current={rootId:id,include:'',exclude:'',loaded:false,dirty:false};
    try {
      await queue.current;
      const rules:Rules=await bridge.current.callBackendTool?.('memory.get_sources',id ? {rootId:id} : undefined);
      if(!live.current || current!==generation.current)return;
      const cached=drafts.current.get(id);
      if(cached?.dirty){draft.current=cached;setInclude(cached.include);setExclude(cached.exclude);setLoaded(true);setConflict(true);setError('Your unsaved draft is kept. Reload the saved rules to discard it.');}
      else adopt.current(id,rules);
    }catch{if(live.current && current===generation.current)setError('Could not load saved sources.');}
  };
  useEffect(() => {
    live.current=true;
    void loadRoot(null);
    const refresh=()=>{void bridge.current.callBackendTool?.('memory.get_source_roots').then(value=>{
      if(live.current && Array.isArray(value)){
        const next=selectableSourceFolders(value);setRoots(next);
        const remote=next.find(root=>root.id===draft.current.rootId)?.rulesRevision;
        if(draft.current.loaded&&remote&&remote!==revisions.current.get(draft.current.rootId)){
          const id=draft.current.rootId,current=generation.current;
          void bridge.current.callBackendTool?.('memory.get_sources',id?{rootId:id}:undefined).then(rules=>{if(live.current&&current===generation.current)adopt.current(id,rules);}).catch(()=>{});
        }bridge.current.onRootsChanged?.(next);
        if(draft.current.rootId && !next.some(root=>root.id===draft.current.rootId))void loadRoot(null);
      }
    }).catch(()=>{});};
    refresh();const timer=setInterval(refresh,2000);
    const stop=memorySourceChanges.subscribe(change=>{if(change&&change.rootId===draft.current.rootId&&sameMemoryWorkspace(change.workspacePath,workspacePath)&&change.revision!==revisions.current.get(change.rootId)){generation.current++;adopt.current(change.rootId,{...change.rules,revision:change.revision});}});
    return ()=>{stop();clearInterval(timer);flush.current();live.current=false;generation.current++;};
  }, []);
  const field = { width: '100%', minHeight: 75, fontFamily: 'monospace',
    background: 'var(--nim-bg)', color: 'var(--nim-text)', border: '1px solid var(--nim-border)', borderRadius: 6, padding: 8 } as const;
  return <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Additional text sources</h3>
    {roots.length>1 && <label>Source folder<select aria-label="Source folder" value={rootId??''} disabled={!loaded}
      onChange={event=>{void loadRoot(event.target.value||null);}}>
      {roots.map(root=><option key={root.id??'primary'} value={root.id??''}>{root.label} — {root.path}{root.available?'':' (unavailable)'}</option>)}
    </select></label>}
    {roots.some(root=>!root.available) && <p role="alert">Some source folders are unavailable. Their old search results have been removed.</p>}
    <p style={{ margin: 0, color: 'var(--nim-text-muted)', lineHeight: 1.5 }}>
      Add files relative to the selected source folder, folders or globs, one per line. Additional sources
      support UTF-8 text of any extension, including JSON, YAML, code and files without
      an extension. Binary files are skipped. A narrower path takes precedence: Include docs/myfile.md
      re-enables that file inside Exclude docs. Equally specific exclusions win.
    </p>
    <p style={{ margin: 0, color: 'var(--nim-text-muted)', lineHeight: 1.5 }}>
      Built-in Markdown sources: docs/, design/, nimbalyst-local/plans/,
      nimbalyst-local/voice-memory/, CLAUDE.md, AGENTS.md and .claude/rules/
      (including nested instruction files and rule folders). Personal harness memory,
      trackers and optional sessions are indexed separately.
    </p>
    <label>Include<textarea aria-label="Additional source includes" disabled={!loaded} style={field}
      value={include} onChange={e => { draft.current.include = e.target.value; draft.current.dirty = true; setInclude(e.target.value); }}
      onBlur={() => flush.current()} placeholder={'MAP.md\nresearch/\nconfig/**/*.json'} /></label>
    <label>Exclude<textarea aria-label="Source excludes" disabled={!loaded} style={field}
      value={exclude} onChange={e => { draft.current.exclude = e.target.value; draft.current.dirty = true; setExclude(e.target.value); }}
      onBlur={() => flush.current()} placeholder="research/drafts/**" /></label>
    {error && <p role="alert">{error}</p>}
    {conflict&&<button type="button" onClick={()=>{draft.current.dirty=false;drafts.current.delete(rootId);void loadRoot(rootId);}}>Reload saved rules</button>}
  </section>;
}
