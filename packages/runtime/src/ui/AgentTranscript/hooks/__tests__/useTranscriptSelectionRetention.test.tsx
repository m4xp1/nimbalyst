// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useTranscriptSelectionRetention } from '../useTranscriptSelectionRetention';

afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); document.body.innerHTML = ''; });

it('retains the whole selected message span and releases it after an explicit deselection', () => {
  const root = document.createElement('section');
  root.innerHTML = '<p data-message-index="1">Assistant</p><p data-message-index="2">Tools</p><p data-message-index="3">User</p>';
  document.body.append(root);
  const ref = { current: root };
  const ids = ['before', 'assistant', 'tools', 'user', 'after'];
  const { result } = renderHook(() => useTranscriptSelectionRetention(ref, ids));
  act(() => {
    const range = document.createRange();
    range.setStart(root.firstChild!.firstChild!, 0);
    range.setEnd(root.lastChild!.firstChild!, 4);
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  expect(result.current).toEqual([1, 2, 3]);
  act(() => root.dispatchEvent(new Event('scroll')));
  expect(result.current).toEqual([1, 2, 3]);
  expect(window.getSelection()!.toString()).toBe('AssistantToolsUser');
  act(() => { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
  expect(result.current).toEqual([]);
});
