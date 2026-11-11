// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock('../../utils/privateSettingsStore', () => ({ default: class {
  get(key: string) { return state.data[key]; }
  set(key: string, value: unknown) { state.data[key] = value; }
} }));
import { usageHistoryStore as store } from '../UsageHistoryStore';
const now = Date.parse('2026-11-10T12:00:00Z');
const sample = (utilization: number) => ({ meter: 'codex:codex:secondary', label: 'Weekly', utilization, resetsAt: '2026-11-14T12:00:00Z' });
beforeEach(() => { state.data = {}; });
it('does not present account A history as account B history', () => {
  store.record('codex', [sample(90)], now, 'A');
  expect(store.record('codex', [], now, 'B')).toEqual([]);
});
it('restores each account history independently across repeated switches and service reload', async () => {
  store.record('codex', [sample(90)], now, 'A');
  store.record('codex', [sample(10)], now, 'B');
  vi.resetModules();
  const { usageHistoryStore: reloaded } = await import('../UsageHistoryStore');
  expect(reloaded.record('codex', [], now, 'A')).toMatchObject([{ utilization: 90 }]);
  expect(reloaded.record('codex', [], now, 'B')).toMatchObject([{ utilization: 10 }]);
});
it('does not assign legacy unbound Codex history to a newly known account', () => {
  store.record('codex', [sample(99)], now);
  expect(store.record('codex', [], now, 'A')).toEqual([]);
  expect(store.record('codex', [], now)).toEqual([]);
});
it('preserves the existing Claude history route', () => {
  store.record('claude', [{ ...sample(30), meter: 'claude:weekly' }], now);
  expect(store.record('claude', [], now)).toMatchObject([{ utilization: 30 }]);
});
