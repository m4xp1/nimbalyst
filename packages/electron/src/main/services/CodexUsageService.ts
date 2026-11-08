/**
 * CodexUsageService - Tracks OpenAI Codex usage limits
 *
 * This service:
 * - Reads current limits through the Codex app-server account API
 * - Reads native account identity afresh on each requested refresh
 * - Implements activity-aware polling (active when using Codex, sleeps when idle)
 * - Broadcasts usage updates to renderer via IPC
 *
 * Subscription limits are account-bound. Historical session logs cannot establish
 * current ownership and are never substituted for a failed account read.
 */

import { codexAccessAllowed, CODEX_ACCESS_DISABLED_MESSAGE } from '@nimbalyst/runtime/ai/codexAccessPolicy';
import { BrowserWindow } from 'electron';
import type {
  AccountRateLimitSnapshot,
  AccountRateLimitsReadResponse,
} from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/types';
import { logger } from '../utils/logger';
import { codexAuthService } from './CodexAuthService';

export interface CodexUsageWindow {
  slot: 'primary' | 'secondary';
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: string | null;
}

export interface CodexUsageLimit {
  id: string;
  name: string | null;
  planType: string | null;
  windows: CodexUsageWindow[];
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  individualLimit: {
    limit: string;
    used: string;
    remainingPercent: number;
    resetsAt: string;
  } | null;
  rateLimitReachedType: string | null;
}

export interface CodexUsageData {
  limits: CodexUsageLimit[];
  rateLimitResetCredits?: {
    availableCount: number;
    credits: Array<{
      id: string;
      title: string | null;
      description: string | null;
      expiresAt: string | null;
    }> | null;
  } | null;
  tokenUsage?: {
    totalTokens: number;
    lastTokens: number | null;
  };
  limitsAvailable?: boolean;
  source?: 'account' | 'session';
  lastUpdated: number; // Unix timestamp
  error?: string;
  refreshing?: boolean;
}

interface CodexRateLimits {
  limit_id?: string;
  primary?: {
    used_percent: number;
    window_minutes: number;
    resets_at: number; // Unix seconds
  } | null;
  secondary?: {
    used_percent: number;
    window_minutes: number;
    resets_at: number; // Unix seconds
  } | null;
  credits?: {
    has_credits: boolean;
    unlimited: boolean;
    balance: number | null;
  } | null;
}

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes before going to sleep

class CodexUsageServiceImpl {
  private cachedUsage: CodexUsageData | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastActivityTime: number = 0;
  private isPolling: boolean = false;
  private isSleeping: boolean = true;
  private unsubscribeRateLimits: (() => void) | null = null;
  private unsubscribeAccount: (() => void) | null = null;
  private refreshing: Promise<CodexUsageData> | null = null;
  private generation = 0;
  private lifecycle = 0;
  private accountScope: string | null | undefined;


  initialize(): void {
    if (!codexAccessAllowed()) return;
    this.unsubscribeRateLimits ??= codexAuthService.onRateLimitsUpdated(() => {
      void this.refresh().catch((error) => {
        logger.main.warn('[CodexUsageService] Failed to refresh after rate-limit update:', error);
      });
    });
    this.unsubscribeAccount ??= codexAuthService.onAccountUpdated(() => {
      this.generation++;
      this.accountScope = undefined;
      this.publishPending();
      void this.refresh();
    });
    logger.main.info('[CodexUsageService] Initialized (sleeping until activity detected)');
  }

  async recordActivity(): Promise<void> {
    if (!codexAccessAllowed()) return;
    this.lastActivityTime = Date.now();

    if (this.isSleeping) {
      // logger.main.info('[CodexUsageService] Waking up due to activity');
      this.isSleeping = false;
      this.startPolling();
    }

    // ai:sendMessage resolves after the turn finishes, so refresh the canonical
    // account snapshot now rather than waiting for the background poll.
    await this.refresh();
  }

  getCachedUsage(): CodexUsageData | null {
    if (!codexAccessAllowed()) return null;
    return this.cachedUsage;
  }

