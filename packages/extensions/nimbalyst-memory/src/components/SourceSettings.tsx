import { useEffect, useRef, useState } from 'react';
import { selectableSourceFolders, type SourceFolder } from './sourceFolders';
interface PathOverride {path:string;kind:"file"|"directory";mode:"include"|"exclude";}
interface Rules { version: 1; include: string[]; exclude: string[];overrides?:PathOverride[]; }
type Call = (name: string, params?: any) => Promise<any>;
const parse = (text: string) => text.split('\n').map(s => s.trim()).filter(Boolean);
export function SourceSettings({ callBackendTool, onApplied, onRootsChanged }: {
  callBackendTool?: Call; onApplied: () => void;onRootsChanged?:(roots:SourceFolder[])=>void;
}) {
  const [rootId,setRootId]=useState<string|null>(null);
  const [roots,setRoots]=useState<Array<{id:string|null;label:string;path:string;available:boolean}>>([]);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [pathOverrides,setPathOverrides]=useState<PathOverride[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bridge = useRef({ callBackendTool, onApplied, onRootsChanged });
  bridge.current = { callBackendTool, onApplied, onRootsChanged };
  const draft = useRef({ rootId:null as string|null, include: '', exclude: '', overrides:undefined as PathOverride[]|undefined, loaded: false, dirty: false });
  const live = useRef(false);
  const saved = useRef('');
  const submitted = useRef('');
  const queue = useRef<Promise<void>>(Promise.resolve());
  const flush = useRef<() => void>(() => {});
  flush.current = () => {
    const call = bridge.current.callBackendTool;
    if (!call || !draft.current.loaded || !draft.current.dirty) return;
    const rules: Rules = { version: 1, include: parse(draft.current.include), exclude: parse(draft.current.exclude),...(draft.current.overrides===undefined?{}:{overrides:draft.current.overrides}) };
    const id=draft.current.rootId;
    const key = JSON.stringify({rootId:id,...rules});
    if (key === submitted.current) return;
    submitted.current = key;
    queue.current = queue.current.then(async () => {
      try {
        await call('memory.set_sources', id ? {...rules,rootId:id} : rules);
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
    const current=++generation.current;
    setRootId(id);setLoaded(false);
    draft.current={rootId:id,include:'',exclude:'',overrides:undefined,loaded:false,dirty:false};
    setPathOverrides([]);
    try {
      await queue.current;
      const rules:Rules=await bridge.current.callBackendTool?.('memory.get_sources',id ? {rootId:id} : undefined);
      if(!live.current || current!==generation.current)return;
      const inc=rules.include.join('\n'),exc=rules.exclude.join('\n');
      draft.current={rootId:id,include:inc,exclude:exc,overrides:rules.overrides,loaded:true,dirty:false};
      setPathOverrides(rules.overrides??[]);
      saved.current=submitted.current=JSON.stringify({rootId:id,...rules});
      setInclude(inc);setExclude(exc);setLoaded(true);setError(null);
    }catch{if(live.current && current===generation.current)setError('Could not load saved sources.');}
  };
  useEffect(() => {
    live.current=true;
    void loadRoot(null);
    const refresh=()=>{void bridge.current.callBackendTool?.('memory.get_source_roots').then(value=>{
      if(live.current && Array.isArray(value)){
        const next=selectableSourceFolders(value);setRoots(next);bridge.current.onRootsChanged?.(next);
        if(draft.current.rootId && !next.some(root=>root.id===draft.current.rootId))void loadRoot(null);
      }
    }).catch(()=>{});};
    refresh();const timer=setInterval(refresh,2000);
    return ()=>{clearInterval(timer);flush.current();live.current=false;generation.current++;};
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
      an extension. Binary files are skipped.
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
    {pathOverrides.length>0 && <div className="nimbalyst-memory-path-overrides">
      <h4>File and folder overrides</h4>
      <p>The most specific path wins. Include can re-enable a file inside an excluded folder.</p>
      <ul>{pathOverrides.map((rule,index)=><li key={rule.kind+':'+rule.path}>
        <code>{rule.path||'.'}</code> — {rule.mode} ({rule.kind}){' '}
        <button type="button" aria-label={'Remove '+rule.mode+' override for '+(rule.path||'.')} disabled={!loaded} onClick={()=>{
          const next=pathOverrides.filter((_,i)=>i!==index);setPathOverrides(next);draft.current.overrides=next;draft.current.dirty=true;flush.current();
        }}>Use inherited rules</button>
      </li>)}</ul>
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
