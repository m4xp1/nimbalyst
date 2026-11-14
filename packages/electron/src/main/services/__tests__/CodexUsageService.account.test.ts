// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ getRateLimits: vi.fn(), rate: null as null | (() => void), account: null as null | (() => void), send: vi.fn(), readFile: vi.fn(), history: vi.fn() }));
vi.mock('fs/promises', () => ({ readFile: f.readFile }));
vi.mock('../CodexAuthService', () => ({ codexAuthService: {
  getRateLimits: f.getRateLimits,
  onRateLimitsUpdated: (fn: () => void) => { f.rate = fn; return () => { f.rate = null; }; },
  onAccountUpdated: (fn: () => void) => { f.account = fn; return () => { f.account = null; }; },
  workspaceAuth: () => ({ revision: 1 }),
} }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: f.send } }] } }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } } }));
vi.mock('../UsageHistoryStore', () => ({ usageHistoryStore: { record: f.history } }));
import { codexUsageService as service } from '../CodexUsageService';
function snapshot(scope: string, percent: number) { return { accountScope: scope, rateLimits: { limitId: 'codex', primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: null, credits: null, individualLimit: null, planType: 'pro', rateLimitReachedType: null }, rateLimitsByLimitId: null, rateLimitResetCredits: null }; }
function reply(scope: string, percent: number) { f.getRateLimits.mockImplementation(async (identified?: (s: string | null) => void) => { identified?.(scope); return snapshot(scope, percent); }); }
beforeEach(() => { vi.stubEnv('NIMBALYST_ALLOW_CODEX_ACCESS', '1'); f.getRateLimits.mockReset(); f.history.mockReset().mockReturnValue([]); f.send.mockClear(); service.initialize(); });
afterEach(() => { service.stop(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('updates during a long backend turn without an open popover, then stops idle polling', async () => {
  vi.useFakeTimers();
  reply('A', 10);
  const finish = (service as any).beginTurn();
  await service.refresh();
  reply('A', 20);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(service.getCachedUsage()?.limits[0].windows[0].usedPercent).toBe(20);
  finish();
  await service.refresh();
  const reads = f.getRateLimits.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(f.getRateLimits).toHaveBeenCalledTimes(reads);
});

it('coalesces native limit events and ignores events from a previous workspace revision', async () => {
  vi.useFakeTimers();
  reply('A', 10);
  await service.refresh();
  f.getRateLimits.mockClear();
  (service as any).nativeLimitsUpdated(0);
  expect(f.getRateLimits).not.toHaveBeenCalled();
  reply('A', 12);
  for (let i = 0; i < 20; i++) (service as any).nativeLimitsUpdated(1);
  await service.refresh();
  expect(f.getRateLimits).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  reply('A', 15);
  (service as any).nativeLimitsUpdated(1);
  await service.refresh();
  expect(service.getCachedUsage()?.limits[0].windows[0].usedPercent).toBe(15);
});
describe('account-bound Codex usage refresh', () => {
  it('clears the old workspace before new limits arrive, including the same-email switch', async () => {
    reply('same-user/work', 100); await service.refresh();
    let complete!: (v: any) => void;
    f.getRateLimits.mockImplementation((identified?: (s: string) => void) => { identified?.('same-user/personal'); return new Promise(r => { complete = r; }); });
    const pending = service.refresh();
    await vi.waitFor(() => expect(service.getCachedUsage()).toMatchObject({ limits: [], refreshing: true }));
    complete(snapshot('same-user/personal', 12));
    expect((await pending).limits[0].windows[0].usedPercent).toBe(12);
  });
  it('coalesces overlapping refreshes without duplicate native account readers', async () => {
    let complete!: (v: any) => void;
    f.getRateLimits.mockImplementation((identified?: (s: string) => void) => { identified?.('A'); return new Promise(r => { complete = r; }); });
    const a = service.refresh(), b = service.refresh();
    await vi.waitFor(() => expect(f.getRateLimits).toHaveBeenCalledTimes(1));
    complete(snapshot('A', 13));
    expect(await a).toEqual(await b);
  });
  it('does not replace a current snapshot with unbound historical session limits after failure', async () => {
    reply('A', 99); await service.refresh();
    f.readFile.mockClear();
    f.getRateLimits.mockRejectedValue(new Error('synthetic quota failure'));
    expect(await service.refresh()).toMatchObject({ limits: [], limitsAvailable: false, error: expect.any(String) });
    expect(f.readFile).not.toHaveBeenCalled();
  });
  it('discards an in-flight old-account response after an auth notification and returns the new snapshot', async () => {
    let complete!: (v: any) => void;
    f.getRateLimits.mockImplementationOnce((identified?: (s: string) => void) => { identified?.('A'); return new Promise(r => { complete = r; }); });
    const pending = service.refresh();
    await vi.waitFor(() => expect(f.getRateLimits).toHaveBeenCalledOnce());
    reply('B', 8);
    expect(f.account).toBeTypeOf('function'); f.account!();
    complete(snapshot('A', 100));
    expect((await pending).limits[0].windows[0].usedPercent).toBe(8);
    expect(f.send.mock.calls.some(([,v]) => v.limits?.[0]?.windows?.[0]?.usedPercent === 100)).toBe(false);
    expect(f.history.mock.calls.map(call => call[3])).toEqual(['B']);
  });
  it('does not publish or launch another reader after shutdown during a pending refresh', async () => {
    let complete!: (v: any) => void;
    f.getRateLimits.mockImplementation(() => new Promise(r => { complete = r; }));
    const pending = service.refresh(); service.stop(); f.send.mockClear();
    complete(snapshot('A', 100)); await pending;
    expect(f.send).not.toHaveBeenCalled();
    expect(f.getRateLimits).toHaveBeenCalledOnce();
    expect(service.getCachedUsage()).toBeNull();
  });
  it('tracks repeated work/personal switches in either direction', async () => {
    for (const [scope, percent] of [['user/work', 100], ['user/personal', 5], ['user/work', 80]] as const) {
      reply(scope, percent);
      expect((await service.refresh()).limits[0].windows[0].usedPercent).toBe(percent);
    }
    expect(f.getRateLimits).toHaveBeenCalledTimes(3);
  });
  it('keeps the same-account snapshot while the requested refresh is pending', async () => {
    reply('A', 19); await service.refresh();
    let complete!: (v: any) => void;
    f.getRateLimits.mockImplementation((identified?: (s: string) => void) => { identified?.('A'); return new Promise(r => { complete = r; }); });
    const pending = service.refresh();
    expect(service.getCachedUsage()?.limits[0].windows[0].usedPercent).toBe(19);
    complete(snapshot('A', 21)); await pending;
  });
});

it('includes the known account history in refresh replies and hides it after a failed read', async () => {
  reply('A', 50);
  const weekly = [{ meter: 'codex:codex:secondary', label: 'Weekly', utilization: 50, resetsAt: '2033-05-18T03:33:20Z', lastSeenAt: 1 }];
  f.history.mockReturnValue(weekly);
  expect((await service.refresh()).weeklyHistory).toEqual(weekly);
  expect(f.history).toHaveBeenLastCalledWith('codex', expect.any(Array), expect.any(Number), 'A');
  f.getRateLimits.mockRejectedValue(new Error('synthetic missing auth'));
  expect((await service.refresh()).weeklyHistory).toEqual([]);
  expect(f.history).toHaveBeenCalledOnce();
});