  refresh(): Promise<CodexUsageData> {
    if (!codexAccessAllowed()) {
      return Promise.resolve({ limits: [], limitsAvailable: false, lastUpdated: Date.now(), error: CODEX_ACCESS_DISABLED_MESSAGE });
    }
    if (this.refreshing) return this.refreshing;
    const pending = this.readCurrentUsage();
    this.refreshing = pending;
    void pending.finally(() => { if (this.refreshing === pending) this.refreshing = null; });
    return pending;
  }

  private publishPending(): void {
    this.cachedUsage = { limits: [], limitsAvailable: false, refreshing: true, lastUpdated: 0 };
    this.broadcastUpdate();
  }

  private async readCurrentUsage(): Promise<CodexUsageData> {
    const lifecycle = this.lifecycle;
    // Auth notifications can invalidate a reader while its HTTP quota request is pending.
    // All callers share this loop, so neither IPC replies nor broadcasts publish the old owner.
    for (;;) {
      const generation = this.generation;
      let usage: CodexUsageData;
      try {
        const response = await codexAuthService.getRateLimits(scope => {
          if (generation !== this.generation || lifecycle !== this.lifecycle) return;
          if (scope !== this.accountScope) {
            this.accountScope = scope;
            this.publishPending();
          }
        });
        if (!hasAccountRateLimits(response)) throw new Error('No account limits available');
        usage = convertAccountRateLimitsResponse(response);
      } catch {
        // Historical JSONL records cannot establish the current account/workspace.
        // Never display another owner's limits as a fallback after a native account error.
        usage = { limits: [], limitsAvailable: false, lastUpdated: 0,
          error: 'Current Codex account limits are unavailable. Check sign-in and refresh to try again.' };
      }
      if (lifecycle !== this.lifecycle) return { limits: [], limitsAvailable: false, lastUpdated: 0 };
      if (generation !== this.generation) continue;
      this.cachedUsage = usage;
      this.broadcastUpdate();
      return usage;
    }
  }

  stop(): void {
    this.stopPolling();
    this.unsubscribeRateLimits?.();
    this.unsubscribeRateLimits = null;
    this.unsubscribeAccount?.();
    this.unsubscribeAccount = null;
    this.generation++;
    this.lifecycle++;
    this.refreshing = null;
    this.accountScope = undefined;
    this.cachedUsage = null;
    this.isSleeping = true;
    logger.main.info('[CodexUsageService] Stopped');
  }

  private startPolling(): void {
    if (this.isPolling) return;

    this.isPolling = true;
    this.pollTimer = setInterval(() => {
      this.pollTick();
    }, POLL_INTERVAL_MS);

    // logger.main.info('[CodexUsageService] Started polling (every 5 minutes)');
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isPolling = false;
  }

  private async pollTick(): Promise<void> {
    const timeSinceActivity = Date.now() - this.lastActivityTime;
    if (timeSinceActivity > IDLE_TIMEOUT_MS) {
      logger.main.info('[CodexUsageService] Going to sleep due to inactivity');
      this.isSleeping = true;
      this.stopPolling();
      return;
    }

    await this.refresh();
  }

  private broadcastUpdate(): void {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send('codex-usage:update', this.cachedUsage);
      }
    }
  }
}

function hasAccountRateLimits(response: AccountRateLimitsReadResponse): boolean {
  return response.rateLimits !== null
    || Object.keys(response.rateLimitsByLimitId ?? {}).length > 0
    || (response.rateLimitResetCredits?.availableCount ?? 0) > 0;
}

function convertAccountWindow(
  slot: CodexUsageWindow['slot'],
  window: NonNullable<AccountRateLimitSnapshot['primary']>
): CodexUsageWindow {
  return {
    slot,
    usedPercent: window.usedPercent,
    windowDurationMins: window.windowDurationMins,
    resetsAt: typeof window.resetsAt === 'number'
      ? new Date(window.resetsAt * 1000).toISOString()
      : null,
  };
}

