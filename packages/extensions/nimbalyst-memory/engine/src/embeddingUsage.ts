import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
export interface EmbeddingCallContext {
    operationId?: string;
    reason?: string;
    origin?: 'interface' | 'agent' | 'background' | 'unknown';
    sources?: Array<{
        sourcePath: string;
        kind?: string;
    }>;
}
export interface EmbeddingRequest {
    id: string;
    epoch: string;
    day: string;
    reason: string;
    startedAt: number;
    inputs: number;
    bytes: number;
    context: EmbeddingCallContext;
}
export interface EmbeddingOutcome {
    state: 'succeeded' | 'failed';
    tokens?: number;
    code?: string;
    providerRequestId?: string;
}
interface Counts {
    attempts: number;
    succeeded: number;
    failed: number;
    unfinished: number;
    inputs: number;
    bytes: number;
    tokens: number;
    unknownUsage: number;
}
const knownReasons = new Set(["startup-or-scan", "startup-session", "startup-tracker", "session-change", "tracker-change", "search", "rules", "watch", "background", "rebuild", "unknown"]);
const empty = (): Counts => ({ attempts: 0, succeeded: 0, failed: 0, unfinished: 0, inputs: 0, bytes: 0, tokens: 0, unknownUsage: 0 });
interface Saved {
    version: 1;
    identity: string;
    epoch: string;
    since: number;
    totals: Counts;
    days: Record<string, Counts>;
    reasons: Record<string, Counts>;
    dayReasons: Record<string, Record<string, Counts>>;
    pending: Record<string, EmbeddingRequest>;
}
/** Small derived counters, independent of the index and of optional request logging. */
export class EmbeddingUsage {
    private state: Saved;
    private file: string;
    private readOnly = false;
    private error: string | null = null;
    private logError: string | null = null;
    private logging = false;
    private queue: Promise<void> = Promise.resolve();
    private queued = 0;
    private dropped = 0;
    constructor(private directory: string, identity: string) {
        this.file = path.join(directory, 'embedding-usage.json');
        this.state = this.fresh(identity);
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Saved;
            const valid = (row: Counts) => row && Object.keys(empty()).every(key => Number.isSafeInteger(row[key as keyof Counts]) && row[key as keyof Counts] >= 0);
            if (data.version !== 1 || !valid(data.totals) || !data.pending || !data.days || !data.reasons || typeof data.epoch !== 'string' || typeof data.identity !== 'string' || !Number.isFinite(data.since) || ![...Object.values(data.days), ...Object.values(data.reasons), ...Object.values(data.dayReasons ?? {}).flatMap(rows => Object.values(rows))].every(valid))
                throw Error('invalid counters');
            if (data.identity === identity) {
                data.dayReasons ??= {};
                // A previous process cannot confirm these packets. Keep the counters,
                // but do not retain orphaned source contexts indefinitely.
                data.pending = {};
                this.state = data;
            }
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.readOnly = true;
                this.error = 'Saved embedding statistics could not be read; previous data was preserved.';
            }
        }
        this.save();
    }
    private fresh(identity: string): Saved { return { version: 1, identity, epoch: randomUUID(), since: Date.now(), totals: empty(), days: {}, reasons: {}, dayReasons: {}, pending: {} }; }
    reset(identity: string): void { if (this.state.identity === identity)
        return; this.state = this.fresh(identity); this.save(); }
    setLogging(enabled: boolean): void { this.logging = enabled; }
    private save(): void { if (this.readOnly)
        return; try {
        fs.mkdirSync(this.directory, { recursive: true });
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state) + '\n');
        fs.renameSync(this.file + '.tmp', this.file);
        this.error = null;
    }
    catch {
        this.error = 'Embedding statistics could not be saved; current counts may not survive restart.';
    } }
    private groups(request: EmbeddingRequest): Counts[] { return [this.state.totals, this.state.days[request.day] ??= empty(), this.state.reasons[request.reason] ??= empty(), (this.state.dayReasons[request.day] ??= {})[request.reason] ??= empty()]; }
    start(inputs: number, bytes: number, context: EmbeddingCallContext = {}): EmbeddingRequest { const now = Date.now(); const reason = knownReasons.has(context.reason ?? 'unknown') ? context.reason ?? 'unknown' : 'unknown'; const grouped = new Map<string, {
        sourcePath: string;
        kind?: string;
        inputs: number;
    }>(); for (const source of context.sources ?? []) {
        const sourcePath = path.isAbsolute(source.sourcePath) ? '[absolute path omitted]' : source.sourcePath.slice(0, 1024);
        const key = JSON.stringify([sourcePath, source.kind]);
        const row = grouped.get(key);
        if (row)
            row.inputs++;
        else if (grouped.size < 128)
            grouped.set(key, { sourcePath, kind: source.kind?.slice(0, 64), inputs: 1 });
    } const safe: EmbeddingCallContext = { operationId: context.operationId?.slice(0, 128), reason, origin: context.origin ?? 'unknown', sources: [...grouped.values()] }; const request: EmbeddingRequest = { id: randomUUID(), epoch: this.state.epoch, day: new Date(now).toISOString().slice(0, 10), reason: safe.reason!, startedAt: now, inputs, bytes, context: safe }; for (const row of this.groups(request)) {
        row.attempts++;
        row.unfinished++;
        row.unknownUsage++;
        row.inputs += inputs;
        row.bytes += bytes;
    } this.state.pending[request.id] = request; const cutoff = new Date(now - 8 * 86400000).toISOString().slice(0, 10); for (const day of Object.keys(this.state.days))
        if (day < cutoff) {
            delete this.state.days[day];
            delete this.state.dayReasons[day];
        } this.save(); this.log({ event: 'started', ...request }); return request; }
    finish(request: EmbeddingRequest, outcome: EmbeddingOutcome): void { if (request.epoch !== this.state.epoch || !this.state.pending[request.id])
        return; delete this.state.pending[request.id]; const known = Number.isSafeInteger(outcome.tokens) && outcome.tokens! >= 0; for (const row of this.groups(request)) {
        row.unfinished--;
        row[outcome.state]++;
        if (known) {
            row.tokens += outcome.tokens!;
            row.unknownUsage--;
        }
    } this.save(); this.log({ event: 'finished', ...request, durationMs: Date.now() - request.startedAt, state: outcome.state, ...(known ? { tokens: outcome.tokens } : {}), code: outcome.code?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64), providerRequestId: outcome.providerRequestId?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128) }); }
    summary(period: 'today' | '7d' | 'all' = 'today') { const totals = empty(); if (period === 'all')
        Object.assign(totals, this.state.totals);
    else {
        const start = new Date(Date.now() - (period === '7d' ? 6 : 0) * 86400000).toISOString().slice(0, 10);
        for (const [day, row] of Object.entries(this.state.days))
            if (day >= start)
                for (const key of Object.keys(totals) as Array<keyof Counts>)
                    totals[key] += row[key];
    } return { since: this.state.since, epoch: this.state.epoch, period, timezone: 'UTC', totals, reasons: period === 'all' ? this.state.reasons : Object.fromEntries([...new Set(Object.entries(this.state.dayReasons).filter(([day]) => day >= new Date(Date.now() - (period === '7d' ? 6 : 0) * 86400000).toISOString().slice(0, 10)).flatMap(([, rows]) => Object.keys(rows)))].map(reason => { const result = empty(); for (const [day, rows] of Object.entries(this.state.dayReasons)) {
            if (day < new Date(Date.now() - (period === '7d' ? 6 : 0) * 86400000).toISOString().slice(0, 10))
                continue;
            for (const key of Object.keys(result) as Array<keyof Counts>)
                result[key] += rows[reason]?.[key] ?? 0;
        } return [reason, result]; })), error: this.error ?? this.logError, logging: { enabled: this.logging, dropped: this.dropped } }; }
    private log(event: unknown): void { if (!this.logging)
        return; if (this.queued >= 1024) {
        this.dropped++;
        return;
    } this.queued++; const line = JSON.stringify(event) + '\n'; this.queue = this.queue.then(async () => { const file = path.join(this.directory, 'embedding-requests.jsonl'); let size = 0; try {
        size = (await fsp.stat(file)).size;
    }
    catch { } if (size + Buffer.byteLength(line) > 2 * 1024 * 1024) {
        for (let i = 4; i >= 1; i--) {
            const from = i === 1 ? file : file + '.' + (i - 1), to = file + '.' + i;
            try {
                await fsp.rm(to, { force: true });
                await fsp.rename(from, to);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
            }
        }
    } await fsp.appendFile(file, line); }).catch(() => { this.dropped++; this.logError = 'Embedding request log could not be written.'; }).finally(() => { this.queued--; }); }
    async close(): Promise<void> { await this.queue; }
}
