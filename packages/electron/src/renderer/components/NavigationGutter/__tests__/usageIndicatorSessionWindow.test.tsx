// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { codexUsageAtom } from '../../../store/atoms/codexUsageAtoms';
import { claudeUsageAtom } from '../../../store/atoms/claudeUsageAtoms';
import { geminiUsageAtom } from '../../../store/atoms/geminiUsageAtoms';

vi.mock('../../CodexUsageIndicator/CodexUsagePopover', () => ({ CodexUsagePopover: () => null }));
vi.mock('../../ClaudeUsageIndicator/ClaudeUsagePopover', () => ({ ClaudeUsagePopover: () => null }));
vi.mock('../../GeminiUsageIndicator/GeminiUsagePopover', () => ({ GeminiUsagePopover: () => null }));
vi.mock('../../../store/listeners/codexUsageListeners', () => ({ refreshCodexUsage: vi.fn() }));
vi.mock('../../../store/listeners/claudeUsageListeners', () => ({ refreshClaudeUsage: vi.fn() }));
vi.mock('../../../store/listeners/geminiUsageListeners', () => ({ refreshGeminiUsage: vi.fn() }));

import { CodexUsageIndicator } from '../../CodexUsageIndicator/CodexUsageIndicator';
import { ClaudeUsageIndicator } from '../../ClaudeUsageIndicator/ClaudeUsageIndicator';
import { GeminiUsageIndicator } from '../../GeminiUsageIndicator/GeminiUsageIndicator';

afterEach(cleanup);

it('Codex shows the 5-hour percent, tooltip and ring color when weekly usage is higher', () => {
  const store = createStore();
  store.set(codexUsageAtom, {
    limits: [{ id: 'codex', name: null, planType: 'pro',
      windows: [
        { slot: 'primary', usedPercent: 9, windowDurationMins: 300, resetsAt: null },
        { slot: 'secondary', usedPercent: 95, windowDurationMins: 10_080, resetsAt: null },
      ], credits: null, individualLimit: null, rateLimitReachedType: null }],
    lastUpdated: Date.now(),
  });
  const { getByTestId } = render(<Provider store={store}><CodexUsageIndicator /></Provider>);
  const button = getByTestId('codex-usage-indicator');
  expect(button.textContent).toBe('9%');
  expect(button.title).toContain('Session');
  expect(button.title).not.toContain('Weekly');
  expect(button.querySelector('circle:last-of-type')?.getAttribute('class')).toBe('stroke-green-500');
});

it('Claude keeps showing the 5-hour percent rather than the weekly percent', () => {
  const store = createStore();
  store.set(claudeUsageAtom, {
    fiveHour: { utilization: 9, resetsAt: null },
    sevenDay: { utilization: 95, resetsAt: null },
    lastUpdated: Date.now(),
  });
  const { getByTestId } = render(<Provider store={store}><ClaudeUsageIndicator /></Provider>);
  expect(getByTestId('claude-usage-indicator').textContent).toBe('9%');
});

it('Gemini keeps showing the primary model quota provided by its backend', () => {
  const store = createStore();
  store.set(geminiUsageAtom, {
    fiveHour: { utilization: 17, resetsAt: null },
    sevenDay: { utilization: 9, resetsAt: null },
    limitsAvailable: true, available: true, lastUpdated: Date.now(),
  });
  const { getByTestId } = render(<Provider store={store}><GeminiUsageIndicator /></Provider>);
  expect(getByTestId('gemini-usage-indicator').textContent).toBe('17%');
});
