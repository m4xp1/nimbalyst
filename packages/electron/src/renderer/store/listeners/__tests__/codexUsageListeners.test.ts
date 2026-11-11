// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('../../index', () => ({ store: { set: f.set } }));
import { initCodexUsageListeners, refreshCodexUsage } from '../codexUsageListeners';
afterEach(() => { vi.unstubAllGlobals(); f.set.mockClear(); });
it('does not overwrite a new account broadcast with an older startup IPC reply', async () => {
  let resolve!: (v: any) => void;
  const on = vi.fn(() => vi.fn());
  vi.stubGlobal('window', { electronAPI: { on, invoke: () => new Promise(r => { resolve = r; }) } });
  const stop = initCodexUsageListeners();
  const latest = { limits: [], error: 'New account pending', lastUpdated: 0 };
  (on.mock.calls[0] as any)[1](latest);
  resolve({ limits: [], lastUpdated: 123 }); await Promise.resolve(); await Promise.resolve();
  expect(f.set.mock.calls.map(([,v]) => v)).toEqual([latest]);
  stop();
});
it('ignores a startup reply after its listeners have been disposed', async () => {
  let resolve!: (v: any) => void;
  const off = vi.fn();
  vi.stubGlobal('window', { electronAPI: { on: vi.fn(() => off), invoke: () => new Promise(r => { resolve = r; }) } });
  const stop = initCodexUsageListeners(); stop();
  resolve({ limits: [], lastUpdated: 123 }); await Promise.resolve(); await Promise.resolve();
  expect(f.set).not.toHaveBeenCalled(); expect(off).toHaveBeenCalledTimes(2);
});

it('applies a manual quota reply even when the host has no broadcast for an early return', async () => {
  const data = { limits: [], lastUpdated: 0, error: 'Account access disabled' };
  vi.stubGlobal('window', { electronAPI: { invoke: vi.fn(async () => data) } });
  expect(await refreshCodexUsage()).toEqual(data);
  expect(f.set.mock.calls.map(([,v]) => v)).toEqual([data]);
});
it('never replaces a new account broadcast with a late manual reply', async () => {
  let resolve!: (v: any) => void;
  const on = vi.fn(() => vi.fn());
  vi.stubGlobal('window', { electronAPI: { on, invoke: vi.fn().mockResolvedValueOnce(null).mockImplementationOnce(() => new Promise(r => { resolve = r; })) } });
  const stop = initCodexUsageListeners(); await Promise.resolve();
  const pending = refreshCodexUsage(); const latest = { limits: [], refreshing: true, lastUpdated: 0 };
  (on.mock.calls[0] as any)[1](latest); resolve({ limits: [], lastUpdated: 123 }); await pending;
  expect(f.set.mock.calls.map(([,v]) => v)).toEqual([latest]); stop();
});
