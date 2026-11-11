// @vitest-environment jsdom
import React, { useState } from 'react';
import { File as NodeFile } from 'node:buffer';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIInput } from '../AIInput';
import { DEFAULT_DICTATION_SETTINGS } from '../../../../shared/dictation';
import { dictationSettingsAtom } from '../../../store/atoms/dictation';
import { getDictationTarget } from '../../../dictation/dictationTargets';
import { getDictationController } from '../../../dictation/dictationController';

vi.mock('../AIInputControls', () => ({ AIInputControls: () => null }));
vi.mock('../../../help', () => ({ HelpTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(save?: Promise<unknown>) {
  let resolveClipboard!: (image: { mimeType: string; data: Uint8Array } | null) => void;
  const clipboard = new Promise<{ mimeType: string; data: Uint8Array } | null>(resolve => { resolveClipboard = resolve; });
  const onAttachmentAdd = vi.fn();
  const onSend = vi.fn();
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'attachment:validate') return { valid: true };
    if (channel === 'attachment:save') return save ?? { success: true, attachment: { id: 'pasted' } };
    return {};
  });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    readWindowsClipboardImage: vi.fn(() => clipboard), invoke,
  } });
  // jsdom's File does not implement arrayBuffer.
  vi.stubGlobal('File', NodeFile);
  function Harness({ sessionId = 'clipboard-test' }: { sessionId?: string }) {
    const [value, setValue] = useState('original');
    return <AIInput value={value} onChange={setValue} onSend={onSend}
      sessionId={sessionId} remoteSession onAttachmentAdd={onAttachmentAdd} />;
  }
  const store = createStore();
  const view = render(<Provider store={store}><Harness /></Provider>);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.paste(input, { clipboardData: { items: [], files: [], getData: () => '' } });
  return { input, onAttachmentAdd, onSend, invoke, resolveClipboard, unmount: view.unmount,
    switchSession: () => view.rerender(<Provider store={store}><Harness sessionId="other-session" /></Provider>),
  };
}

describe('Windows clipboard image paste', () => {
  it('cancels an image read when the paste is undone before the clipboard responds', async () => {
    const { input, onAttachmentAdd, invoke, resolveClipboard } = setup();
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    await act(async () => { resolveClipboard({ mimeType: 'image/png', data: new Uint8Array(8) }); });
    expect(onAttachmentAdd).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('attachment:save', expect.anything());
    expect(input.value).toBe('original');
  });

  it('preserves edits made while waiting and blocks sending until the image is attached', async () => {
    const { input, onAttachmentAdd, onSend, resolveClipboard } = setup();
    fireEvent.change(input, { target: { value: 'edited while waiting' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => { resolveClipboard({ mimeType: 'image/png', data: new Uint8Array(8) }); });
    expect(onAttachmentAdd).toHaveBeenCalledTimes(1);
    expect(input.value).toMatch(/^edited while waiting @pasted-image-.*\.png $/);
  });

  it('releases the pending state when the clipboard has no image', async () => {
    const { input, onSend, resolveClipboard } = setup();
    await act(async () => { resolveClipboard(null); });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('original');
  });

  it.each(['switchSession', 'unmount'] as const)('discards the clipboard result after %s', async action => {
    const result = setup();
    result[action]();
    await act(async () => { result.resolveClipboard({ mimeType: 'image/png', data: new Uint8Array(8) }); });
    expect(result.onAttachmentAdd).not.toHaveBeenCalled();
    expect(result.invoke).not.toHaveBeenCalledWith('attachment:save', expect.anything());
  });

  it('preserves edits made during attachment storage as well as the clipboard read', async () => {
    let finishSave!: (result: unknown) => void;
    const save = new Promise(resolve => { finishSave = resolve; });
    const { input, resolveClipboard, onAttachmentAdd } = setup(save);
    await act(async () => { resolveClipboard({ mimeType: 'image/png', data: new Uint8Array(8) }); });
    fireEvent.change(input, { target: { value: 'edited during save' } });
    await act(async () => { finishSave({ success: true, attachment: { id: 'pasted' } }); });
    expect(onAttachmentAdd).toHaveBeenCalledTimes(1);
    expect(input.value).toMatch(/^edited during save @pasted-image-.*\.png $/);
  });
});

describe('sending follow-ups to an active turn', () => {
  function renderFollowUp(isSteering = false, supported = true) {
    const handlers = { onQueue: vi.fn(), onSteer: vi.fn(), onCancel: vi.fn(), onSend: vi.fn() };
    const store = createStore();
    render(<Provider store={store}>
      <AIInput value="Clarify the requirements" onChange={vi.fn()} sessionId="follow-up-test"
        remoteSession isLoading isSteering={isSteering} {...handlers}
        onSteer={supported ? handlers.onSteer : undefined} />
    </Provider>);
    return handlers;
  }

  it('routes queueing, steering and stopping to different commands', () => {
    const handlers = renderFollowUp();
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
    expect(handlers.onQueue).toHaveBeenCalledExactlyOnceWith('Clarify the requirements');
    expect(handlers.onSteer).not.toHaveBeenCalled();
    expect(handlers.onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    expect(handlers.onSteer).toHaveBeenCalledTimes(1);
    expect(handlers.onQueue).toHaveBeenCalledTimes(1);
    expect(handlers.onCancel).not.toHaveBeenCalled();
    expect(handlers.onSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch a second copy from either keyboard shortcut while steering', () => {
    const handlers = renderFollowUp(true);
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, shiftKey: true });
    expect(handlers.onQueue).not.toHaveBeenCalled();
    expect(handlers.onSend).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send now' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel request' }).disabled).toBe(false);
  });

  it('does not offer steering when the active transport does not support it', () => {
    const handlers = renderFollowUp(false, false);
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
    expect(handlers.onQueue).toHaveBeenCalledExactlyOnceWith('Clarify the requirements');
  });
});

