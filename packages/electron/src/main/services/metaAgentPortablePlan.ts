import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { ElectronDocumentService } from './ElectronDocumentService';

type PlanService = Pick<ElectronDocumentService, 'getTrackerItemById' | 'listTrackerItems' | 'createTrackerItem' | 'updateTrackerItem'>;
interface PlanPrompt { promptId: string; content: Record<string, any> }

/** Files-mode plan review. The generated plan itself is never imported or rewritten. */
export async function ensurePortablePlanReview(
  workspace: string, sessionId: string, title: string, prompt: PlanPrompt,
  directory: string | undefined, service: PlanService,
): Promise<void> {
  const id = `plan-review-${createHash('sha256').update(`${sessionId}\0${prompt.promptId}`).digest('hex').slice(0, 32)}`;
  const original = typeof prompt.content.planFilePath === 'string' ? prompt.content.planFilePath : null;
  const candidate = original ? path.relative(workspace, path.resolve(workspace, original)) : null;
  const relative = candidate && !path.isAbsolute(candidate) && candidate !== '..' && !candidate.startsWith(`..${path.sep}`)
    ? candidate.split(path.sep).join('/') : null;
  let item = await service.getTrackerItemById(id);
  if (item && item.customFields?.portableId !== id) throw new Error('Plan review ID belongs to another tracker item');
  if (!item && relative) {
    item = (await service.listTrackerItems()).find(card =>
      (card.source === 'frontmatter' || card.source === 'import')
      && card.sourceRef?.replace(/\\/g, '/') === relative) ?? null;
  }
  if (!item) {
    if (!directory) throw new Error("Configure a directory for tracker type 'plan' before creating a file card");
    const link = relative ? path.posix.relative(directory, relative).split('/').map(encodeURIComponent).join('/') : null;
    item = await service.createTrackerItem({
      id, creationRequestId: id, workspace, type: 'plan', title: `Plan review: ${title}`,
      status: 'in-review', priority: 'medium', tags: ['meta-agent', 'plan-review'],
      description: 'Review the pending implementation plan.',
      content: `# Plan review\n\nReview the pending implementation plan.${link ? `\n\n[Open original plan](<${link}>)` : ''}\n`,
    });
  }
  // Local interactive prompt state is deliberately excluded from Markdown.
  await service.updateTrackerItem(item.id, { metaAgent: {
    childSessionId: sessionId, promptId: prompt.promptId,
    sourceRef: `meta-agent-plan:${sessionId}:${prompt.promptId}`,
    planFilePath: original, allowedPrompts: prompt.content.allowedPrompts ?? [],
  } });
}