function convertAccountLimit(
  snapshot: AccountRateLimitSnapshot,
  fallbackId: string
): CodexUsageLimit {
  const windows: CodexUsageWindow[] = [];
  if (snapshot.primary) windows.push(convertAccountWindow('primary', snapshot.primary));
  if (snapshot.secondary) windows.push(convertAccountWindow('secondary', snapshot.secondary));

  return {
    id: snapshot.limitId ?? fallbackId,
    name: snapshot.limitName ?? null,
    planType: snapshot.planType ?? null,
    windows,
    credits: snapshot.credits,
    individualLimit: snapshot.individualLimit ? {
      limit: snapshot.individualLimit.limit,
      used: snapshot.individualLimit.used,
      remainingPercent: snapshot.individualLimit.remainingPercent,
      resetsAt: new Date(snapshot.individualLimit.resetsAt * 1000).toISOString(),
    } : null,
    rateLimitReachedType: snapshot.rateLimitReachedType ?? null,
  };
}

export function convertAccountRateLimitsResponse(
  response: AccountRateLimitsReadResponse
): CodexUsageData {
  const limits: CodexUsageLimit[] = [];
  const seenIds = new Set<string>();

  if (response.rateLimits) {
    const limit = convertAccountLimit(response.rateLimits, 'codex');
    limits.push(limit);
    seenIds.add(limit.id);
  }

  for (const [id, snapshot] of Object.entries(response.rateLimitsByLimitId ?? {})) {
    const effectiveId = snapshot.limitId ?? id;
    if (seenIds.has(effectiveId)) continue;
    limits.push(convertAccountLimit(snapshot, id));
    seenIds.add(effectiveId);
  }

  return {
    limits,
    rateLimitResetCredits: response.rateLimitResetCredits ? {
      availableCount: response.rateLimitResetCredits.availableCount,
      credits: response.rateLimitResetCredits.credits?.map((credit) => ({
        id: credit.id,
        title: credit.title,
        description: credit.description,
        expiresAt: typeof credit.expiresAt === 'number'
          ? new Date(credit.expiresAt * 1000).toISOString()
          : null,
      })) ?? null,
    } : null,
    limitsAvailable: limits.some((limit) => limit.windows.length > 0),
    source: 'account',
    lastUpdated: Date.now(),
  };
}

export const codexUsageService = new CodexUsageServiceImpl();

/**
 * Drop expired buckets from a CodexRateLimits block.
 *
   * Each primary/secondary slot carries its own `resets_at` Unix-seconds timestamp.
   * Slot position does not identify its duration. After the reset moment the historical `used_percent`
 * no longer matches reality - but the JSONL session file that produced the line is
 * never rewritten, so the same stale value keeps coming back from the
 * scan-backward loop in `extractUsageSnapshotFromFile`. That is the bug behind
 * #120: indicator sat at 91% indefinitely after the 5-hour window reset and the
 * user's real usage was 0%.
 *
 * Returns null when both windows are absent or expired so the caller can keep
 * scanning older lines for a still-active block. If nothing is active anywhere,
 * the higher-level snapshot falls through to `limitsAvailable: false` and the
 * renderer shows `--` rather than a stale percentage.
 *
 * Exported for unit-testing. Production callers pass `Date.now() / 1000`.
 */
export function filterRateLimitsByExpiry(
  rateLimits: CodexRateLimits,
  nowSeconds: number
): CodexRateLimits | null {
  const primary = rateLimits.primary ?? null;
  const secondary = rateLimits.secondary ?? null;

  const primaryActive =
    primary !== null &&
    (typeof primary.resets_at !== 'number' || primary.resets_at > nowSeconds);
  const secondaryActive =
    secondary !== null &&
    (typeof secondary.resets_at !== 'number' || secondary.resets_at > nowSeconds);

  if (!primaryActive && !secondaryActive) return null;

  return {
    ...rateLimits,
    primary: primaryActive ? primary : null,
    secondary: secondaryActive ? secondary : null,
  };
}

// Exported only for tests. Do not consume from production code.
export type { CodexRateLimits };
