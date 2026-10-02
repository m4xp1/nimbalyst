import { describe, expect, it } from 'vitest';
import { createStore } from 'jotai';
import {
  codexUsageAtom,
  codexUsageIndicatorColorAtom,
  formatCodexWindowLabel,
  formatCodexWindowSubtitle,
  getCodexUsageWindows,
  getCodexIndicatorWindow,
  type CodexUsageData,
  type CodexUsageWindow,
} from '../codexUsageAtoms';

function window(
  slot: CodexUsageWindow['slot'],
  usedPercent: number,
  windowDurationMins: number | null
): CodexUsageWindow {
  return { slot, usedPercent, windowDurationMins, resetsAt: null };
}

describe('Codex usage window display', () => {
  it('labels a weekly primary window from its duration', () => {
    const weekly = window('primary', 36, 10_080);
    expect(formatCodexWindowLabel(weekly)).toBe('Weekly');
    expect(formatCodexWindowSubtitle(weekly)).toBe('7-day window');
  });

  it('prefers the 5-hour window over a more-used weekly window', () => {
    const usage: CodexUsageData = {
      limits: [
        {
          id: 'codex',
          name: null,
          planType: 'pro',
          windows: [window('primary', 18, 300), window('secondary', 62, 10_080)],
          credits: null,
          individualLimit: null,
          rateLimitReachedType: null,
        },
        {
          id: 'codex_bengalfox',
          name: 'GPT-5.3-Codex-Spark',
          planType: 'pro',
          windows: [window('primary', 4, 10_080)],
          credits: null,
          individualLimit: null,
          rateLimitReachedType: null,
        },
      ],
      lastUpdated: 0,
    };

    const selected = getCodexIndicatorWindow(usage);
    expect(selected?.limit.id).toBe('codex');
    expect(selected?.window.usedPercent).toBe(18);
    expect(formatCodexWindowLabel(selected!.window)).toBe('Session');
  });

  it('tolerates payloads without limits (older main process or cached pre-limits snapshot)', () => {
    const legacy = { lastUpdated: 1 } as CodexUsageData;
    expect(getCodexUsageWindows(legacy)).toEqual([]);
    expect(getCodexIndicatorWindow(legacy)).toBeNull();
  });

  it('tolerates limits without windows', () => {
    const partial = {
      lastUpdated: 1,
      limits: [{ id: 'a' }],
    } as unknown as CodexUsageData;
    expect(getCodexUsageWindows(partial)).toEqual([]);
  });
});

function usageWithWindows(windows: CodexUsageWindow[]): CodexUsageData {
  return {
    lastUpdated: 0,
    limits: [{ id: 'codex', name: null, planType: 'pro', windows,
      credits: null, individualLimit: null, rateLimitReachedType: null }],
  };
}

describe('Codex compact indicator window selection', () => {
  it('recognizes a 5-hour secondary slot when the primary slot is weekly', () => {
    const selected = getCodexIndicatorWindow(usageWithWindows([
      window('primary', 90, 10_080), window('secondary', 9, 300),
    ]));
    expect(selected?.window.slot).toBe('secondary');
    expect(selected?.window.usedPercent).toBe(9);
  });

  it('uses the most constrained 5-hour limit among multiple buckets', () => {
    const usage = usageWithWindows([window('primary', 9, 300), window('secondary', 99, 10_080)]);
    usage.limits.push({ ...usage.limits[0], id: 'other', windows: [window('secondary', 30, 300)] });
    expect(getCodexIndicatorWindow(usage)?.limit.id).toBe('other');
    expect(getCodexIndicatorWindow(usage)?.window.usedPercent).toBe(30);
  });

  it('falls back to the most constrained available limit when no 5-hour window exists', () => {
    const selected = getCodexIndicatorWindow(usageWithWindows([
      window('primary', 20, null), window('secondary', 60, 10_080),
    ]));
    expect(selected?.window.usedPercent).toBe(60);
    expect(formatCodexWindowLabel(selected!.window)).toBe('Weekly');
  });

  it('colors the ring from the 5-hour usage even when the weekly limit is nearly exhausted', () => {
    const store = createStore();
    store.set(codexUsageAtom, usageWithWindows([
      window('primary', 9, 300), window('secondary', 95, 10_080),
    ]));
    expect(store.get(codexUsageIndicatorColorAtom)).toBe('green');
  });
});
