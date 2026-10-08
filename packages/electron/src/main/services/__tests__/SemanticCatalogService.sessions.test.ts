// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  setting: false, states: new Map<string, { status: string }>(),
  listeners: [] as Array<(handle: any) => void>, records: new Map<string, Map<string, any>>(),
  request: vi.fn(), sessions: vi.fn(), messages: vi.fn(), setSetting: vi.fn(),
}));
vi.mock('../../extensions/PrivilegedExtensionHost', () => ({
  getPrivilegedExtensionHost: () => ({
    list: () => [...h.states].map(([workspacePath, state]) => ({
      extensionId: 'com.nimbalyst.memory', moduleId: 'memory-engine', workspacePath, state,
    })),
    getState: (_e: string, _m: string, ws: string) => h.states.get(ws),
    onStateChanged: (fn: any) => { h.listeners.push(fn); return () => {}; },
    request: h.request,
  }),
}));
vi.mock('../../window/WindowManager', () => ({ documentServices: new Map() }));
vi.mock('../../utils/store', () => ({
  getAppSetting: () => h.setting,
  setAppSetting: (key: string, value: boolean) => { h.setting = value; h.setSetting(key, value); },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { list: h.sessions },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { list: h.messages },
}));
import { SemanticCatalogService } from '../SemanticCatalogService';
function records(ws: string) {
  if (!h.records.has(ws)) h.records.set(ws, new Map());
  return h.records.get(ws)!;
}
function event(ws: string, status: 'running' | 'stopped') {
  h.states.set(ws, { status });
  for (const fn of h.listeners) fn({
    extensionId: 'com.nimbalyst.memory', moduleId: 'memory-engine', workspacePath: ws, state: { status },
  });
}
function rpc(args: any) {
  const rows = records(args.workspacePath);
  if (args.method === 'clearSessionRecords') {
    for (const [key, row] of rows) if (row.refType === 'session') rows.delete(key);
    return Promise.resolve({ removed: 1 });
  }
  if (args.method === 'ingestRecords') {
    for (const row of args.params.records) rows.set(row.id, row);
    return Promise.resolve({ ingested: args.params.records.length });
  }
  return Promise.resolve({ ready: true, chunks: rows.size, indexing: false });
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
async function startOff(ws = '/project') {
  const service = new SemanticCatalogService(); service.start(); event(ws, 'running');
  await vi.waitFor(() => expect(h.request.mock.calls.some(([a]) =>
    a.method === 'clearSessionRecords' && a.workspacePath === ws)).toBe(true));
  return service;
}
beforeEach(() => {
  vi.clearAllMocks(); h.setting = false; h.states.clear(); h.records.clear(); h.listeners.length = 0;
  h.sessions.mockResolvedValue([{ id: 's1', title: 'sessionmarker', isArchived: false }]);
  h.messages.mockResolvedValue([]);
  h.request.mockImplementation(rpc);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });
describe('session index reconciliation', () => {
  it('purges stale sessions at startup without a document service, preserving other records', async () => {
    records('/project').set('orphan', { refType: 'session' });
    records('/project').set('tracker', { refType: 'tracker' });
    await startOff();
    await vi.waitFor(() => expect([...records('/project').keys()]).toEqual(['tracker']));
    expect(h.sessions).not.toHaveBeenCalled();
  });
  it('enables and disables all saved sessions without consulting the main DB on clear', async () => {
    const service = await startOff();
    await service.setSessionsEnabled(true);
    expect(records('/project').has('session:s1')).toBe(true);
    records('/project').set('session:deleted-from-db', { refType: 'session' });
    const before = h.sessions.mock.calls.length;
    await service.setSessionsEnabled(false);
    expect(records('/project').size).toBe(0);
    expect(h.sessions.mock.calls.length).toBe(before);
    expect(h.setSetting).toHaveBeenLastCalledWith('memoryIndexSessions', false);
    expect(service.isAvailable('/project')).toBe(false);
  });
  it('waits for an in-flight ingest then clears its late writes', async () => {
    const service = await startOff(); const gate = deferred();
    h.request.mockImplementation(async (args: any) => {
      if (args.method === 'ingestRecords') await gate.promise;
      return rpc(args);
    });
    const enable = service.setSessionsEnabled(true);
    await vi.waitFor(() => expect(h.request.mock.calls.some(([a]) => a.method === 'ingestRecords')).toBe(true));
    let done = false;
    const disable = service.setSessionsEnabled(false).then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false);
    gate.resolve(); await Promise.all([enable, disable]);
    expect(records('/project').size).toBe(0);
    const methods = h.request.mock.calls.map(([a]) => a.method);
    expect(methods.lastIndexOf('clearSessionRecords')).toBeGreaterThan(methods.lastIndexOf('ingestRecords'));
  });
  it('cancels a record being built and rapid toggles end in the latest state', async () => {
    const service = await startOff(); const gate = deferred();
    h.messages.mockImplementation(async () => { await gate.promise; return []; });
    const first = service.setSessionsEnabled(true);
    await vi.waitFor(() => expect(h.messages).toHaveBeenCalled());
    const off = service.setSessionsEnabled(false);
    const on = service.setSessionsEnabled(true);
    const last = service.setSessionsEnabled(false);
    gate.resolve(); await Promise.all([first, off, on, last]);
    expect(h.request.mock.calls.some(([a]) => a.method === 'ingestRecords')).toBe(false);
    expect(h.setting).toBe(false); expect(records('/project').size).toBe(0);
  });
  it('reconciles multiple running workspaces and propagates clear errors while attempting all', async () => {
    const service = await startOff('/one'); event('/two', 'running');
    await vi.waitFor(() => expect(h.request.mock.calls.some(([a]) => a.workspacePath === '/two' && a.method === 'clearSessionRecords')).toBe(true));
    await service.setSessionsEnabled(true);
    expect(records('/one').size).toBe(1); expect(records('/two').size).toBe(1);
    h.request.mockImplementation((args: any) => {
      if (args.workspacePath === '/one' && args.method === 'clearSessionRecords') return Promise.reject(new Error('write denied'));
      return rpc(args);
    });
    await expect(service.setSessionsEnabled(false)).rejects.toThrow('Could not update session indexing');
    expect(records('/two').size).toBe(0); expect(h.setting).toBe(false);
    expect(service.sessionIndexingError()).toContain('could not be reconciled');
    h.request.mockImplementation(rpc);
    await service.setSessionsEnabled(false); expect(records('/one').size).toBe(0);
    expect(service.sessionIndexingError()).toBeNull();
  });
  it('cleans persisted sessions when a stopped engine starts again with the option off', async () => {
    const service = await startOff();
    await service.setSessionsEnabled(true); event('/project', 'stopped');
    await service.setSessionsEnabled(false);
    expect(records('/project').size).toBe(1); // Backend is stopped: reconcile on next start.
    event('/project', 'running');
    await vi.waitFor(() => expect(records('/project').size).toBe(0));
  });
});
