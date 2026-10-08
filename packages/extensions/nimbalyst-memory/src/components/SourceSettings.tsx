import { useEffect, useRef, useState } from 'react';
interface Rules { version: 1; include: string[]; exclude: string[]; }
type Call = (name: string, params?: any) => Promise<any>;
const parse = (text: string) => text.split('\n').map(s => s.trim()).filter(Boolean);
export function SourceSettings({ callBackendTool, onApplied }: {
  callBackendTool?: Call; onApplied: () => void;
}) {
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bridge = useRef({ callBackendTool, onApplied });
  bridge.current = { callBackendTool, onApplied };
  const draft = useRef({ include: '', exclude: '', loaded: false, dirty: false });
  const live = useRef(false);
  const saved = useRef('');
  const submitted = useRef('');
  const queue = useRef<Promise<void>>(Promise.resolve());
  const flush = useRef<() => void>(() => {});
  flush.current = () => {
    const call = bridge.current.callBackendTool;
    if (!call || !draft.current.loaded || !draft.current.dirty) return;
    const rules: Rules = { version: 1, include: parse(draft.current.include), exclude: parse(draft.current.exclude) };
    const key = JSON.stringify(rules);
    if (key === submitted.current) return;
    submitted.current = key;
    queue.current = queue.current.then(async () => {
      try {
        await call('memory.set_sources', rules);
        saved.current = key;
        if (live.current) { setError(null); bridge.current.onApplied(); }
      } catch {
        if (submitted.current === key) submitted.current = saved.current;
        if (live.current) setError('Could not finish saving sources. Check paths and index status; focus and leave a field to try again.');
        else console.error('[memory] Could not save sources when closing settings.');
      }
    });
  };
  useEffect(() => {
    live.current = true;
    void bridge.current.callBackendTool?.('memory.get_sources').then((rules: Rules) => {
      if (!live.current || draft.current.dirty) return;
      const inc = rules.include.join('\n'), exc = rules.exclude.join('\n');
      draft.current = { include: inc, exclude: exc, loaded: true, dirty: false };
      saved.current = submitted.current = JSON.stringify(rules);
      setInclude(inc); setExclude(exc); setLoaded(true);
    }).catch(() => { if (live.current) setError('Could not load saved sources.'); });
    return () => { flush.current(); live.current = false; };
  }, []);
  const field = { width: '100%', minHeight: 75, fontFamily: 'monospace',
    background: 'var(--nim-bg)', color: 'var(--nim-text)', border: '1px solid var(--nim-border)', borderRadius: 6, padding: 8 } as const;
  return <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Additional text sources</h3>
    <p style={{ margin: 0, color: 'var(--nim-text-muted)', lineHeight: 1.5 }}>
      Add workspace-relative files, folders or globs, one per line. Additional sources
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
    {error && <p role="alert">{error}</p>}
  </section>;
}
