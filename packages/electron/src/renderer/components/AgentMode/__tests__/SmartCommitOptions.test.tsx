// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { SmartCommitOptions, useSmartCommitOptions } from '../SmartCommitOptions';

const models = [
  { id: 'openai-codex:gpt-6-luna', name: 'GPT-6 Luna', provider: 'openai-codex' },
  { id: 'openai-codex:gpt-6-astra', name: 'GPT-6 Astra', provider: 'openai-codex' },
];

function Controls() {
  const options = useSmartCommitOptions();
  return <SmartCommitOptions value={options.settings} models={models} onChange={options.update}
    disabled={options.isLoading} settingsError={options.settingsError} />;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('persists model, effort, and temporary mode across renderer restarts', async () => {
  let saved: unknown;
  const invoke = vi.fn(async (channel: string, _key: string, value?: unknown) => {
    if (channel === 'app-settings:get') return saved;
    if (channel === 'app-settings:set') saved = value;
    return undefined;
  });
  vi.stubGlobal('electronAPI', { invoke });
  const start = () => render(<Provider store={createStore()}><Controls /></Provider>);
  const first = start();
  const model = first.getByLabelText('Model') as HTMLSelectElement;
  await waitFor(() => expect(model.disabled).toBe(false));

  fireEvent.change(model, { target: { value: models[1].id } });
  fireEvent.change(first.getByLabelText('Effort'), { target: { value: 'low' } });
  fireEvent.click(first.getByLabelText('Run in a temporary Codex session'));
  await waitFor(() => expect(saved).toEqual({ model: models[1].id, effort: 'low', temporary: true }));
  first.unmount();

  const next = start();
  await waitFor(() => expect((next.getByLabelText('Model') as HTMLSelectElement).value).toBe(models[1].id));
  expect((next.getByLabelText('Effort') as HTMLSelectElement).value).toBe('low');
  expect((next.getByLabelText('Run in a temporary Codex session') as HTMLInputElement).checked).toBe(true);
});