describe('dictation in the agent input', () => {
  function renderInput(enabled: boolean) {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke: vi.fn(async () => ({})) } });
    const onSend = vi.fn();
    function Harness() {
      const [value, setValue] = useState('fix the bug');
      return <AIInput value={value} onChange={setValue} onSend={onSend} sessionId="dictation-test" remoteSession />;
    }
    const store = createStore();
    store.set(dictationSettingsAtom, { ...DEFAULT_DICTATION_SETTINGS, enabled });
    render(<Provider store={store}><Harness /></Provider>);
    return { input: screen.getByRole('textbox') as HTMLTextAreaElement, onSend };
  }

  it('renders no mic button when dictation is disabled in Settings', () => {
    renderInput(false);
    expect(screen.queryByTestId('dictation-button')).toBeNull();
    cleanup();
    renderInput(true);
    expect(screen.getAllByTestId('dictation-button')).toHaveLength(1);
  });

  it('writes partials and finals into the draft at the caret without sending', () => {
    const { input, onSend } = renderInput(true);
    input.focus();
    input.setSelectionRange(7, 7);
    const target = getDictationTarget('agent-input:dictation-test')!;
    act(() => target.showPartial!('log'));
    expect(input.value).toBe('fix the log bug');
    act(() => target.commitFinal('login'));
    expect(input.value).toBe('fix the login bug');
    act(() => target.showPartial!('discard'));
    act(() => target.clearPartial());
    expect(input.value).toBe('fix the login bug');
    expect(onSend).not.toHaveBeenCalled();
    // The committed phrase is one undo step.
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    expect(input.value).toBe('fix the bug');
  });

  it('stops dictation on send and sends the visible text, partial included', () => {
    const { input, onSend } = renderInput(true);
    input.focus();
    input.setSelectionRange(11, 11);
    const controller = getDictationController();
    vi.spyOn(controller, 'isRecording').mockImplementation((key) => key === 'agent-input:dictation-test');
    const stop = vi.spyOn(controller, 'stop').mockImplementation(() => {
      // The real stop(true) clears the pending partial through the target.
      getDictationTarget('agent-input:dictation-test')!.clearPartial();
    });
    const target = getDictationTarget('agent-input:dictation-test')!;
    act(() => target.showPartial!('now'));
    expect(input.value).toBe('fix the bug now');

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(stop).toHaveBeenCalledWith(true);
    expect(onSend).toHaveBeenCalledWith('fix the bug now');
    // Stopping must not strip the partial out of the text that was just sent.
    expect(input.value).toBe('fix the bug now');
    vi.restoreAllMocks();
  });
});
