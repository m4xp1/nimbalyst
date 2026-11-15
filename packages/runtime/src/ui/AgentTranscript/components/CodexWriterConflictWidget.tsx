import React from 'react';
import { atom, useAtom, useAtomValue } from 'jotai';
import { atomFamily } from 'jotai-family';
import { interactiveWidgetHostAtom } from '../../../store/atoms/interactiveWidgetHost';

const recoveryAtom = atomFamily((_key: string) => atom<{
  pending: boolean; result?: { success: boolean; error?: string };
}>({ pending: false }));

export function CodexWriterConflictWidget({ detail, sessionId, messageId, isLastMessage }: {
  detail: string; sessionId: string; messageId: number; isLastMessage: boolean;
}) {
  const host = useAtomValue(interactiveWidgetHostAtom(sessionId));
  const [state, setState] = useAtom(recoveryAtom(`${sessionId}:${messageId}`));
  const recover = async () => {
    if (state.pending || !host?.resolveCodexWriter) return;
    setState({ pending: true });
    try {
      setState({ pending: false, result: await host.resolveCodexWriter() });
    } catch (error) {
      setState({ pending: false, result: { success: false, error: error instanceof Error ? error.message : String(error) } });
    }
  };
  return <div className="my-4 rounded-lg border border-[var(--nim-error)] bg-[var(--nim-error-bg)] p-4">
    <div className="whitespace-pre-wrap text-sm font-semibold text-nim-error">{detail}</div>
    {isLastMessage && host?.resolveCodexWriter && <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" onClick={recover} disabled={state.pending}
        className="rounded border border-nim bg-nim px-3 py-1.5 text-sm text-nim disabled:opacity-50">
        {state.pending ? 'Resolving…' : 'Try resolve'}
      </button>
      <span role="status" className="text-sm text-nim">
        {state.result?.success ? 'Connection restored. Send your message again.' : state.result?.error}
      </span>
    </div>}
  </div>;
}
