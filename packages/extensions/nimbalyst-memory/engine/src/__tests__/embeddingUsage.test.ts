// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EmbeddingUsage } from '../embeddingUsage';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true }); });
describe('physical embedding request ledger', () => {
    it('retains successful sub-batches of failed operations, persists, and rejects old-generation completions', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'embedding-usage-'));
        dirs.push(dir);
        let usage = new EmbeddingUsage(dir, 'openai:model:2');
        const a = usage.start(128, 8000, { operationId: 'operation', reason: 'session-change' });
        usage.finish(a, { state: 'succeeded', tokens: 500 });
        const b = usage.start(2, 100, { operationId: 'operation', reason: 'session-change' });
        usage.finish(b, { state: 'failed', code: 'HTTP_500' });
        expect(usage.summary('all').totals).toMatchObject({ attempts: 2, succeeded: 1, failed: 1, inputs: 130, tokens: 500, unknownUsage: 1 });
        usage = new EmbeddingUsage(dir, 'openai:model:2');
        expect(usage.summary('all').totals.attempts).toBe(2);
        const pending = usage.start(1, 20);
        usage.reset('local:model:2');
        usage.finish(pending, { state: 'succeeded', tokens: 15 });
        expect(usage.summary('all').totals.attempts).toBe(0);
    });
});
it('counts every HTTP sub-batch even when a later packet fails, without real network', async () => {
    const { OpenAIEmbedder } = await import('../embedders/openaiEmbedder');
    const { vi } = await import('vitest');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'embedding-http-'));
    dirs.push(dir);
    const usage = new EmbeddingUsage(dir, 'openai:model:2');
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; return calls === 2 ? { ok: false, status: 500, text: async () => '' } : { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }], usage: { total_tokens: 17 } }) }; }));
    try {
        const embedder = new OpenAIEmbedder({ apiKey: 'synthetic', dims: 2, batchSize: 1, requestAllowed: () => true, usageLedger: usage });
        await expect(embedder.embed(['one', 'two'])).rejects.toThrow();
        expect(usage.summary('all').totals).toMatchObject({ attempts: 2, succeeded: 1, failed: 1, tokens: 17, unknownUsage: 1 });
    }
    finally {
        vi.unstubAllGlobals();
        await usage.close();
    }
});
it('keeps the optional journal text-free, rotates it, and stops recording when disabled', async () => {
    const fs = await import('node:fs');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'embedding-log-'));
    dirs.push(dir);
    const usage = new EmbeddingUsage(dir, 'openai:model:2');
    const first = usage.start(1, 9);
    usage.finish(first, { state: 'succeeded', tokens: 0 });
    await usage.close();
    expect(fs.existsSync(path.join(dir, 'embedding-requests.jsonl'))).toBe(false);
    fs.writeFileSync(path.join(dir, 'embedding-requests.jsonl'), 'x'.repeat(2 * 1024 * 1024));
    usage.setLogging(true);
    const request = usage.start(2, 20, { operationId: 'synthetic-op', reason: 'search', sources: [{ sourcePath: 'docs/synthetic.md' }], text: 'PRIVATE_BODY', apiKey: 'PRIVATE_KEY' } as any);
    usage.finish(request, { state: 'succeeded', tokens: 7 });
    await usage.close();
    expect(fs.existsSync(path.join(dir, 'embedding-requests.jsonl.1'))).toBe(true);
    const log = fs.readFileSync(path.join(dir, 'embedding-requests.jsonl'), 'utf8');
    expect(log).not.toMatch(/PRIVATE_BODY|PRIVATE_KEY/);
    expect(log).toContain('synthetic-op');
    expect(log.trim().split('\n')).toHaveLength(2);
    usage.setLogging(false);
    const denied = usage.start(1, 3);
    usage.finish(denied, { state: 'failed' });
    await usage.close();
    expect(fs.readFileSync(path.join(dir, 'embedding-requests.jsonl'), 'utf8')).toBe(log);
});
it('preserves corrupt diagnostic files and surfaces missing durability instead of silently overwriting', async () => {
    const fs = await import('node:fs');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'embedding-bad-'));
    dirs.push(dir);
    const file = path.join(dir, 'embedding-usage.json');
    fs.writeFileSync(file, 'CORRUPT_DIAGNOSTICS');
    const usage = new EmbeddingUsage(dir, 'model');
    const event = usage.start(1, 3);
    usage.finish(event, { state: 'succeeded', tokens: 4 });
    expect(usage.summary('all').error).toMatch(/preserved/);
    expect(fs.readFileSync(file, 'utf8')).toBe('CORRUPT_DIAGNOSTICS');
});
it('aggregates UTC periods without resetting all-time history or re-counting a completion', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'embedding-period-')); dirs.push(dir);
    try {
        vi.setSystemTime(new Date('2026-10-20T23:59:59Z'));
        const usage = new EmbeddingUsage(dir, 'model');
        const a = usage.start(3, 12, { reason: 'search' }); usage.finish(a, { state: 'succeeded', tokens: 10 });
        vi.setSystemTime(new Date('2026-10-21T00:00:01Z'));
        const b = usage.start(4, 16, { reason: 'watch' }); usage.finish(b, { state: 'succeeded', tokens: 20 });
        usage.finish(b, { state: 'succeeded', tokens: 20 });
        expect(usage.summary('today').totals).toMatchObject({ attempts: 1, tokens: 20, inputs: 4 });
        expect(usage.summary('today').reasons).not.toHaveProperty('search');
        expect(usage.summary('7d').totals.tokens).toBe(30);
        vi.setSystemTime(new Date('2026-10-28T00:00:01Z'));
        expect(usage.summary('7d').totals.attempts).toBe(0);
        expect(new EmbeddingUsage(dir, 'model').summary('all').totals).toMatchObject({ attempts: 2, tokens: 30, unfinished: 0 });
    } finally { vi.useRealTimers(); }
});
it('reports journal write failures without losing request counters', async () => {
    const { mkdirSync } = await import('node:fs');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'embedding-log-error-')); dirs.push(dir);
    const usage = new EmbeddingUsage(dir, 'model');
    mkdirSync(path.join(dir, 'embedding-requests.jsonl'));
    usage.setLogging(true);
    const request = usage.start(1, 4); usage.finish(request, { state: 'succeeded', tokens: 2 });
    await usage.close();
    expect(usage.summary('all')).toMatchObject({ error: 'Embedding request log could not be written.', logging: { dropped: 2 }, totals: { attempts: 1, tokens: 2 } });
});
