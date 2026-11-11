import type { TranscriptViewMessage } from '../../../ai/server/types';
import { isAnswerResumePrompt } from '../../../ai/server/interactivePromptTools';
import { formatDuration } from '../../../utils/dateUtils';
import type { TranscriptRowInfo } from '../components/TranscriptMessageRow';
import { isInteractiveWidgetTool } from '../../../ai/server/interactivePromptTools';

export interface ActivityExpandedOverride { expanded: boolean; completed: boolean }
export interface TranscriptActivityPart {
  key: string;
  completed: boolean;
  running: boolean;
  /** The final answer stays visible; only its tools and thinking belong here. */
  answer: boolean;
  header: boolean;
  duration: string;
}

/** Keep original VList/message indices: a collapsed turn hides content, not rows.
 * Native turn IDs join steering prompts to the same activity. Older histories
 * use persisted user-message IDs, never the ephemeral projection generation.
 */
export function buildTranscriptActivity(
  messages: readonly TranscriptViewMessage[],
  rowInfos: readonly TranscriptRowInfo[],
  processing: boolean,
  previous?: readonly (TranscriptActivityPart | undefined)[],
): (TranscriptActivityPart | undefined)[] {
  const groups: { key: string; indices: number[]; turnId?: string }[] = [];
  const native = new Map<string, typeof groups[number]>();
  let current: typeof groups[number] | undefined;
  messages.forEach((message, index) => {
    const known = message.turnId ? native.get(message.turnId) : undefined;
    const startsTurn = message.type === 'user_message' && !message.metadata?.isTeammateMessage && !isAnswerResumePrompt(message);
    if (known) current = known;
    else if (startsTurn || !current || (message.turnId && current.turnId && message.turnId !== current.turnId)) {
      current = { key: `message:${message.id}`, indices: [] };
      groups.push(current);
    }
    if (message.turnId) {
      current.turnId = message.turnId;
      native.set(message.turnId, current);
    }
    current.indices.push(index);
  });
  const parts: (TranscriptActivityPart | undefined)[] = new Array(messages.length);
  groups.forEach((group, groupIndex) => {
    const rows = group.indices.map(index => messages[index]);
    const boundary = rows.findLast(message => message.turnEnd)?.turnEnd;
    const explicitFinal = group.indices.findLast(index => messages[index].assistantPhase === 'final' && !!messages[index].text?.trim());
    const hasPending = rows.some(message => message.toolCall && isInteractiveWidgetTool(message.toolCall.toolName) && !message.toolCall.result);
    const settled = explicitFinal !== undefined || !!boundary || ((!processing || groupIndex < groups.length - 1) && !hasPending);
    // Legacy providers have no phase; after completion their last substantive
    // assistant response is the answer. Explicit commentary is never promoted.
    const finalIndex = explicitFinal ?? (settled && boundary?.status !== 'failed' && boundary?.status !== 'interrupted'
      ? group.indices.findLast(index => {
        const message = messages[index];
        return message.type === 'assistant_message' && !!message.text?.trim() && !message.isError && !message.progressUpdate && message.assistantPhase !== 'commentary';
      }) : undefined);
    const completed = finalIndex !== undefined;
    const running = processing && groupIndex === groups.length - 1 && !boundary && explicitFinal === undefined;
    const start = rows[0]?.createdAt?.getTime() ?? 0;
    const end = rows.at(-1)?.createdAt?.getTime() ?? start;
    const duration = settled ? formatDuration(start, end) : '';
    let header = true;
    for (const index of group.indices) {
      const message = messages[index];
      const info = rowInfos[index];
      if (!info || info.kind === 'hidden') continue;
      const answer = index === finalIndex || !!message.isError;
      const hasTools = info.toolEntries?.some(entry => !isInteractiveWidgetTool(entry.message.toolCall?.toolName));
      const hasThinking = !!message.thinking?.trim();
      const hasActivity = hasTools || (message.type === 'assistant_message' && !message.isError && (hasThinking || (!answer && !!message.text?.trim())));
      if (!hasActivity || (info.kind !== 'message' && info.kind !== 'orphanTool')) continue;
      const part: TranscriptActivityPart = { key: group.key, completed, running, answer, header, duration };
      const old = previous?.[index];
      parts[index] = old && Object.keys(part).every(key => old[key as keyof TranscriptActivityPart] === part[key as keyof TranscriptActivityPart]) ? old : part;
      header = false;
    }
  });
  return parts;
}

export function isActivityExpanded(part: TranscriptActivityPart, override?: ActivityExpandedOverride): boolean {
  // A live manual choice must not prevent the one-time close at completion.
  return override?.completed === part.completed ? override.expanded : !part.completed;
}
