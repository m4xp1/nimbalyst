import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { globalRegistry, loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { TypeTagsEditor } from '../TrackerTypeTagsEditor';

beforeAll(() => loadBuiltinTrackers());
afterEach(cleanup);

describe('tracker secondary types', () => {
  it('explains an empty chooser instead of only changing Add to Done', () => {
    const tags = globalRegistry.getListed().map(type => type.type);
    render(<TypeTagsEditor primaryType="task" typeTags={tags} onUpdate={() => {}} />);
    fireEvent.click(screen.getByText('+ Add'));
    expect(screen.getByText('No additional creatable types are available for this card.')).toBeTruthy();
  });

  it('adds/removes a secondary type through the write callback and keeps the primary type', async () => {
    const onUpdate = vi.fn();
    const candidate = globalRegistry.getListed().find(type => type.type !== 'task' && type.primaryCapable !== false && type.creatable !== false)!;
    function Harness() {
      const [tags, setTags] = useState(['task']);
      return <TypeTagsEditor primaryType="task" typeTags={tags} onUpdate={async next => { onUpdate(next); setTags(next); }} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByText('+ Add'));
    fireEvent.click(screen.getByText(`+ ${candidate.displayName}`));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(['task', candidate.type]));
    fireEvent.click(screen.getByLabelText(`Remove ${candidate.displayName} type`));
    await waitFor(() => expect(onUpdate).toHaveBeenLastCalledWith(['task']));
  });

  it('keeps the source error visible when the write fails', async () => {
    const candidate = globalRegistry.getListed().find(type => type.type !== 'task' && type.primaryCapable !== false && type.creatable !== false)!;
    const update = vi.fn().mockRejectedValue(new Error('File changed outside Nimbalyst'));
    render(<TypeTagsEditor primaryType="task" typeTags={['task']} onUpdate={update} />);
    fireEvent.click(screen.getByText('+ Add'));
    fireEvent.click(screen.getByText(`+ ${candidate.displayName}`));
    expect((await screen.findByRole('alert')).textContent).toContain('File changed outside Nimbalyst');
    expect(screen.queryByLabelText(`Remove ${candidate.displayName} type`)).toBeNull();
  });
});
