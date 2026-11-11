import { createHash } from 'node:crypto';
import Store from '../utils/privateSettingsStore';
import {
  recordUsageWeekSamples,
  type UsageWeekRecord,
  type UsageWeekSample,
} from '../../shared/usageHistory';

interface UsageHistoryFile {
  weeks: UsageWeekRecord[];
  codexAccounts?: Record<string, UsageWeekRecord[]>;
}

/**
 * Persists weekly usage-meter readings so past weeks survive restarts.
 * Kept forever; one small record per meter per week.
 */
class UsageHistoryStore {
  private store: Store<UsageHistoryFile> | null = null;

  // Lazy so the store is not created (app.getPath) at import time.
  private getStore(): Store<UsageHistoryFile> {
    if (!this.store) {
      this.store = new Store<UsageHistoryFile>({ name: 'usage-history', defaults: { weeks: [] } });
    }
    return this.store;
  }

  /** Records the samples and returns this provider's history (meters starting with `${provider}:`). */
  record(provider: 'claude' | 'codex', samples: UsageWeekSample[], now = Date.now(), accountScope?: string): UsageWeekRecord[] {
    // Legacy Codex rows have no proven owner. Keep them, but never assign them to a login.
    if (provider === 'codex' && !accountScope) return [];
    const accountKey = provider === 'codex' ? createHash('sha256').update(accountScope!).digest('hex') : null;
    const store = this.getStore();
    const storedAccounts = store.get('codexAccounts');
    const accounts = storedAccounts && typeof storedAccounts === 'object' && !Array.isArray(storedAccounts) ? storedAccounts : {};
    const stored = accountKey ? accounts[accountKey] : store.get('weeks');
    let weeks = Array.isArray(stored) ? stored : [];
    if (samples.length > 0) {
      weeks = recordUsageWeekSamples(weeks, samples, now);
      if (accountKey) store.set('codexAccounts', { ...accounts, [accountKey]: weeks });
      else store.set('weeks', weeks);
    }
    return weeks.filter(week => week.meter.startsWith(`${provider}:`));
  }
}

export const usageHistoryStore = new UsageHistoryStore();
