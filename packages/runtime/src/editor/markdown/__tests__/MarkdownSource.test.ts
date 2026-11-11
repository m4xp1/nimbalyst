// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { diffChars } from 'diff';
import { MarkdownSourceBudgetError, preserveMarkdownBody, preserveMarkdownSource } from '../MarkdownSource';

vi.mock('diff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('diff')>();
  return { ...actual, diffChars: vi.fn(actual.diffChars) };
});

describe('Markdown source edit mapping', () => {
  it.each([
    ['_text_', '*text*', 'text', 'text'],
    // A changed normalized marker must be replaced as a unit, not spliced
    // into the original underscore representation to produce invalid nesting.
    ['_text_', '*text*', '***text***', '***text***'],
    ['**text**', '**text**', 'text', 'text'],
    ['a    b', 'a b', 'a c', 'a    c'],
    ['a\r\nb\r\n', 'a\nb\n', 'a\nb\nc\n', 'a\r\nb\r\nc\r\n'],
    ['a\r\nb\r\nc', 'a\nb\nc', 'a\nc', 'a\r\nc'],
    ['a\n\n', 'a', '', '\n\n'],
    ['', '', 'new', 'new'],
  ])('maps %j through %j to %j', (raw, baseline, next, expected) => {
    expect(preserveMarkdownBody(raw, baseline, next)).toBe(expected);
  });

  it('updates only the changed YAML key, retaining dates, comments and body', () => {
    const raw = '---\n# note\nupdated: 2026-11-07\ntitle: "Old"\n---\n\nBody.\n';
    const normalized = '---\nupdated: 2026-11-07T00:00:00.000Z\ntitle: Old\n---\nBody.';
    const output = preserveMarkdownSource(raw, normalized, normalized.replace('title: Old', 'title: New'));
    expect(output).toBe(raw.replace('"Old"', '"New"'));
  });

  it('preserves malformed frontmatter on a body-only edit', () => {
    const raw = '---\nkey: bad: yaml\n---\nBody';
    const baseline = '---\nkey: "bad: yaml"\n---\nBody';
    expect(preserveMarkdownSource(raw, baseline, baseline.replace('Body', 'Changed'))).toBe(raw.replace('Body', 'Changed'));
  });

  it('offers a recoverable source draft without normalizing unchanged frontmatter', () => {
    const header = '---\n# keep this comment\nupdated: 2026-11-07\n---\n';
    const raw = header + '\n| A | B |\n|---|---|\n| Old | _value_ |\n';
    const baseline = '---\nupdated: 2026-11-07T00:00:00.000Z\n---\n| A | B |\n| --- | --- |\n| Old | *value* |';
    const current = baseline.replace('Old', 'Unsaved');
    const diffWithBudget: (before: string, after: string, options: { timeout: number }) =>
      ReturnType<typeof diffChars> | undefined = diffChars;
    vi.mocked(diffWithBudget).mockReturnValueOnce(undefined);

    expect(() => preserveMarkdownSource(raw, baseline, current)).toThrow(
      expect.objectContaining({
        name: MarkdownSourceBudgetError.name,
        sourceDraft: header + '| A | B |\n| --- | --- |\n| Unsaved | *value* |',
      }),
    );
  });
});
