import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsPanelProps } from '@nimbalyst/runtime';
type Period = 'today' | '7d' | 'all';
interface Counts {
    attempts: number;
    succeeded: number;
    failed: number;
    unfinished: number;
    inputs: number;
    tokens: number;
    unknownUsage: number;
}
interface Usage {
    since: number;
    totals: Counts;
    reasons?: Record<string, Counts>;
    error?: string | null;
    developerMode?: boolean;
    logging?: {
        enabled: boolean;
        dropped: number;
    };
}
/** Reads only the small usage projection; never asks the engine to search or scan. */
export function EmbeddingUsageCard({ callBackendTool, workspacePath }: {
    callBackendTool: SettingsPanelProps['callBackendTool'];
    workspacePath?: string;
}) {
    const [period, setPeriod] = useState<Period>('today'), [usage, setUsage] = useState<Usage | null>(null), [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false);
    const sequence = useRef(0);
    const inFlight = useRef<number | null>(null);
    const refresh = useCallback(async () => { if (!callBackendTool)
        return; const current = sequence.current; if (inFlight.current === current) return; inFlight.current = current; try {
        const next = await callBackendTool('memory.get_embedding_usage', { period }) as Usage;
        if (current === sequence.current) {
            setUsage(next?.totals ? next : null);
            setError(null);
        }
    }
    catch {
        if (current === sequence.current)
            setError('Embedding usage could not be read.');
    } finally { if (inFlight.current === current) inFlight.current = null; } }, [callBackendTool, period, workspacePath]);
    useEffect(() => { setUsage(null); void refresh(); const timer = setInterval(() => void refresh(), 3000); return () => { clearInterval(timer); sequence.current++; }; }, [refresh]);
    const toggle = async (enabled: boolean) => { if (!callBackendTool)
        return; setSaving(true); try {
        await callBackendTool('memory.set_embedding_logging', { enabled });
        sequence.current++;
        await refresh();
    }
    catch {
        setError('Embedding request logging could not be changed.');
    }
    finally {
        setSaving(false);
    } };
    const counts = usage?.totals, number = (n: number | undefined) => n === undefined ? '—' : n.toLocaleString();
    return <section className="memory-embedding-usage" aria-label="Embedding usage" style={{ border: '1px solid var(--nim-border)', borderRadius: 8, padding: 16, margin: '0 0 20px' }}>
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}><h4 style={{ margin: 0 }}>Embedding usage</h4><select aria-label="Embedding usage period" value={period} onChange={event => setPeriod(event.target.value as Period)}><option value="today">Today (UTC)</option><option value="7d">7 days (UTC)</option><option value="all">All time</option></select></div>
  <div style={{ display: 'flex', gap: 32, marginTop: 14, flexWrap: 'wrap' }}>{[['Requests', number(counts?.attempts)], ['Inputs sent', number(counts?.inputs)], ['Reported tokens', counts && counts.unknownUsage === counts.attempts && counts.attempts > 0 ? 'No data' : number(counts?.tokens)]].map(([label, value]) => <div key={label}><strong style={{ fontSize: 24 }}>{value}</strong><div style={{ color: 'var(--nim-text-muted)' }}>{label}</div></div>)}</div>
  {counts && <p style={{ color: 'var(--nim-text-muted)' }}>{counts.succeeded} succeeded · {counts.failed} failed · {counts.unfinished} unfinished · {counts.unknownUsage} without reported token usage</p>}
  {usage && <p style={{ color: 'var(--nim-text-muted)', fontSize: 12 }}>Collected since {new Date(usage.since).toLocaleString()}. Counts survive restart and reset when the embedding configuration changes. Token usage can be incomplete; these counts are not a billing receipt.</p>}
  {usage?.reasons && Object.keys(usage.reasons).length > 0 && <details><summary>By operation</summary>{Object.entries(usage.reasons).map(([reason, row]) => <p key={reason}>{reason}: {row.attempts} requests · {row.inputs} inputs · {row.tokens} reported tokens</p>)}</details>}
  {usage?.developerMode && <label style={{ display: 'block', marginTop: 12 }}><input type="checkbox" disabled={saving} checked={usage.logging?.enabled === true} onChange={event => void toggle(event.target.checked)}/> Embedding request logging (local, no text or keys)</label>}
  {!!usage?.logging?.dropped && <p role="alert">{usage.logging.dropped} diagnostic log events could not be saved.</p>}
  {(error || usage?.error) && <p role="alert" style={{ color: 'var(--nim-error)' }}>{error ?? usage?.error}</p>}
 </section>;
}
