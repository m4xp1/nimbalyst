// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ensurePortablePlanReview } from '../metaAgentPortablePlan';

function fixture() {
  const items = new Map<string, any>();
  const service = {
    getTrackerItemById: vi.fn(async (id: string) => items.get(id) ?? null),
    listTrackerItems: vi.fn(async () => [...items.values()]),
    createTrackerItem: vi.fn(async (draft: any) => {
      const card = { ...draft, id: `local:${draft.id}`, source: 'frontmatter', sourceRef: `docs/reviews/${draft.id}.md`, customFields: { trackerFormat: 1, portableId: draft.id } };
      items.set(draft.id, card); return card;
    }),
    updateTrackerItem: vi.fn(async (id: string, fields: any) => ({ id, ...fields })),
  };
  const prompt = { promptId: 'permission-1', content: { planFilePath: 'plans/original plan.md', allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] } };
  return { service, items, prompt };
}

describe('portable plan review from meta agent', () => {
  it('creates one storage-aware review, links the original plan without copying its content and retries by stable ID', async () => {
    const { service, prompt } = fixture();
    await ensurePortablePlanReview('/project', 'child-1', 'Investigate', prompt, 'docs/reviews', service as any);
    await ensurePortablePlanReview('/project', 'child-1', 'Renamed session', prompt, 'docs/reviews', service as any);
    expect(service.createTrackerItem).toHaveBeenCalledTimes(1);
    const draft = service.createTrackerItem.mock.calls[0]![0];
    expect(draft).toMatchObject({ type: 'plan', status: 'in-review', title: 'Plan review: Investigate' });
    expect(draft.id).toMatch(/^plan-review-[a-f0-9]{32}$/);
    expect(draft.content).toContain('../../plans/original%20plan.md');
    expect(JSON.stringify(draft)).not.toContain('allowedPrompts');
    expect(JSON.stringify(draft)).not.toContain('child-1');
    expect(service.updateTrackerItem).toHaveBeenCalledWith(`local:${draft.id}`, { metaAgent: expect.objectContaining({ childSessionId: 'child-1', promptId: 'permission-1', allowedPrompts: prompt.content.allowedPrompts }) });
  });
  it('reuses a file that is already a tracker without creating or rewriting another card', async () => {
    const { service, items, prompt } = fixture();
    items.set('legacy', { id: 'legacy', type: 'plan', source: 'frontmatter', sourceRef: 'plans/original plan.md' });
    await ensurePortablePlanReview('/project', 'child-1', 'Investigate', prompt, undefined, service as any);
    expect(service.createTrackerItem).not.toHaveBeenCalled();
    expect(service.updateTrackerItem).toHaveBeenCalledWith('legacy', { metaAgent: expect.any(Object) });
  });
  it('keeps outside-workspace paths local instead of writing a nonportable link', async () => {
    const { service, prompt } = fixture(); prompt.content.planFilePath = '../private/original.md';
    await ensurePortablePlanReview('/project', 'child-1', 'Investigate', prompt, 'docs/reviews', service as any);
    const draft = service.createTrackerItem.mock.calls[0]![0];
    expect(draft.content).not.toContain('private');
    expect(service.updateTrackerItem.mock.calls[0]![1].metaAgent.planFilePath).toBe('../private/original.md');
  });
  it('does not create a card without a configured plan directory', async () => {
    const { service, prompt } = fixture();
    await expect(ensurePortablePlanReview('/project', 'child-1', 'Investigate', prompt, undefined, service as any)).rejects.toThrow('Configure a directory');
    expect(service.createTrackerItem).not.toHaveBeenCalled();
    expect(service.updateTrackerItem).not.toHaveBeenCalled();
  });
  it('propagates file creation failure without changing local state or falling back to DB', async () => {
    const { service, prompt } = fixture(); service.createTrackerItem.mockRejectedValueOnce(new Error('Directory is not configured'));
    await expect(ensurePortablePlanReview('/project', 'child-1', 'Investigate', prompt, 'docs/reviews', service as any)).rejects.toThrow('Directory is not configured');
    expect(service.updateTrackerItem).not.toHaveBeenCalled();
  });
});
