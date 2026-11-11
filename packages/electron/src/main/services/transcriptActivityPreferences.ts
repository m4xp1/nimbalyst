import { z } from 'zod';
import type { getSettingsService } from './SettingsService';

const overrideInput = z.object({
  sessionId: z.string().min(1).max(256).refine(id => !Object.hasOwn(Object.prototype, id) && id !== 'prototype'),
  turnKey: z.string().max(256).regex(/^(?:message|turn):.+$/),
  expanded: z.boolean(),
  completed: z.boolean(),
});

/** Patch only the selected turn against the latest snapshot in main. */
export function setTranscriptActivityOverride(service: ReturnType<typeof getSettingsService>, input: unknown): void {
  const { sessionId, turnKey, expanded, completed } = overrideInput.parse(input);
  const key = 'ai.turnActivityOverrides';
  const current = service.get(key) ?? {};
  service.set(key, {
    ...current,
    [sessionId]: { ...current[sessionId], [turnKey]: { expanded, completed } },
  });
}
